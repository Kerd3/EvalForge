import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from '../src/db/pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(here, '../database/migrations/001_initial.sql');

try {
  const sql = await readFile(migrationPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(version) VALUES ('001_initial') ON CONFLICT (version) DO NOTHING");
    await client.query('COMMIT');
    console.log('Database migrations are up to date.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
