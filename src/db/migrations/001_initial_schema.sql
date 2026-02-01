-- Initial schema migration for GitClawLab
-- Creates all core tables for repositories, deployments, subscriptions, etc.

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
  permission TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(repo_id, agent_id)
);

-- Deployments
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  commit_sha TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
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
  events TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Agent tokens (for git auth)
CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  permissions TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Stripe subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  plan_type TEXT NOT NULL,
  status TEXT NOT NULL,
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
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Agents
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  capabilities TEXT NOT NULL,
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
