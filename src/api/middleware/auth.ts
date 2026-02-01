import { Request, Response, NextFunction } from 'express';
import { getAgentToken, getAgent, createAgentToken, checkRepoAccess } from '../../db/schema.js';
import crypto from 'crypto';

export interface AuthenticatedRequest extends Request {
  agentId?: string;
  permissions?: string[];
}

/**
 * Middleware to authenticate requests using agent tokens or X-Agent-ID header
 *
 * Auth methods (in order of precedence):
 * 1. Authorization: Bearer <token> - Full token-based auth with permissions
 * 2. X-Agent-ID: <agent-id> - Simple agent identification (for agent-to-agent calls)
 */
export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const agentIdHeader = req.headers['x-agent-id'] as string | undefined;

  // Try Bearer token first
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    try {
      const tokenRecord = await getAgentToken(tokenHash);

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
      return;
    } catch (error) {
      res.status(500).json({ error: 'Authentication failed' });
      return;
    }
  }

  // Fall back to X-Agent-ID header (simpler auth for agent-to-agent calls)
  if (agentIdHeader) {
    try {
      // Check if this agent exists in the agents table
      const agent = await getAgent(agentIdHeader);

      if (agent) {
        req.agentId = agent.id;
        req.permissions = JSON.parse(agent.capabilities);
        next();
        return;
      }

      // For unregistered agents, allow basic access with the header value as ID
      // This enables new agents to interact before full registration
      req.agentId = agentIdHeader;
      req.permissions = ['repos']; // Default minimal permissions
      next();
      return;
    } catch (error) {
      res.status(500).json({ error: 'Authentication failed' });
      return;
    }
  }

  res.status(401).json({ error: 'Missing or invalid authorization. Use Bearer token or X-Agent-ID header.' });
}

/**
 * Optional auth middleware - allows unauthenticated requests but attaches agent info if present
 */
export async function optionalAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const agentIdHeader = req.headers['x-agent-id'] as string | undefined;

  // Try Bearer token first
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    try {
      const tokenRecord = await getAgentToken(tokenHash);

      if (tokenRecord && new Date(tokenRecord.expires_at) >= new Date()) {
        req.agentId = tokenRecord.agent_id;
        req.permissions = JSON.parse(tokenRecord.permissions);
      }
    } catch {
      // Ignore errors for optional auth
    }
    next();
    return;
  }

  // Try X-Agent-ID header
  if (agentIdHeader) {
    try {
      const agent = await getAgent(agentIdHeader);

      if (agent) {
        req.agentId = agent.id;
        req.permissions = JSON.parse(agent.capabilities);
      } else {
        req.agentId = agentIdHeader;
        req.permissions = ['repos'];
      }
    } catch {
      // Ignore errors for optional auth
    }
  }

  next();
}

/**
 * Check if agent has permission to access a repository
 * This is now an async function that wraps the schema function
 */
export async function hasRepoAccess(
  agentId: string | undefined,
  repoId: string,
  requiredPermission: 'read' | 'write' | 'admin'
): Promise<boolean> {
  return checkRepoAccess(agentId, repoId, requiredPermission);
}

/**
 * Synchronous version for backward compatibility in non-async contexts
 * NOTE: This only works with SQLite. Will throw an error with PostgreSQL.
 * @deprecated Use hasRepoAccess() instead
 */
export function hasRepoAccessSync(
  agentId: string | undefined,
  repoId: string,
  requiredPermission: 'read' | 'write' | 'admin'
): boolean {
  // This is a workaround for code that hasn't been migrated to async
  // It will only work with SQLite
  const { isUsingPostgres, getDb } = require('../../db/schema.js');
  if (isUsingPostgres()) {
    throw new Error('hasRepoAccessSync() cannot be used with PostgreSQL. Use hasRepoAccess() instead.');
  }

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
export async function generateToken(
  agentId: string,
  permissions: string[],
  expiresInDays: number = 30
): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000);

  await createAgentToken(agentId, tokenHash, permissions, expiresAt);

  return token;
}
