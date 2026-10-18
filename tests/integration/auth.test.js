import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function makeApp() {
  const datasetService = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation(async (data, ownerId) => ({ id: 'dataset-a', ...data, owner_id: ownerId })),
    createVersion: vi.fn(),
    getById: vi.fn()
  };
  const evaluationService = { list: vi.fn().mockResolvedValue([]), create: vi.fn(), getById: vi.fn(), cancel: vi.fn(), compare: vi.fn() };
  const campaignService = { create: vi.fn(), getById: vi.fn(), cancel: vi.fn() };
  const authService = {
    registrationIsEnabled: vi.fn().mockResolvedValue(true),
    bootstrapRequired: vi.fn().mockResolvedValue(true),
    register: vi.fn().mockResolvedValue({
      user: { id: USER_A, email: 'a@example.com' },
      sessionToken: 'opaque-test-token', expiresAt: new Date(Date.now() + 60_000).toISOString()
    }),
    login: vi.fn().mockResolvedValue({
      user: { id: USER_A, email: 'a@example.com' },
      sessionToken: 'opaque-test-token', expiresAt: new Date(Date.now() + 60_000).toISOString()
    }),
    logout: vi.fn().mockResolvedValue(undefined)
  };
  const authMiddleware = (req, res, next) => {
    const id = req.get('x-test-user-id');
    req.user = id ? { id, email: id === USER_A ? 'a@example.com' : 'b@example.com' } : null;
    req.sessionToken = req.get('x-test-session') ?? null;
    next();
  };
  const app = createApp({ datasetService, evaluationService, campaignService, authService, authMiddleware });
  return { app, datasetService, evaluationService, campaignService, authService };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('account authentication and resource route guards', () => {
  it('ignores forwarded IP headers unless a trusted proxy hop count is configured', () => {
    const { app } = makeApp();
    expect(app.get('trust proxy')).toBe(0);

    const trustedApp = createApp({
      datasetService: {}, evaluationService: {}, authService: {}, trustProxyHops: 1
    });
    expect(trustedApp.get('trust proxy')).toBe(1);
  });

  it('does not trust client identity headers in the production middleware path', async () => {
    const datasetService = { list: vi.fn().mockResolvedValue([]) };
    const app = createApp({
      datasetService,
      evaluationService: {},
      authService: { getSessionUser: vi.fn().mockResolvedValue(null) }
    });
    const response = await request(app).get('/api/datasets').set('x-test-user-id', USER_A);
    expect(response.status).toBe(401);
    expect(datasetService.list).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests to user resources', async () => {
    const { app, datasetService } = makeApp();
    const response = await request(app).get('/api/datasets');
    expect(response.status).toBe(401);
    expect(datasetService.list).not.toHaveBeenCalled();
  });

  it('passes the authenticated user ID into dataset ownership services', async () => {
    const { app, datasetService } = makeApp();
    const response = await request(app).get('/api/datasets').set('x-test-user-id', USER_B);
    expect(response.status).toBe(200);
    expect(datasetService.list).toHaveBeenCalledWith(USER_B);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const { app, datasetService } = makeApp();
    const response = await request(app)
      .post('/api/datasets')
      .set('Origin', 'https://attacker.example')
      .set('x-test-user-id', USER_A)
      .send({ name: 'Should not be created', test_cases: [{ input: 'hello' }] });
    expect(response.status).toBe(403);
    expect(datasetService.create).not.toHaveBeenCalled();
  });

  it('passes the authenticated owner into evaluation creation', async () => {
    const { app, evaluationService } = makeApp();
    const response = await request(app)
      .post('/api/evaluations')
      .set('x-test-user-id', USER_B)
      .send({ dataset_id: '33333333-3333-4333-8333-333333333333', provider: 'mock' });
    expect(response.status).toBe(202);
    expect(evaluationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ dataset_id: '33333333-3333-4333-8333-333333333333', provider: 'mock' }), USER_B
    );
  });

  it('passes the authenticated owner into campaign creation', async () => {
    const { app, campaignService } = makeApp();
    const response = await request(app)
      .post('/api/evaluation-campaigns')
      .set('x-test-user-id', USER_B)
      .send({ dataset_id: '33333333-3333-4333-8333-333333333333', provider: 'mock', repeat_count: 3 });
    expect(response.status).toBe(202);
    expect(campaignService.create).toHaveBeenCalledWith(
      expect.objectContaining({ dataset_id: '33333333-3333-4333-8333-333333333333', provider: 'mock', repeat_count: 3 }), USER_B
    );
  });

  it('validates registration payloads before creating an account', async () => {
    const { app, authService } = makeApp();
    const response = await request(app).post('/api/auth/register').send({ email: 'a@example.com', password: 'short' });
    expect(response.status).toBe(400);
    expect(authService.register).not.toHaveBeenCalled();
  });

  it('sets a Secure, HttpOnly, SameSite=Lax cookie when secure cookies are enabled', async () => {
    vi.stubEnv('AUTH_COOKIE_SECURE', 'true');
    const { app, authService } = makeApp();
    const response = await request(app).post('/api/auth/register').send({ email: 'a@example.com', password: 'a-long-test-password', bootstrap_secret: 'test-bootstrap-secret' });
    expect(response.status).toBe(201);
    expect(response.body.data.user.email).toBe('a@example.com');
    expect(response.headers['set-cookie'][0]).toContain('Secure');
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(response.headers['set-cookie'][0]).toContain('evalforge_session=opaque-test-token');
    expect(JSON.stringify(response.body)).not.toContain('opaque-test-token');
    expect(authService.register).toHaveBeenCalledOnce();
  });

  it('destroys the server-side session and expires the cookie on logout', async () => {
    vi.stubEnv('AUTH_COOKIE_SECURE', 'true');
    const { app, authService } = makeApp();
    const response = await request(app).post('/api/auth/logout').set('x-test-session', 'opaque-test-token');
    expect(response.status).toBe(200);
    expect(authService.logout).toHaveBeenCalledWith('opaque-test-token');
    expect(response.headers['set-cookie'][0]).toContain('Max-Age=0');
    expect(response.headers['set-cookie'][0]).toContain('Secure');
  });
});
