import { Router, Response, Request, NextFunction } from 'express';
import { createWriteStream, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename, normalize, relative } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { execa } from 'execa';
import {
  createRepository,
  getRepository,
  listRepositories,
  Repository,
  createDeployment,
  updateDeployment,
  canCreateRepo,
  canDeploy,
  deleteRepository,
  updateRepository,
  getRepoAccessList,
  grantRepoAccess,
  revokeRepoAccess,
  dbExecute,
} from '../../db/schema.js';
import { deploy as deployToProvider } from '../../deploy/engine.js';
import {
  authMiddleware,
  optionalAuthMiddleware,
  hasRepoAccess,
  AuthenticatedRequest,
} from '../middleware/auth.js';
import { getRepositoriesPath } from '../../git/soft-serve.js';
import { track } from '../../analytics/posthog.js';

// Upload configuration
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB
const ALLOWED_CONTENT_TYPES = [
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-tgz',
  'application/octet-stream', // Often used as fallback
];

// Dangerous path patterns to block
const DANGEROUS_PATTERNS = [
  /\.\./,           // Parent directory traversal
  /^\/|^\\/,        // Absolute paths
  /^~\//,           // Home directory
  /\0/,             // Null bytes
];

// Validate extracted file path for security
function isPathSafe(filePath: string): boolean {
  const normalizedPath = normalize(filePath);
  return !DANGEROUS_PATTERNS.some(pattern => pattern.test(normalizedPath));
}

const router = Router();

/**
 * POST /api/repos - Create a new repository
 */
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name, description } = req.body;

  if (!name) {
    res.status(400).json({ error: 'Repository name is required' });
    return;
  }

  // Validate repo name format
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    res.status(400).json({
      error: 'Invalid repository name. Use only letters, numbers, hyphens, and underscores.',
    });
    return;
  }

  try {
    // Check if repo already exists
    const existing = await getRepository(name);
    if (existing) {
      res.status(409).json({ error: 'Repository already exists' });
      return;
    }

    const repo = createRepository(name, req.agentId!, description);

    // Track repo creation
    track(req.agentId!, 'repo_created', { repo_id: repo.id, repo_name: name });

    res.status(201).json(repo);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create repository' });
  }
});

/**
 * GET /api/repos - List repositories
 */
router.get('/', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const repos = await listRepositories(req.agentId);
    res.json(repos);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list repositories' });
  }
});

/**
 * GET /api/repos/:name - Get repository details
 */
router.get('/:name', optionalAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name } = req.params;

  try {
    const repo = await getRepository(name);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    // Check access for private repos
    if (repo.is_private && !(await hasRepoAccess(req.agentId, repo.id, 'read'))) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    res.json(repo);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get repository' });
  }
});

/**
 * DELETE /api/repos/:name - Delete repository and undeploy from Railway
 */
router.delete('/:name', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name } = req.params;
  const { undeploy } = req.query; // ?undeploy=true to also remove Railway service

  try {
    const repo = await getRepository(name);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    // Only owner or admin can delete
    if (!(await hasRepoAccess(req.agentId, repo.id, 'admin'))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    // Undeploy from Railway if requested
    let undeployResult = null;
    if (undeploy === 'true') {
      try {
        const projectId = process.env.RAILWAY_PROJECT_ID;
        const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;

        if (projectId && token) {
          // Delete the Railway service via API
          const response = await fetch('https://backboard.railway.app/graphql/v2', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
              query: `
                mutation ServiceDelete($id: String!, $projectId: String!) {
                  serviceDelete(id: $id, projectId: $projectId)
                }
              `,
              variables: {
                id: name, // Service name
                projectId,
              },
            }),
          });

          const data = await response.json() as any;
          undeployResult = data.errors ? { error: data.errors[0]?.message } : { success: true };
        }
      } catch (err) {
        undeployResult = { error: err instanceof Error ? err.message : 'Undeploy failed' };
      }
    }

    // Delete repository and all related records
    await deleteRepository(repo.id);

    res.status(200).json({
      deleted: true,
      repository: name,
      undeploy: undeployResult
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete repository' });
  }
});

/**
 * PATCH /api/repos/:name - Update repository
 */
router.patch('/:name', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name } = req.params;
  const { description, is_private, default_branch } = req.body;

  try {
    const repo = await getRepository(name);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    if (!(await hasRepoAccess(req.agentId, repo.id, 'admin'))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const updates: any = {};
    if (description !== undefined) updates.description = description;
    if (is_private !== undefined) updates.is_private = is_private;
    if (default_branch !== undefined) updates.default_branch = default_branch;

    const updated = await updateRepository(repo.id, updates);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update repository' });
  }
});

/**
 * GET /api/repos/:name/access - List repository access permissions
 */
router.get('/:name/access', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name } = req.params;

  try {
    const repo = await getRepository(name);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    if (!(await hasRepoAccess(req.agentId, repo.id, 'admin'))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const access = await getRepoAccessList(repo.id);
    res.json(access);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get access list' });
  }
});

/**
 * POST /api/repos/:name/access - Grant repository access
 */
router.post('/:name/access', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name } = req.params;
  const { agent_id, permission } = req.body;

  if (!agent_id || !permission) {
    res.status(400).json({ error: 'agent_id and permission are required' });
    return;
  }

  if (!['read', 'write', 'admin'].includes(permission)) {
    res.status(400).json({ error: 'Invalid permission level' });
    return;
  }

  try {
    const repo = await getRepository(name);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    if (!(await hasRepoAccess(req.agentId, repo.id, 'admin'))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    const result = await grantRepoAccess(repo.id, agent_id, permission);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to grant access' });
  }
});

/**
 * DELETE /api/repos/:name/access/:agentId - Revoke repository access
 */
router.delete('/:name/access/:agentId', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name, agentId } = req.params;

  try {
    const repo = await getRepository(name);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    if (!(await hasRepoAccess(req.agentId, repo.id, 'admin'))) {
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    await revokeRepoAccess(repo.id, agentId);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

/**
 * POST /api/repos/:name/upload - Upload code as tarball or zip (agent-friendly alternative to git push)
 *
 * Accepts: application/zip, application/x-tar, application/gzip (tar.gz)
 * Max size: 100MB
 * Query params:
 *   - deploy: 'true' to trigger deployment after upload (optional)
 *   - target: deployment target if deploy=true (railway, fly, coolify)
 *   - message: commit message (optional, defaults to "Code uploaded via API")
 */
router.post(
  '/:name/upload',
  authMiddleware,
  // Raw body parser for binary upload
  (req: Request, res: Response, next: NextFunction) => {
    const contentType = req.headers['content-type'] || '';
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);

    // Validate content type
    const isAllowedType = ALLOWED_CONTENT_TYPES.some(type => contentType.includes(type));
    if (!isAllowedType && !contentType.includes('tar') && !contentType.includes('zip') && !contentType.includes('gzip')) {
      res.status(415).json({
        error: 'Unsupported media type. Use application/zip, application/x-tar, or application/gzip (tar.gz)',
      });
      return;
    }

    // Check content length upfront
    if (contentLength > MAX_UPLOAD_SIZE) {
      res.status(413).json({
        error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`,
      });
      return;
    }

    // Collect the raw body
    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    req.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_UPLOAD_SIZE) {
        req.destroy();
        res.status(413).json({
          error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`,
        });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      (req as any).rawBody = Buffer.concat(chunks);
      next();
    });

    req.on('error', (err) => {
      res.status(500).json({ error: 'Upload failed: ' + err.message });
    });
  },
  async (req: AuthenticatedRequest, res: Response) => {
    const { name } = req.params;
    const { deploy, target = 'railway', message = 'Code uploaded via API' } = req.query;
    const contentType = req.headers['content-type'] || '';

    let tempDir: string | null = null;
    let workDir: string | null = null;

    try {
      // Get repository
      const repo = await getRepository(name);
      if (!repo) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      // Check write access
      if (!(await hasRepoAccess(req.agentId, repo.id, 'write'))) {
        res.status(403).json({ error: 'Permission denied' });
        return;
      }

      const rawBody = (req as any).rawBody as Buffer;
      if (!rawBody || rawBody.length === 0) {
        res.status(400).json({ error: 'No file content received' });
        return;
      }

      // Create temporary directories
      tempDir = join(tmpdir(), `gitclaw-upload-${randomUUID()}`);
      workDir = join(tmpdir(), `gitclaw-work-${randomUUID()}`);
      mkdirSync(tempDir, { recursive: true });
      mkdirSync(workDir, { recursive: true });

      // Determine archive type and save file
      // Check content type more explicitly to avoid false matches
      let archiveFile: string;
      let extractCmd: string[];

      // Check for gzip/tgz FIRST (before zip check, since 'gzip' doesn't contain 'zip')
      if (contentType.includes('gzip') || contentType.includes('tgz') || contentType.includes('x-tar')) {
        archiveFile = join(tempDir, 'upload.tar.gz');
        extractCmd = ['tar', '-xzf', archiveFile, '-C', workDir];
      } else if (contentType.includes('zip') && !contentType.includes('gzip')) {
        archiveFile = join(tempDir, 'upload.zip');
        extractCmd = ['unzip', '-o', archiveFile, '-d', workDir];
      } else if (contentType.includes('tar')) {
        archiveFile = join(tempDir, 'upload.tar');
        extractCmd = ['tar', '-xf', archiveFile, '-C', workDir];
      } else {
        // Default to tar.gz for octet-stream and unknown types
        archiveFile = join(tempDir, 'upload.tar.gz');
        extractCmd = ['tar', '-xzf', archiveFile, '-C', workDir];
      }

      // Write archive to temp file
      const writeStream = createWriteStream(archiveFile);
      await pipeline(
        (async function* () {
          yield rawBody;
        })(),
        writeStream
      );

      // Extract archive
      try {
        await execa(extractCmd[0], extractCmd.slice(1));
      } catch (extractError: any) {
        res.status(400).json({
          error: 'Failed to extract archive. Ensure it is a valid tar, tar.gz, or zip file.',
          details: extractError.stderr || extractError.message,
        });
        return;
      }

      // Find the actual content directory (handle single top-level directory case)
      const entries = readdirSync(workDir);
      let sourceDir = workDir;
      if (entries.length === 1) {
        const singleEntry = join(workDir, entries[0]);
        if (statSync(singleEntry).isDirectory()) {
          sourceDir = singleEntry;
        }
      }

      // Validate extracted files for security
      const allFiles = await getAllFiles(sourceDir);
      for (const file of allFiles) {
        const relativePath = relative(sourceDir, file);
        if (!isPathSafe(relativePath)) {
          res.status(400).json({
            error: 'Security violation: archive contains dangerous path patterns',
            path: relativePath,
          });
          return;
        }
      }

      // Get or create the bare repository path
      const reposPath = getRepositoriesPath();
      const bareRepoPath = join(reposPath, `${name}.git`);

      if (!existsSync(bareRepoPath)) {
        // Create bare repository if it doesn't exist
        mkdirSync(bareRepoPath, { recursive: true });
        await execa('git', ['init', '--bare', bareRepoPath]);
      }

      // Create a temporary clone to work with
      const cloneDir = join(tmpdir(), `gitclaw-clone-${randomUUID()}`);
      mkdirSync(cloneDir, { recursive: true });

      try {
        // Clone the bare repo (or init if empty)
        try {
          await execa('git', ['clone', bareRepoPath, cloneDir]);
        } catch {
          // If clone fails (empty repo), just init
          await execa('git', ['init', cloneDir]);
          await execa('git', ['-C', cloneDir, 'remote', 'add', 'origin', bareRepoPath]);
        }

        // Remove old files (except .git)
        const cloneEntries = readdirSync(cloneDir);
        for (const entry of cloneEntries) {
          if (entry !== '.git') {
            rmSync(join(cloneDir, entry), { recursive: true, force: true });
          }
        }

        // Copy extracted files to clone
        await execa('cp', ['-r', ...readdirSync(sourceDir).map(f => join(sourceDir, f)), cloneDir]);

        // Configure git user for the commit
        await execa('git', ['-C', cloneDir, 'config', 'user.email', 'gitclaw@moltlab.local']);
        await execa('git', ['-C', cloneDir, 'config', 'user.name', 'GitClaw API']);

        // Add all files and commit
        await execa('git', ['-C', cloneDir, 'add', '-A']);

        // Check if there are changes to commit
        const { stdout: diffOutput } = await execa('git', ['-C', cloneDir, 'diff', '--cached', '--name-only']);
        const hasChanges = diffOutput.trim().length > 0;

        let commitSha = 'HEAD';
        if (hasChanges) {
          await execa('git', ['-C', cloneDir, 'commit', '-m', message as string]);
          const { stdout } = await execa('git', ['-C', cloneDir, 'rev-parse', 'HEAD']);
          commitSha = stdout.trim();

          // Push to bare repo
          await execa('git', ['-C', cloneDir, 'push', '-u', 'origin', 'HEAD:main', '--force']);
        } else {
          // Get current HEAD if no changes
          try {
            const { stdout } = await execa('git', ['-C', cloneDir, 'rev-parse', 'HEAD']);
            commitSha = stdout.trim();
          } catch {
            commitSha = 'initial';
          }
        }

        // Update repository last_push_at
        const now = new Date().toISOString();
        await dbExecute(
          'UPDATE repositories SET last_push_at = ?, updated_at = ? WHERE id = ?',
          [now, now, repo.id]
        );

        // Cleanup clone directory
        rmSync(cloneDir, { recursive: true, force: true });

        // Trigger deployment if requested
        let deployment = null;
        let deployResult = null;
        if (deploy === 'true') {
          // Check deployment limits based on plan
          const deployCheck = await canDeploy(req.agentId!);
          if (!deployCheck.allowed) {
            // Upload succeeded but deployment blocked by limits
            res.status(200).json({
              success: true,
              repository: name,
              commit_sha: commitSha,
              deployment: null,
              deployment_blocked: {
                error: 'Deployment limit exceeded',
                message: deployCheck.reason,
                upgrade_url: '/app/billing',
              },
            });
            return;
          }

          const validTargets = ['railway', 'fly'];
          const deployTarget = (validTargets.includes(target as string) ? target as string : 'railway') as 'railway' | 'fly';
          deployment = await createDeployment(repo.id, commitSha, deployTarget, req.agentId!);

          // Update status to building
          await updateDeployment(deployment.id, { status: 'building' });

          // Actually deploy using the deploy engine
          try {
            deployResult = await deployToProvider({
              repoPath: sourceDir,
              commitSha,
              provider: deployTarget,
              appName: name,
            });

            // Update deployment record with result
            if (deployResult.success) {
              await updateDeployment(deployment.id, {
                status: 'success',
                url: deployResult.url,
                subdomain: deployResult.customDomain,
                logs: deployResult.logs.join('\n'),
                completed_at: new Date().toISOString(),
              });
            } else {
              await updateDeployment(deployment.id, {
                status: 'failed',
                logs: deployResult.logs.join('\n') + '\n\nError: ' + deployResult.error,
                completed_at: new Date().toISOString(),
              });
            }
          } catch (deployError: any) {
            await updateDeployment(deployment.id, {
              status: 'failed',
              logs: `Deployment error: ${deployError.message}`,
              completed_at: new Date().toISOString(),
            });
            deployResult = { success: false, error: deployError.message, logs: [] };
          }
        }

        // Track repo upload
        track(req.agentId!, 'repo_uploaded', {
          repo_id: repo.id,
          repo_name: name,
          files_count: allFiles.length,
          has_changes: hasChanges,
          triggered_deploy: deploy === 'true',
        });

        res.status(201).json({
          success: true,
          repository: name,
          commit_sha: commitSha,
          files_uploaded: allFiles.length,
          has_changes: hasChanges,
          deployment: deployment ? {
            id: deployment.id,
            status: deployResult?.success ? 'success' : (deployResult ? 'failed' : 'pending'),
            target: deployment.target,
            url: deployResult?.url,
            error: deployResult?.success === false ? deployResult.error : undefined,
          } : null,
        });
      } catch (gitError: any) {
        // Cleanup on git error
        if (existsSync(cloneDir)) {
          rmSync(cloneDir, { recursive: true, force: true });
        }
        throw gitError;
      }
    } catch (error: any) {
      console.error('Upload error:', error);
      res.status(500).json({
        error: 'Failed to process upload',
        details: error.message,
      });
    } finally {
      // Cleanup temp directories
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
      if (workDir && existsSync(workDir)) {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  }
);

/**
 * Recursively get all files in a directory
 */
async function getAllFiles(dir: string, files: string[] = []): Promise<string[]> {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await getAllFiles(fullPath, files);
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

export default router;
