/**
 * Database Migration Runner
 * Applies SQL migrations in order
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, closePool } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface MigrationRecord {
  id: number;
  name: string;
  applied_at: Date;
}

async function ensureMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(): Promise<string[]> {
  const result = await query<MigrationRecord>('SELECT name FROM _migrations ORDER BY id');
  return result.rows.map((r) => r.name);
}

async function getMigrationFiles(): Promise<string[]> {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  return files
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function applyMigration(name: string): Promise<void> {
  const filePath = path.join(MIGRATIONS_DIR, name);
  const sql = fs.readFileSync(filePath, 'utf8');

  console.log(`Applying migration: ${name}`);

  try {
    await query(sql);
    await query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
    console.log(`✓ Applied: ${name}`);
  } catch (error) {
    console.error(`✗ Failed: ${name}`);
    throw error;
  }
}

async function rollbackMigration(name: string): Promise<void> {
  // Look for a corresponding down migration
  const downName = name.replace('.sql', '_down.sql');
  const downPath = path.join(MIGRATIONS_DIR, downName);

  if (!fs.existsSync(downPath)) {
    console.warn(`No down migration found: ${downName}`);
    return;
  }

  const sql = fs.readFileSync(downPath, 'utf8');

  console.log(`Rolling back migration: ${name}`);

  try {
    await query(sql);
    await query('DELETE FROM _migrations WHERE name = $1', [name]);
    console.log(`✓ Rolled back: ${name}`);
  } catch (error) {
    console.error(`✗ Rollback failed: ${name}`);
    throw error;
  }
}

async function migrate(): Promise<void> {
  console.log('Starting database migration...');

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const files = await getMigrationFiles();

  // Filter out down migrations
  const upMigrations = files.filter((f) => !f.includes('_down.sql'));

  const pending = upMigrations.filter((f) => !applied.includes(f));

  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  console.log(`Found ${pending.length} pending migration(s).`);

  for (const migration of pending) {
    await applyMigration(migration);
  }

  console.log('Migration complete.');
}

async function migrateDown(steps = 1): Promise<void> {
  console.log(`Rolling back ${steps} migration(s)...`);

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  if (applied.length === 0) {
    console.log('No migrations to roll back.');
    return;
  }

  const toRollback = applied.slice(-steps).reverse();

  for (const migration of toRollback) {
    await rollbackMigration(migration);
  }

  console.log('Rollback complete.');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  try {
    if (args.includes('down')) {
      const stepsArg = args.find((a) => a.startsWith('--steps='));
      const steps = stepsArg ? parseInt(stepsArg.split('=')[1] ?? '1', 10) : 1;
      await migrateDown(steps);
    } else {
      await migrate();
    }
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
