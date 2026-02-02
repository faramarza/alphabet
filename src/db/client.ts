/**
 * PostgreSQL Database Client
 * Uses native pg library with connection pooling
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config/index.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.database.url,
      min: config.database.poolMin,
      max: config.database.poolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }
  return pool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number | null }> {
  const pool = getPool();
  const start = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  if (config.logLevel === 'debug') {
    console.log('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
  }

  return { rows: result.rows as T[], rowCount: result.rowCount };
}

export async function getClient(): Promise<PoolClient> {
  const pool = getPool();
  return pool.connect();
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Advisory lock for single-instance jobs
 */
export async function tryAdvisoryLock(lockId: number): Promise<boolean> {
  const result = await query<{ pg_try_advisory_lock: boolean }>(
    'SELECT pg_try_advisory_lock($1)',
    [lockId]
  );
  return result.rows[0]?.pg_try_advisory_lock ?? false;
}

export async function releaseAdvisoryLock(lockId: number): Promise<void> {
  await query('SELECT pg_advisory_unlock($1)', [lockId]);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Health check
export async function healthCheck(): Promise<boolean> {
  try {
    const result = await query<{ now: Date }>('SELECT NOW()');
    return result.rows.length > 0;
  } catch {
    return false;
  }
}
