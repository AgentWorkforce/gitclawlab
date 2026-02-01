/**
 * Migration runner for GitClawLab
 * Supports both SQLite (local dev) and PostgreSQL (production)
 */

import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DatabaseAdapter {
  query(sql: string, params?: any[]): Promise<any[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Get list of migration files sorted by name
 */
export async function getMigrationFiles(): Promise<string[]> {
  const migrationsDir = join(__dirname, 'migrations');
  try {
    const files = await readdir(migrationsDir);
    return files
      .filter(f => f.endsWith('.sql'))
      .sort();
  } catch (error) {
    console.error('Failed to read migrations directory:', error);
    return [];
  }
}

/**
 * Create migrations tracking table if it doesn't exist
 */
export async function ensureMigrationsTable(adapter: DatabaseAdapter): Promise<void> {
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

/**
 * Get list of already applied migrations
 */
export async function getAppliedMigrations(adapter: DatabaseAdapter): Promise<string[]> {
  const rows = await adapter.query('SELECT name FROM _migrations ORDER BY name');
  return rows.map((r: any) => r.name);
}

/**
 * Mark a migration as applied
 */
export async function recordMigration(adapter: DatabaseAdapter, name: string): Promise<void> {
  const id = `mig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  await adapter.exec(`
    INSERT INTO _migrations (id, name, applied_at) VALUES ('${id}', '${name}', '${now}')
  `);
}

/**
 * Run all pending migrations
 */
export async function runMigrations(adapter: DatabaseAdapter): Promise<{ applied: string[] }> {
  await ensureMigrationsTable(adapter);

  const allMigrations = await getMigrationFiles();
  const appliedMigrations = await getAppliedMigrations(adapter);
  const pendingMigrations = allMigrations.filter(m => !appliedMigrations.includes(m));

  const applied: string[] = [];

  for (const migration of pendingMigrations) {
    console.log(`Running migration: ${migration}`);
    const migrationsDir = join(__dirname, 'migrations');
    const sql = await readFile(join(migrationsDir, migration), 'utf-8');

    // Split SQL into individual statements and run them
    // This handles multi-statement migrations
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      await adapter.exec(statement);
    }

    await recordMigration(adapter, migration);
    applied.push(migration);
    console.log(`Completed migration: ${migration}`);
  }

  if (applied.length === 0) {
    console.log('No pending migrations');
  } else {
    console.log(`Applied ${applied.length} migration(s)`);
  }

  return { applied };
}
