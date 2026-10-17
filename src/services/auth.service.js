import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../security/passwords.js';
import { HttpError } from '../middleware/error-handler.js';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const LEGACY_CLAIM_LOCK_ID = 781_104_215;
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const publicUser = (row) => ({ id: row.id, email: row.email, created_at: row.created_at });

function registrationEnabled() {
  if (process.env.EVALFORGE_REGISTRATION_ENABLED !== undefined) {
    return process.env.EVALFORGE_REGISTRATION_ENABLED.trim().toLowerCase() === 'true';
  }
  // Local Compose is intended for a local owner account. Production instances
  // must explicitly opt into public registration.
  return process.env.NODE_ENV !== 'production';
}

function createRawSessionToken() {
  return randomBytes(32).toString('base64url');
}

async function insertSession(client, userId) {
  const token = createRawSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await client.query(
    'INSERT INTO auth_sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [tokenHash(token), userId, expiresAt]
  );
  // Only the hash is stored. The raw bearer token is returned once for the
  // HttpOnly cookie and cannot be recovered from the database.
  return { token, expiresAt };
}

async function claimLegacyDataForFirstUser(client, userId, usersBeforeInsert) {
  if (Number(usersBeforeInsert) !== 0) return;
  // A transaction-scoped advisory lock serializes simultaneous first-account
  // registrations so only one account can claim unowned legacy records.
  await client.query('SELECT pg_advisory_xact_lock($1)', [LEGACY_CLAIM_LOCK_ID]);
  const count = await client.query('SELECT COUNT(*)::int AS count FROM users');
  if (Number(count.rows[0]?.count) !== 1) return;

  await client.query('UPDATE datasets SET owner_id = $1 WHERE owner_id IS NULL', [userId]);
  await client.query('UPDATE evaluation_runs SET owner_id = $1 WHERE owner_id IS NULL', [userId]);
  await client.query('UPDATE evaluation_campaigns SET owner_id = $1 WHERE owner_id IS NULL', [userId]);
}

export const authService = {
  async register({ email, password, bootstrap_secret: bootstrapSecret }) {
    if (!registrationEnabled()) throw new HttpError(403, 'Registration is disabled on this instance.');
    const normalizedEmail = normalizeEmail(email);
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LEGACY_CLAIM_LOCK_ID]);
      const countResult = await client.query('SELECT COUNT(*)::int AS count FROM users');
      const usersBeforeInsert = Number(countResult.rows[0]?.count ?? 0);
      if (usersBeforeInsert === 0) {
        const legacy = await client.query(`
          SELECT (
            EXISTS (SELECT 1 FROM datasets WHERE owner_id IS NULL) OR
            EXISTS (SELECT 1 FROM evaluation_runs WHERE owner_id IS NULL) OR
            EXISTS (SELECT 1 FROM evaluation_campaigns WHERE owner_id IS NULL)
          ) AS has_unowned_data
        `);
        const configuredBootstrapSecret = String(process.env.EVALFORGE_BOOTSTRAP_SECRET ?? '');
        if (legacy.rows[0]?.has_unowned_data && (!configuredBootstrapSecret || bootstrapSecret !== configuredBootstrapSecret)) {
          throw new HttpError(403, 'First-account setup requires the bootstrap secret. Set EVALFORGE_BOOTSTRAP_SECRET in .env and enter it when creating the first account.');
        }
      }
      const inserted = await client.query(
        'INSERT INTO users(id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, created_at',
        [randomUUID(), normalizedEmail, passwordHash]
      );
      const user = inserted.rows[0];
      await claimLegacyDataForFirstUser(client, user.id, usersBeforeInsert);
      await client.query('DELETE FROM auth_sessions WHERE expires_at <= NOW()');
      const session = await insertSession(client, user.id);
      await client.query('COMMIT');
      return { user: publicUser(user), sessionToken: session.token, expiresAt: session.expiresAt };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') throw new HttpError(409, 'An account with this email already exists.');
      throw error;
    } finally {
      client.release();
    }
  },

  async login({ email, password }) {
    const normalizedEmail = normalizeEmail(email);
    const { rows } = await pool.query(
      'SELECT id, email, password_hash, created_at FROM users WHERE email = $1 LIMIT 1', [normalizedEmail]
    );
    const user = rows[0];
    const valid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!valid) throw new HttpError(401, 'Invalid email or password.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM auth_sessions WHERE expires_at <= NOW()');
      const session = await insertSession(client, user.id);
      await client.query('COMMIT');
      return { user: publicUser(user), sessionToken: session.token, expiresAt: session.expiresAt };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async logout(rawToken) {
    if (rawToken) await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(rawToken)]);
  },

  async getSessionUser(rawToken) {
    if (!rawToken || rawToken.length > 256) return null;
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.created_at, s.expires_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() LIMIT 1`, [tokenHash(rawToken)]
    );
    if (!rows[0]) {
      await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1 AND expires_at <= NOW()', [tokenHash(rawToken)]);
      return null;
    }
    return publicUser(rows[0]);
  },

  async registrationIsEnabled() {
    return registrationEnabled();
  },

  async bootstrapRequired() {
    const { rows } = await pool.query(`
      SELECT (NOT EXISTS (SELECT 1 FROM users)) AND (
        EXISTS (SELECT 1 FROM datasets WHERE owner_id IS NULL) OR
        EXISTS (SELECT 1 FROM evaluation_runs WHERE owner_id IS NULL) OR
        EXISTS (SELECT 1 FROM evaluation_campaigns WHERE owner_id IS NULL)
      ) AS required
    `);
    return Boolean(rows[0]?.required);
  }
};

export { SESSION_TTL_SECONDS };
