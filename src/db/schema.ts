import Database from 'better-sqlite3';
import pg from 'pg';
import { ulid } from 'ulid';
import { runMigrations, DatabaseAdapter } from './migrate.js';

// Database type detection
const isPostgres = !!process.env.DATABASE_URL;

// Database connections
let sqliteDb: Database.Database | null = null;
let pgPool: pg.Pool | null = null;

/**
 * SQLite adapter for migrations
 */
class SQLiteAdapter implements DatabaseAdapter {
  constructor(private db: Database.Database) {}

  async query(sql: string, params?: any[]): Promise<any[]> {
    if (params && params.length > 0) {
      return this.db.prepare(sql).all(...params);
    }
    return this.db.prepare(sql).all();
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * PostgreSQL adapter for migrations
 */
class PostgresAdapter implements DatabaseAdapter {
  constructor(private pool: pg.Pool) {}

  async query(sql: string, params?: any[]): Promise<any[]> {
    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Get the current database adapter for raw operations
 */
export function getAdapter(): DatabaseAdapter {
  if (isPostgres && pgPool) {
    return new PostgresAdapter(pgPool);
  }
  if (sqliteDb) {
    return new SQLiteAdapter(sqliteDb);
  }
  throw new Error('Database not initialized');
}

/**
 * Get the SQLite database instance (for backward compatibility)
 * @deprecated Use query functions instead
 */
export function getDb(): Database.Database {
  if (isPostgres) {
    throw new Error('Cannot use getDb() with PostgreSQL. Use query functions instead.');
  }
  if (!sqliteDb) {
    throw new Error('Database not initialized');
  }
  return sqliteDb;
}

/**
 * Execute a query and return results
 */
async function query<T = any>(sql: string, params?: any[]): Promise<T[]> {
  if (isPostgres && pgPool) {
    // Convert ? placeholders to $1, $2, etc. for PostgreSQL
    let pgSql = sql;
    let paramIndex = 0;
    pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);
    const result = await pgPool.query(pgSql, params);
    return result.rows;
  }
  if (sqliteDb) {
    if (params && params.length > 0) {
      return sqliteDb.prepare(sql).all(...params) as T[];
    }
    return sqliteDb.prepare(sql).all() as T[];
  }
  throw new Error('Database not initialized');
}

/**
 * Execute a query and return first result or null
 */
async function queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
  const results = await query<T>(sql, params);
  return results[0] || null;
}

/**
 * Execute a statement (INSERT, UPDATE, DELETE)
 */
async function execute(sql: string, params?: any[]): Promise<void> {
  if (isPostgres && pgPool) {
    // Convert ? placeholders to $1, $2, etc. for PostgreSQL
    let pgSql = sql;
    let paramIndex = 0;
    pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);
    await pgPool.query(pgSql, params);
    return;
  }
  if (sqliteDb) {
    if (params && params.length > 0) {
      sqliteDb.prepare(sql).run(...params);
    } else {
      sqliteDb.exec(sql);
    }
    return;
  }
  throw new Error('Database not initialized');
}

/**
 * Initialize the database (SQLite or PostgreSQL based on environment)
 */
export async function initDatabase(): Promise<void> {
  if (isPostgres) {
    console.log('Initializing PostgreSQL database...');
    pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    // Test connection
    try {
      await pgPool.query('SELECT 1');
      console.log('PostgreSQL connection successful');
    } catch (error) {
      console.error('PostgreSQL connection failed:', error);
      throw error;
    }

    // Run migrations
    const adapter = new PostgresAdapter(pgPool);
    await runMigrations(adapter);
  } else {
    console.log('Initializing SQLite database...');
    sqliteDb = new Database('.moltlab/data.db');

    // Enable WAL mode for better performance
    sqliteDb.pragma('journal_mode = WAL');

    // Run migrations
    const adapter = new SQLiteAdapter(sqliteDb);
    await runMigrations(adapter);
  }

  console.log('Database initialized successfully');
}

// Repository operations
export interface Repository {
  id: string;
  name: string;
  description: string | null;
  owner_agent_id: string;
  is_private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  last_push_at: string | null;
}

export async function createRepository(
  name: string,
  ownerAgentId: string,
  description?: string
): Promise<Repository> {
  const id = ulid();
  const now = new Date().toISOString();

  await execute(
    `INSERT INTO repositories (id, name, description, owner_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, description || null, ownerAgentId, now, now]
  );

  const repo = await getRepository(id);
  if (!repo) throw new Error('Failed to create repository');
  return repo;
}

export async function getRepository(idOrName: string): Promise<Repository | null> {
  return queryOne<Repository>(
    `SELECT * FROM repositories WHERE id = ? OR name = ?`,
    [idOrName, idOrName]
  );
}

export async function listRepositories(agentId?: string): Promise<Repository[]> {
  if (agentId) {
    return query<Repository>(
      `SELECT DISTINCT r.* FROM repositories r
       LEFT JOIN repo_access ra ON r.id = ra.repo_id
       WHERE r.owner_agent_id = ? OR ra.agent_id = ? OR r.is_private = 0`,
      [agentId, agentId]
    );
  }
  return query<Repository>(`SELECT * FROM repositories WHERE is_private = 0`);
}

// Deployment operations
export interface Deployment {
  id: string;
  repo_id: string;
  commit_sha: string;
  target: 'railway' | 'fly' | 'coolify';
  status: 'pending' | 'building' | 'deploying' | 'success' | 'failed';
  url: string | null;
  subdomain: string | null;
  logs: string | null;
  started_at: string;
  completed_at: string | null;
  deployed_by: string;
}

export async function createDeployment(
  repoId: string,
  commitSha: string,
  target: string,
  deployedBy: string
): Promise<Deployment> {
  const id = ulid();
  const now = new Date().toISOString();

  await execute(
    `INSERT INTO deployments (id, repo_id, commit_sha, target, status, started_at, deployed_by)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    [id, repoId, commitSha, target, now, deployedBy]
  );

  const deployment = await getDeployment(id);
  if (!deployment) throw new Error('Failed to create deployment');
  return deployment;
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  return queryOne<Deployment>(`SELECT * FROM deployments WHERE id = ?`, [id]);
}

export async function updateDeployment(
  id: string,
  updates: Partial<Pick<Deployment, 'status' | 'url' | 'subdomain' | 'logs' | 'completed_at'>>
): Promise<Deployment | null> {
  const sets: string[] = [];
  const values: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }

  if (sets.length > 0) {
    values.push(id);
    await execute(`UPDATE deployments SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  return getDeployment(id);
}

export async function listDeployments(repoId?: string): Promise<Deployment[]> {
  if (repoId) {
    return query<Deployment>(
      `SELECT * FROM deployments WHERE repo_id = ? ORDER BY started_at DESC`,
      [repoId]
    );
  }
  return query<Deployment>(`SELECT * FROM deployments ORDER BY started_at DESC`);
}

export async function getLatestSuccessfulDeployment(repoId: string): Promise<Deployment | null> {
  return queryOne<Deployment>(
    `SELECT * FROM deployments WHERE repo_id = ? AND status = 'success' AND url IS NOT NULL ORDER BY completed_at DESC LIMIT 1`,
    [repoId]
  );
}

// Subscription operations
export interface Subscription {
  id: string;
  agent_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  plan_type: 'free' | 'pro' | 'team';
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

export async function getSubscriptionByAgentId(agentId: string): Promise<Subscription | null> {
  return queryOne<Subscription>(
    `SELECT * FROM subscriptions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`,
    [agentId]
  );
}

export async function getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<Subscription | null> {
  return queryOne<Subscription>(
    `SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`,
    [stripeSubscriptionId]
  );
}

// Payment operations
export interface Payment {
  id: string;
  stripe_invoice_id: string;
  stripe_subscription_id: string | null;
  amount: number;
  currency: string;
  status: 'succeeded' | 'failed' | 'pending';
  created_at: string;
}

export async function listPaymentsBySubscription(stripeSubscriptionId: string): Promise<Payment[]> {
  return query<Payment>(
    `SELECT * FROM payments WHERE stripe_subscription_id = ? ORDER BY created_at DESC`,
    [stripeSubscriptionId]
  );
}

// Plan limits
export const PLAN_LIMITS = {
  free: {
    maxRepos: 5,
    maxDeploymentsPerMonth: 10,
  },
  pro: {
    maxRepos: -1, // unlimited
    maxDeploymentsPerMonth: -1, // unlimited
  },
  team: {
    maxRepos: -1, // unlimited
    maxDeploymentsPerMonth: -1, // unlimited
  },
} as const;

export type PlanType = keyof typeof PLAN_LIMITS;

/**
 * Get an agent's current plan type based on their active subscription
 */
export async function getAgentPlan(agentId: string): Promise<PlanType> {
  const subscription = await getSubscriptionByAgentId(agentId);
  if (!subscription || subscription.status !== 'active') {
    return 'free';
  }
  return subscription.plan_type as PlanType;
}

/**
 * Count deployments for an agent in the current month
 */
export async function countMonthlyDeployments(agentId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const result = await queryOne<{ count: number | string }>(
    `SELECT COUNT(*) as count FROM deployments
     WHERE deployed_by = ? AND started_at >= ?`,
    [agentId, startOfMonth]
  );

  // PostgreSQL returns bigint as string, SQLite returns number
  return result ? Number(result.count) : 0;
}

/**
 * Count repositories owned by an agent
 */
export async function countAgentRepos(agentId: string): Promise<number> {
  const result = await queryOne<{ count: number | string }>(
    `SELECT COUNT(*) as count FROM repositories WHERE owner_agent_id = ?`,
    [agentId]
  );

  // PostgreSQL returns bigint as string, SQLite returns number
  return result ? Number(result.count) : 0;
}

/**
 * Check if an agent can create a new deployment based on their plan limits
 */
export async function canDeploy(agentId: string): Promise<{ allowed: boolean; reason?: string; remaining?: number }> {
  const plan = await getAgentPlan(agentId);
  const limits = PLAN_LIMITS[plan];

  // Unlimited deployments
  if (limits.maxDeploymentsPerMonth === -1) {
    return { allowed: true };
  }

  const monthlyCount = await countMonthlyDeployments(agentId);
  const remaining = limits.maxDeploymentsPerMonth - monthlyCount;

  if (remaining <= 0) {
    return {
      allowed: false,
      reason: `Monthly deployment limit reached (${limits.maxDeploymentsPerMonth} for ${plan} plan). Upgrade to Pro for unlimited deployments.`,
      remaining: 0,
    };
  }

  return { allowed: true, remaining };
}

/**
 * Check if an agent can create a new repository based on their plan limits
 */
export async function canCreateRepo(agentId: string): Promise<{ allowed: boolean; reason?: string; remaining?: number }> {
  const plan = await getAgentPlan(agentId);
  const limits = PLAN_LIMITS[plan];

  // Unlimited repos
  if (limits.maxRepos === -1) {
    return { allowed: true };
  }

  const repoCount = await countAgentRepos(agentId);
  const remaining = limits.maxRepos - repoCount;

  if (remaining <= 0) {
    return {
      allowed: false,
      reason: `Repository limit reached (${limits.maxRepos} for ${plan} plan). Upgrade to Pro for unlimited repositories.`,
      remaining: 0,
    };
  }

  return { allowed: true, remaining };
}

// ============================================================================
// Raw query helpers for use by other modules (auth, routes, etc.)
// These are exported for direct database access when the schema functions
// above don't cover the use case.
// ============================================================================

/**
 * Execute a query and return results (exported for other modules)
 */
export async function dbQuery<T = any>(sql: string, params?: any[]): Promise<T[]> {
  return query<T>(sql, params);
}

/**
 * Execute a query and return first result or null (exported for other modules)
 */
export async function dbQueryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
  return queryOne<T>(sql, params);
}

/**
 * Execute a statement (INSERT, UPDATE, DELETE) - exported for other modules
 */
export async function dbExecute(sql: string, params?: any[]): Promise<void> {
  return execute(sql, params);
}

/**
 * Update a repository's timestamps
 */
export async function updateRepositoryTimestamp(repoId: string): Promise<void> {
  const now = new Date().toISOString();
  await execute(
    `UPDATE repositories SET last_push_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, repoId]
  );
}

/**
 * Update repository by name
 */
export async function updateRepositoryByName(name: string, updates: { last_push_at?: string; updated_at?: string }): Promise<void> {
  const sets: string[] = [];
  const values: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }

  if (sets.length > 0) {
    values.push(name);
    await execute(`UPDATE repositories SET ${sets.join(', ')} WHERE name = ?`, values);
  }
}

/**
 * Delete repository and all related records
 */
export async function deleteRepository(repoId: string): Promise<void> {
  await execute('DELETE FROM repo_access WHERE repo_id = ?', [repoId]);
  await execute('DELETE FROM webhooks WHERE repo_id = ?', [repoId]);
  await execute('DELETE FROM deployments WHERE repo_id = ?', [repoId]);
  await execute('DELETE FROM repositories WHERE id = ?', [repoId]);
}

/**
 * Update a repository
 */
export async function updateRepository(
  repoId: string,
  updates: Partial<Pick<Repository, 'description' | 'is_private' | 'default_branch'>>
): Promise<Repository | null> {
  const sets: string[] = [];
  const values: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (key === 'is_private') {
      sets.push(`${key} = ?`);
      values.push(value ? 1 : 0);
    } else {
      sets.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(repoId);
    await execute(`UPDATE repositories SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  return getRepository(repoId);
}

/**
 * Get repo access list
 */
export async function getRepoAccessList(repoId: string): Promise<any[]> {
  return query('SELECT * FROM repo_access WHERE repo_id = ?', [repoId]);
}

/**
 * Grant repo access
 */
export async function grantRepoAccess(
  repoId: string,
  agentId: string,
  permission: string
): Promise<{ id: string; repo_id: string; agent_id: string; permission: string; created_at: string }> {
  const id = ulid();
  const now = new Date().toISOString();

  // For PostgreSQL, use ON CONFLICT; for SQLite use INSERT OR REPLACE
  if (isPostgres) {
    await execute(
      `INSERT INTO repo_access (id, repo_id, agent_id, permission, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, agent_id) DO UPDATE SET permission = EXCLUDED.permission`,
      [id, repoId, agentId, permission, now]
    );
  } else {
    await execute(
      `INSERT OR REPLACE INTO repo_access (id, repo_id, agent_id, permission, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, repoId, agentId, permission, now]
    );
  }

  return { id, repo_id: repoId, agent_id: agentId, permission, created_at: now };
}

/**
 * Revoke repo access
 */
export async function revokeRepoAccess(repoId: string, agentId: string): Promise<void> {
  await execute('DELETE FROM repo_access WHERE repo_id = ? AND agent_id = ?', [repoId, agentId]);
}

/**
 * Check if user has repo access (used by auth middleware)
 */
export async function checkRepoAccess(
  agentId: string | undefined,
  repoId: string,
  requiredPermission: 'read' | 'write' | 'admin'
): Promise<boolean> {
  // Get repository info
  const repo = await queryOne<{ owner_agent_id: string; is_private: number }>(
    'SELECT owner_agent_id, is_private FROM repositories WHERE id = ?',
    [repoId]
  );

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
  const access = await queryOne<{ permission: string }>(
    'SELECT permission FROM repo_access WHERE repo_id = ? AND agent_id = ?',
    [repoId, agentId]
  );

  if (!access) {
    return false;
  }

  const permissionLevel: Record<string, number> = { read: 1, write: 2, admin: 3 };
  return permissionLevel[access.permission] >= permissionLevel[requiredPermission];
}

/**
 * Get agent token by hash (for auth)
 */
export async function getAgentToken(tokenHash: string): Promise<{ agent_id: string; permissions: string; expires_at: string } | null> {
  return queryOne<{ agent_id: string; permissions: string; expires_at: string }>(
    'SELECT agent_id, permissions, expires_at FROM agent_tokens WHERE token_hash = ?',
    [tokenHash]
  );
}

/**
 * Get agent by ID or name
 */
export async function getAgent(idOrName: string): Promise<{ id: string; capabilities: string } | null> {
  return queryOne<{ id: string; capabilities: string }>(
    'SELECT id, capabilities FROM agents WHERE id = ? OR name = ?',
    [idOrName, idOrName]
  );
}

/**
 * Create an agent token
 */
export async function createAgentToken(
  agentId: string,
  tokenHash: string,
  permissions: string[],
  expiresAt: Date
): Promise<void> {
  const id = ulid();
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO agent_tokens (id, agent_id, token_hash, permissions, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, agentId, tokenHash, JSON.stringify(permissions), expiresAt.toISOString(), now]
  );
}

/**
 * Check if database is using PostgreSQL
 */
export function isUsingPostgres(): boolean {
  return isPostgres;
}
