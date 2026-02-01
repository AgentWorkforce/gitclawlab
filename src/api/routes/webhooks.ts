import { Router, Response } from 'express';
import { getRepository, dbQuery, dbQueryOne, dbExecute } from '../../db/schema.js';
import { authMiddleware, hasRepoAccess, AuthenticatedRequest } from '../middleware/auth.js';
import crypto from 'crypto';
import { ulid } from 'ulid';

/**
 * Check if a URL is potentially targeting internal/private networks (SSRF protection)
 */
function isInternalUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // Block localhost and loopback
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }

    // Block private IP ranges
    const ipParts = hostname.split('.').map(Number);
    if (ipParts.length === 4 && ipParts.every(p => !isNaN(p))) {
      // 10.0.0.0/8
      if (ipParts[0] === 10) return true;
      // 172.16.0.0/12
      if (ipParts[0] === 172 && ipParts[1] >= 16 && ipParts[1] <= 31) return true;
      // 192.168.0.0/16
      if (ipParts[0] === 192 && ipParts[1] === 168) return true;
      // 169.254.0.0/16 (link-local, includes cloud metadata endpoints)
      if (ipParts[0] === 169 && ipParts[1] === 254) return true;
      // 0.0.0.0
      if (ipParts.every(p => p === 0)) return true;
    }

    // Block common internal hostnames
    const blockedPatterns = ['internal', 'intranet', 'corp', 'private', 'metadata'];
    if (blockedPatterns.some(p => hostname.includes(p))) {
      return true;
    }

    // Block non-http(s) protocols
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return true;
    }

    return false;
  } catch {
    return true; // Block malformed URLs
  }
}

const router = Router();

export interface Webhook {
  id: string;
  repo_id: string;
  url: string;
  secret: string | null;
  events: string[];
  is_active: boolean;
  created_at: string;
}

/**
 * GET /api/repos/:name/webhooks - List webhooks for a repository
 */
router.get('/repos/:name/webhooks', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
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

    const webhooks = await dbQuery('SELECT * FROM webhooks WHERE repo_id = ?', [repo.id]);

    // Parse events JSON and mask secrets
    const result = webhooks.map((w: any) => ({
      ...w,
      events: JSON.parse(w.events),
      secret: w.secret ? '********' : null,
      is_active: Boolean(w.is_active),
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

/**
 * POST /api/repos/:name/webhooks - Create a webhook
 */
router.post('/repos/:name/webhooks', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name } = req.params;
  const { url, events, secret } = req.body;

  if (!url) {
    res.status(400).json({ error: 'Webhook URL is required' });
    return;
  }

  // Validate URL format and check for SSRF
  try {
    new URL(url);
    if (isInternalUrl(url)) {
      res.status(400).json({ error: 'Webhook URL cannot target internal or private network addresses' });
      return;
    }
  } catch {
    res.status(400).json({ error: 'Invalid webhook URL' });
    return;
  }

  const validEvents = ['push', 'pull_request', 'deployment', 'deployment_status'];
  const webhookEvents = events || ['push'];

  for (const event of webhookEvents) {
    if (!validEvents.includes(event)) {
      res.status(400).json({
        error: `Invalid event type: ${event}. Valid events: ${validEvents.join(', ')}`,
      });
      return;
    }
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

    const id = ulid();
    const now = new Date().toISOString();

    // Generate a secret if not provided
    const webhookSecret = secret || crypto.randomBytes(20).toString('hex');

    await dbExecute(
      `INSERT INTO webhooks (id, repo_id, url, secret, events, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [id, repo.id, url, webhookSecret, JSON.stringify(webhookEvents), now]
    );

    res.status(201).json({
      id,
      repo_id: repo.id,
      url,
      secret: webhookSecret,
      events: webhookEvents,
      is_active: true,
      created_at: now,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

/**
 * GET /api/repos/:name/webhooks/:id - Get webhook details
 */
router.get('/repos/:name/webhooks/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name, id } = req.params;

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

    const webhook = await dbQueryOne('SELECT * FROM webhooks WHERE id = ? AND repo_id = ?', [id, repo.id]);

    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    res.json({
      ...webhook,
      events: JSON.parse(webhook.events),
      secret: webhook.secret ? '********' : null,
      is_active: Boolean(webhook.is_active),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get webhook' });
  }
});

/**
 * PATCH /api/repos/:name/webhooks/:id - Update webhook
 */
router.patch('/repos/:name/webhooks/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name, id } = req.params;
  const { url, events, is_active, secret } = req.body;

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

    const webhook = await dbQueryOne('SELECT * FROM webhooks WHERE id = ? AND repo_id = ?', [id, repo.id]);

    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (url !== undefined) {
      try {
        new URL(url);
        if (isInternalUrl(url)) {
          res.status(400).json({ error: 'Webhook URL cannot target internal or private network addresses' });
          return;
        }
      } catch {
        res.status(400).json({ error: 'Invalid webhook URL' });
        return;
      }
      updates.push('url = ?');
      values.push(url);
    }

    if (events !== undefined) {
      const validEvents = ['push', 'pull_request', 'deployment', 'deployment_status'];
      for (const event of events) {
        if (!validEvents.includes(event)) {
          res.status(400).json({ error: `Invalid event type: ${event}` });
          return;
        }
      }
      updates.push('events = ?');
      values.push(JSON.stringify(events));
    }

    if (is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(is_active ? 1 : 0);
    }

    if (secret !== undefined) {
      updates.push('secret = ?');
      values.push(secret);
    }

    if (updates.length > 0) {
      values.push(id);
      await dbExecute(`UPDATE webhooks SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    const updated = await dbQueryOne('SELECT * FROM webhooks WHERE id = ?', [id]);

    res.json({
      ...updated,
      events: JSON.parse(updated.events),
      secret: updated.secret ? '********' : null,
      is_active: Boolean(updated.is_active),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update webhook' });
  }
});

/**
 * DELETE /api/repos/:name/webhooks/:id - Delete webhook
 */
router.delete('/repos/:name/webhooks/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name, id } = req.params;

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

    // Check if webhook exists before deleting
    const webhook = await dbQueryOne('SELECT id FROM webhooks WHERE id = ? AND repo_id = ?', [id, repo.id]);
    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    await dbExecute('DELETE FROM webhooks WHERE id = ? AND repo_id = ?', [id, repo.id]);

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

/**
 * POST /api/repos/:name/webhooks/:id/test - Test webhook delivery
 */
router.post('/repos/:name/webhooks/:id/test', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name, id } = req.params;

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

    const webhook = await dbQueryOne('SELECT * FROM webhooks WHERE id = ? AND repo_id = ?', [id, repo.id]) as any;

    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    // SSRF protection check before sending
    if (isInternalUrl(webhook.url)) {
      res.status(400).json({ error: 'Cannot test webhook with internal or private network URL' });
      return;
    }

    // Send test payload
    const payload = {
      event: 'ping',
      repository: {
        id: repo.id,
        name: repo.name,
        description: repo.description,
      },
      sender: {
        agent_id: req.agentId,
      },
      timestamp: new Date().toISOString(),
    };

    const payloadString = JSON.stringify(payload);
    const signature = webhook.secret
      ? crypto.createHmac('sha256', webhook.secret).update(payloadString).digest('hex')
      : null;

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MoltLab-Event': 'ping',
          'X-MoltLab-Delivery': ulid(),
          ...(signature && { 'X-MoltLab-Signature-256': `sha256=${signature}` }),
        },
        body: payloadString,
      });

      res.json({
        success: response.ok,
        status: response.status,
        message: response.ok ? 'Webhook delivered successfully' : 'Webhook delivery failed',
      });
    } catch (fetchError) {
      res.json({
        success: false,
        status: 0,
        message: `Failed to deliver webhook: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`,
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to test webhook' });
  }
});

/**
 * Helper function to deliver webhooks for a repository event
 * This would be called from other parts of the application
 */
export async function deliverWebhooks(
  repoId: string,
  eventType: string,
  payload: Record<string, any>
): Promise<void> {
  const webhooks = await dbQuery(
    `SELECT * FROM webhooks WHERE repo_id = ? AND is_active = 1 AND events LIKE ?`,
    [repoId, `%"${eventType}"%`]
  );

  for (const webhook of webhooks as any[]) {
    // Skip webhooks targeting internal addresses (SSRF protection)
    if (isInternalUrl(webhook.url)) {
      console.error(`Skipping webhook ${webhook.id}: URL targets internal network`);
      continue;
    }

    const payloadString = JSON.stringify({
      event: eventType,
      ...payload,
      timestamp: new Date().toISOString(),
    });

    const signature = webhook.secret
      ? crypto.createHmac('sha256', webhook.secret).update(payloadString).digest('hex')
      : null;

    try {
      await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MoltLab-Event': eventType,
          'X-MoltLab-Delivery': ulid(),
          ...(signature && { 'X-MoltLab-Signature-256': `sha256=${signature}` }),
        },
        body: payloadString,
      });
    } catch {
      // Log webhook delivery failure silently
      console.error(`Failed to deliver webhook ${webhook.id} to ${webhook.url}`);
    }
  }
}

export default router;
