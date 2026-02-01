import { Router, Response } from 'express';
import { join } from 'path';
import {
  createDeployment,
  getDeployment,
  updateDeployment,
  listDeployments,
  getRepository,
  canDeploy,
} from '../../db/schema.js';
import {
  authMiddleware,
  optionalAuthMiddleware,
  hasRepoAccess,
  AuthenticatedRequest,
} from '../middleware/auth.js';
import { track } from '../../analytics/posthog.js';
import { deploy as deployToProvider } from '../../deploy/engine.js';
import { getRepositoriesPath } from '../../git/soft-serve.js';

const router = Router();

/**
 * POST /api/repos/:name/deploy - Trigger a deployment
 */
router.post('/repos/:name/deploy', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name } = req.params;
  const { target = 'railway', commit_sha } = req.body;

  // Validate target platform
  const validTargets = ['railway', 'fly', 'coolify'];
  if (!validTargets.includes(target)) {
    res.status(400).json({
      error: `Invalid deployment target. Must be one of: ${validTargets.join(', ')}`,
    });
    return;
  }

  try {
    const repo = await getRepository(name);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    // Need write access to deploy
    if (!(await hasRepoAccess(req.agentId, repo.id, 'write'))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Check deployment limits based on plan
    const deployCheck = await canDeploy(req.agentId!);
    if (!deployCheck.allowed) {
      res.status(429).json({
        error: 'Deployment limit exceeded',
        message: deployCheck.reason,
        upgrade_url: '/app/billing',
      });
      return;
    }

    // Use provided commit or default to HEAD
    const sha = commit_sha || 'HEAD';

    const deployment = await createDeployment(repo.id, sha, target, req.agentId!);

    // Track deployment creation
    track(req.agentId!, 'deployment_created', {
      deployment_id: deployment.id,
      repo_id: repo.id,
      target,
    });

    // Return immediately, then run deployment async
    res.status(201).json(deployment);

    // Trigger actual deployment in background
    const repoPath = join(getRepositoriesPath(), name);

    (async () => {
      try {
        await updateDeployment(deployment.id, { status: 'building' });

        const deployResult = await deployToProvider({
          repoPath,
          commitSha: sha,
          provider: target as 'railway' | 'fly',
          appName: name,
        });

        await updateDeployment(deployment.id, {
          status: deployResult.success ? 'success' : 'failed',
          url: deployResult.url || null,
          subdomain: deployResult.customDomain || null,
          logs: deployResult.logs.join('\n'),
          completed_at: new Date().toISOString(),
        });
      } catch (err) {
        await updateDeployment(deployment.id, {
          status: 'failed',
          logs: `Deployment error: ${err instanceof Error ? err.message : 'Unknown error'}`,
          completed_at: new Date().toISOString(),
        });
      }
    })();
  } catch (error) {
    res.status(500).json({ error: 'Failed to create deployment' });
  }
});

/**
 * GET /api/deployments - List all deployments
 */
router.get('/deployments', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { repo_id, status, limit = '50' } = req.query;

  try {
    let deployments = await listDeployments(repo_id as string | undefined);

    // Filter by status if provided
    if (status) {
      deployments = deployments.filter((d) => d.status === status);
    }

    // Apply limit
    const limitNum = Math.min(parseInt(limit as string, 10) || 50, 100);
    deployments = deployments.slice(0, limitNum);

    res.json(deployments);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list deployments' });
  }
});

/**
 * GET /api/deployments/:id - Get deployment status
 */
router.get('/deployments/:id', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const deployment = await getDeployment(id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    // Check if user can view this deployment (via repo access)
    const repo = await getRepository(deployment.repo_id);
    // If repo doesn't exist (orphaned deployment), treat as private
    if (!repo) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    if (repo.is_private && !(await hasRepoAccess(req.agentId, repo.id, 'read'))) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    res.json(deployment);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get deployment' });
  }
});

/**
 * POST /api/deployments/:id/cancel - Cancel a pending/running deployment
 */
router.post('/deployments/:id/cancel', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const deployment = await getDeployment(id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    // Check write access
    if (!(await hasRepoAccess(req.agentId, deployment.repo_id, 'write'))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Can only cancel pending or in-progress deployments
    if (!['pending', 'building', 'deploying'].includes(deployment.status)) {
      res.status(400).json({ error: 'Deployment cannot be cancelled' });
      return;
    }

    const updated = await updateDeployment(id, {
      status: 'failed',
      logs: (deployment.logs || '') + '\n[CANCELLED] Deployment cancelled by user',
      completed_at: new Date().toISOString(),
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Failed to cancel deployment' });
  }
});

/**
 * POST /api/deployments/:id/retry - Retry a failed deployment
 */
router.post('/deployments/:id/retry', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const deployment = await getDeployment(id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    // Check write access
    if (!(await hasRepoAccess(req.agentId, deployment.repo_id, 'write'))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Can only retry failed deployments
    if (deployment.status !== 'failed') {
      res.status(400).json({ error: 'Only failed deployments can be retried' });
      return;
    }

    // Create a new deployment with the same parameters
    const newDeployment = await createDeployment(
      deployment.repo_id,
      deployment.commit_sha,
      deployment.target,
      req.agentId!
    );

    res.status(201).json(newDeployment);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retry deployment' });
  }
});

/**
 * GET /api/deployments/:id/logs - Stream deployment logs
 */
router.get('/deployments/:id/logs', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  try {
    const deployment = await getDeployment(id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    // Check read access
    const repo = await getRepository(deployment.repo_id);
    // If repo doesn't exist (orphaned deployment), treat as private
    if (!repo) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    if (repo.is_private && !(await hasRepoAccess(req.agentId, repo.id, 'read'))) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    res.json({
      deployment_id: deployment.id,
      status: deployment.status,
      logs: deployment.logs || '',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get deployment logs' });
  }
});

/**
 * Internal endpoint to update deployment status (used by deployment workers)
 * PATCH /api/deployments/:id (internal use)
 */
router.patch('/deployments/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { status, url, subdomain, logs, completed_at } = req.body;

  try {
    const deployment = await getDeployment(id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }

    // Check admin access (for internal updates)
    if (!(await hasRepoAccess(req.agentId, deployment.repo_id, 'admin'))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const updates: Record<string, any> = {};
    if (status !== undefined) updates.status = status;
    if (url !== undefined) updates.url = url;
    if (subdomain !== undefined) updates.subdomain = subdomain;
    if (logs !== undefined) updates.logs = logs;
    if (completed_at !== undefined) updates.completed_at = completed_at;

    const updated = await updateDeployment(id, updates);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update deployment' });
  }
});

export default router;
