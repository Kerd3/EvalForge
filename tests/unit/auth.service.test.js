import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/pool.js', () => ({
  pool: { connect: vi.fn(), query: vi.fn() }
}));

import { pool } from '../../src/db/pool.js';
import { authService } from '../../src/services/auth.service.js';

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'first@example.com', created_at: new Date('2026-01-01T00:00:00.000Z') };

function setupRegisterClient({ legacyData = false, bootstrapSecret = 'valid-bootstrap-secret' } = {}) {
  let userCountChecks = 0;
  const queries = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql, values = []) => {
      queries.push({ sql: String(sql), values });
      if (String(sql).includes('SELECT COUNT(*)::int AS count FROM users')) {
        userCountChecks += 1;
        return { rows: [{ count: userCountChecks === 1 ? 0 : 1 }] };
      }
      if (String(sql).includes('has_unowned_data')) return { rows: [{ has_unowned_data: legacyData }] };
      if (String(sql).includes('INSERT INTO users')) return { rows: [USER] };
      return { rows: [], rowCount: 1 };
    })
  };
  pool.connect.mockResolvedValue(client);
  vi.stubEnv('EVALFORGE_REGISTRATION_ENABLED', 'true');
  vi.stubEnv('EVALFORGE_BOOTSTRAP_SECRET', bootstrapSecret);
  return { client, queries };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe('authService initial account setup', () => {
  it('requires the bootstrap secret when claiming unowned v1.0 data', async () => {
    const { client, queries } = setupRegisterClient({ legacyData: true });
    await expect(authService.register({ email: USER.email, password: 'correct-horse-battery-staple', bootstrap_secret: 'wrong-secret' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(queries.some((query) => query.sql.includes('INSERT INTO users'))).toBe(false);
    expect(queries.some((query) => query.sql.startsWith('ROLLBACK'))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('creates a session and claims legacy rows after the correct bootstrap secret', async () => {
    const { client, queries } = setupRegisterClient({ legacyData: true });
    const result = await authService.register({
      email: ' FIRST@EXAMPLE.COM ',
      password: 'correct-horse-battery-staple',
      bootstrap_secret: 'valid-bootstrap-secret'
    });

    expect(result.user.id).toBe(USER.id);
    expect(result.user.email).toBe('first@example.com');
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const sessionInsert = queries.find((query) => query.sql.includes('INSERT INTO auth_sessions'));
    expect(sessionInsert).toBeDefined();
    expect(sessionInsert.values[0]).not.toBe(result.sessionToken);
    expect(sessionInsert.values[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(queries.some((query) => query.sql.includes('UPDATE datasets SET owner_id'))).toBe(true);
    expect(queries.some((query) => query.sql.includes('UPDATE evaluation_runs SET owner_id'))).toBe(true);
    expect(queries.some((query) => query.sql.includes('UPDATE evaluation_campaigns SET owner_id'))).toBe(true);
    expect(queries.some((query) => query.sql.startsWith('COMMIT'))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('refuses registration when disabled', async () => {
    vi.stubEnv('EVALFORGE_REGISTRATION_ENABLED', 'false');
    await expect(authService.register({ email: USER.email, password: 'correct-horse-battery-staple' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
