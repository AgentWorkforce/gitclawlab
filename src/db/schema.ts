import Database from 'better-sqlite3';
import { ulid } from 'ulid';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

export async function initDatabase(): Promise<void> {
  db = new Database('.moltlab/data.db');

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    -- Repositories
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      owner_agent_id TEXT NOT NULL,
      is_private INTEGER DEFAULT 0,
      default_branch TEXT DEFAULT 'main',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_push_at TEXT
    );

    -- Repository access permissions
    CREATE TABLE IF NOT EXISTS repo_access (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repositories(id),
      agent_id TEXT NOT NULL,
      permission TEXT NOT NULL, -- 'read', 'write', 'admin'
      created_at TEXT NOT NULL,
      UNIQUE(repo_id, agent_id)
    );

    -- Deployments
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repositories(id),
      commit_sha TEXT NOT NULL,
      target TEXT NOT NULL, -- 'railway', 'fly', 'coolify'
      status TEXT NOT NULL, -- 'pending', 'building', 'deploying', 'success', 'failed'
      url TEXT,
      subdomain TEXT,
      logs TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      deployed_by TEXT NOT NULL
    );

    -- Webhooks
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repositories(id),
      url TEXT NOT NULL,
      secret TEXT,
      events TEXT NOT NULL, -- JSON array of event types
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    -- Agent tokens (for git auth)
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      permissions TEXT NOT NULL, -- JSON permissions object
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Stripe subscriptions
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      stripe_customer_id TEXT NOT NULL,
      stripe_subscription_id TEXT UNIQUE NOT NULL,
      plan_type TEXT NOT NULL, -- 'free', 'pro', 'team'
      status TEXT NOT NULL, -- 'active', 'past_due', 'canceled', 'trialing', etc.
      current_period_start TEXT,
      current_period_end TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Stripe payments
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      stripe_invoice_id TEXT NOT NULL,
      stripe_subscription_id TEXT,
      amount INTEGER NOT NULL, -- Amount in cents
      currency TEXT NOT NULL,
      status TEXT NOT NULL, -- 'succeeded', 'failed', 'pending'
      created_at TEXT NOT NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_repos_owner ON repositories(owner_agent_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_repo ON deployments(repo_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
    CREATE INDEX IF NOT EXISTS idx_repo_access_agent ON repo_access(agent_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_agent ON subscriptions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
    CREATE INDEX IF NOT EXISTS idx_payments_subscription ON payments(stripe_subscription_id);
  `);
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

export function createRepository(
  name: string,
  ownerAgentId: string,
  description?: string
): Repository {
  const db = getDb();
  const id = ulid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO repositories (id, name, description, owner_agent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, description || null, ownerAgentId, now, now);

  return getRepository(id)!;
}

export function getRepository(idOrName: string): Repository | null {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM repositories WHERE id = ? OR name = ?
  `).get(idOrName, idOrName) as Repository | null;
}

export function listRepositories(agentId?: string): Repository[] {
  const db = getDb();
  if (agentId) {
    return db.prepare(`
      SELECT r.* FROM repositories r
      LEFT JOIN repo_access ra ON r.id = ra.repo_id
      WHERE r.owner_agent_id = ? OR ra.agent_id = ? OR r.is_private = 0
    `).all(agentId, agentId) as Repository[];
  }
  return db.prepare(`SELECT * FROM repositories WHERE is_private = 0`).all() as Repository[];
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

export function createDeployment(
  repoId: string,
  commitSha: string,
  target: string,
  deployedBy: string
): Deployment {
  const db = getDb();
  const id = ulid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO deployments (id, repo_id, commit_sha, target, status, started_at, deployed_by)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, repoId, commitSha, target, now, deployedBy);

  return getDeployment(id)!;
}

export function getDeployment(id: string): Deployment | null {
  const db = getDb();
  return db.prepare(`SELECT * FROM deployments WHERE id = ?`).get(id) as Deployment | null;
}

export function updateDeployment(
  id: string,
  updates: Partial<Pick<Deployment, 'status' | 'url' | 'subdomain' | 'logs' | 'completed_at'>>
): Deployment | null {
  const db = getDb();
  const sets: string[] = [];
  const values: any[] = [];

  for (const [key, value] of Object.entries(updates)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }

  if (sets.length > 0) {
    values.push(id);
    db.prepare(`UPDATE deployments SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  return getDeployment(id);
}

export function listDeployments(repoId?: string): Deployment[] {
  const db = getDb();
  if (repoId) {
    return db.prepare(`SELECT * FROM deployments WHERE repo_id = ? ORDER BY started_at DESC`)
      .all(repoId) as Deployment[];
  }
  return db.prepare(`SELECT * FROM deployments ORDER BY started_at DESC`).all() as Deployment[];
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

export function getSubscriptionByAgentId(agentId: string): Subscription | null {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM subscriptions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(agentId) as Subscription | null;
}

export function getSubscriptionByStripeId(stripeSubscriptionId: string): Subscription | null {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM subscriptions WHERE stripe_subscription_id = ?
  `).get(stripeSubscriptionId) as Subscription | null;
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

export function listPaymentsBySubscription(stripeSubscriptionId: string): Payment[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM payments WHERE stripe_subscription_id = ? ORDER BY created_at DESC
  `).all(stripeSubscriptionId) as Payment[];
}
