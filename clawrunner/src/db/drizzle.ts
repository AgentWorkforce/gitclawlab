import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

let pool: Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL env var is required for database connections');
  }

  const poolInstance = new Pool({
    connectionString,
    ssl: connectionString.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : undefined,
  });

  poolInstance.on('error', (err) => {
    console.error('[db] Pool error', err);
  });

  return poolInstance;
}

export function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

export { schema };
