import { Request, Response, NextFunction } from 'express';
import { getDb } from '../../db/schema.js';
import crypto from 'crypto';

export interface AuthenticatedRequest extends Request {
  agentId?: string;
  permissions?: string[];
}

/**
 * Middleware to authenticate requests using agent tokens
 * Token should be passed in Authorization header as: Bearer <token>
 */
export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const db = getDb();
    const tokenRecord = db.prepare(`
      SELECT agent_id, permissions, expires_at
      FROM agent_tokens
      WHERE token_hash = ?
    `).get(tokenHash) as { agent_id: string; permissions: string; expires_at: string } | undefined;

    if (!tokenRecord) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }

    req.agentId = tokenRecord.agent_id;
    req.permissions = JSON.parse(tokenRecord.permissions);
    next();
  } catch (error) {
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional auth middleware - allows unauthenticated requests but attaches agent info if present
 */
export function optionalAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.slice(7);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const db = getDb();
    const tokenRecord = db.prepare(`
      SELECT agent_id, permissions, expires_at
      FROM agent_tokens
      WHERE token_hash = ?
    `).get(tokenHash) as { agent_id: string; permissions: string; expires_at: string } | undefined;

    if (tokenRecord && new Date(tokenRecord.expires_at) >= new Date()) {
      req.agentId = tokenRecord.agent_id;
      req.permissions = JSON.parse(tokenRecord.permissions);
    }
  } catch {
    // Ignore errors for optional auth
  }

  next();
}

/**
 * Check if agent has permission to access a repository
 */
export function hasRepoAccess(
  agentId: string | undefined,
  repoId: string,
  requiredPermission: 'read' | 'write' | 'admin'
): boolean {
  const db = getDb();

  // Get repository info
  const repo = db.prepare(`SELECT owner_agent_id, is_private FROM repositories WHERE id = ?`)
    .get(repoId) as { owner_agent_id: string; is_private: number } | undefined;

  if (!repo) {
    return false;
  }

  // Public repos allow read access
  if (!repo.is_private && requiredPermission === 'read') {
    return true;
  }

  // Must be authenticated for private repos or write access
  if (!agentId) {
    return false;
  }

  // Owner has full access
  if (repo.owner_agent_id === agentId) {
    return true;
  }

  // Check repo_access table
  const access = db.prepare(`
    SELECT permission FROM repo_access
    WHERE repo_id = ? AND agent_id = ?
  `).get(repoId, agentId) as { permission: string } | undefined;

  if (!access) {
    return false;
  }

  const permissionLevel: Record<string, number> = { read: 1, write: 2, admin: 3 };
  return permissionLevel[access.permission] >= permissionLevel[requiredPermission];
}

/**
 * Generate a new agent token
 */
export function generateToken(
  agentId: string,
  permissions: string[],
  expiresInDays: number = 30
): string {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO agent_tokens (id, agent_id, token_hash, permissions, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, agentId, tokenHash, JSON.stringify(permissions), expiresAt.toISOString(), now.toISOString());

  return token;
}
