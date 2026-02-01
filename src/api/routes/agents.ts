import { Router, Request, Response } from 'express';
import { ulid } from 'ulid';
import crypto from 'crypto';
import { getDb } from '../../db/schema.js';
import { track } from '../../analytics/posthog.js';

const router = Router();

interface Agent {
  id: string;
  name: string;
  capabilities: string;
  created_at: string;
}

// POST /api/agents - Register a new agent (requires admin authentication)
router.post('/', (req: Request, res: Response) => {
  try {
    // Require admin API key for agent registration
    const adminKey = req.headers['x-admin-key'];
    if (!process.env.ADMIN_API_KEY) {
      res.status(503).json({ error: 'Agent registration not configured. Set ADMIN_API_KEY environment variable.' });
      return;
    }

    if (adminKey !== process.env.ADMIN_API_KEY) {
      res.status(401).json({ error: 'Unauthorized. Valid X-Admin-Key header required.' });
      return;
    }

    const { name, capabilities } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Agent name is required' });
      return;
    }

    const db = getDb();
    const id = `agent-${ulid()}`;
    const token = `gcl_${crypto.randomBytes(32).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const now = new Date().toISOString();
    const capsJson = JSON.stringify(capabilities || ['repos']);

    // Ensure agents table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // Insert agent
    db.prepare(`
      INSERT INTO agents (id, name, capabilities, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, name, capsJson, now);

    // Store token hash
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year
    db.prepare(`
      INSERT INTO agent_tokens (id, agent_id, token_hash, permissions, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ulid(), id, tokenHash, capsJson, expiresAt, now);

    // Track agent registration
    track(id, 'agent_registered', { agent_id: id, agent_name: name });

    res.status(201).json({
      id,
      name,
      token, // Only returned once at creation
      capabilities: capabilities || ['repos'],
      created_at: now,
    });
  } catch (err) {
    console.error('Error creating agent:', err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// GET /api/agents/:id - Get agent info (without token)
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const agent = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(req.params.id) as Agent | undefined;

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    res.json({
      id: agent.id,
      name: agent.name,
      capabilities: JSON.parse(agent.capabilities),
      created_at: agent.created_at,
    });
  } catch (err) {
    console.error('Error getting agent:', err);
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

export default router;
