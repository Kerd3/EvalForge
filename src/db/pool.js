import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (error) => {
  console.error(JSON.stringify({ level: 'error', message: 'Unexpected idle PostgreSQL client error', error: error.message }));
});

export async function closePool() {
  await pool.end();
}
