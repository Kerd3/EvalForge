import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

function makeApp() {
  const datasetService = {
    list: vi.fn().mockResolvedValue([{ id: 'dataset-1', name: 'Example', test_case_count: 1 }]),
    create: vi.fn().mockImplementation(async (data) => ({ id: 'dataset-1', ...data })),
    createVersion: vi.fn().mockImplementation(async (id, data) => ({
      id, ...data, latest_version_id: '33333333-3333-4333-8333-333333333333', latest_version: 2,
      versions: [{ id: '33333333-3333-4333-8333-333333333333', version_number: 2 }]
    })),
    getById: vi.fn().mockImplementation(async (id) => {
      if (id === 'missing') { const error = new Error('Dataset not found'); error.statusCode = 404; throw error; }
      return { id, name: 'Example' };
    }),
    calibrate: vi.fn().mockResolvedValue({ schema_version: 'evalforge.grader-calibration/v1', summary: { golden_examples: 1, evaluated_examples: 1, accuracy: 1 } })
  };
  const evaluationService = {
    list: vi.fn().mockResolvedValue({ items: [], hasMore: false, nextCursor: null }),
    create: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'queued' }),
    createRecorded: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'completed', provider: 'recorded' }),
    getById: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'completed', results: [] }),
    cancel: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'cancelled' }),
    compare: vi.fn().mockResolvedValue({ pass_rate_delta_percentage_points: 5 })
  };
  const campaignService = {
    create: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', status: 'queued', repeat_count: 3 }),
    getById: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', status: 'completed', reliability: {} }),
    cancel: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', status: 'cancelled', reliability: {} })
  };
  const authMiddleware = (req, res, next) => {
    req.user = { id: '11111111-1111-4111-8111-111111111111', email: 'test@example.com' };
    next();
  };
  return { app: createApp({ datasetService, evaluationService, campaignService, authMiddleware }), datasetService, evaluationService, campaignService };
}

afterEach(() => vi.restoreAllMocks());

describe('EvalForge API routes', () => {
  it('returns a successful health response', async () => {
    const { app } = makeApp();
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
  });

  it('validates run pagination and forwards an opaque cursor', async () => {
    const { app, evaluationService } = makeApp();
    const cursor = Buffer.from(JSON.stringify({ createdAt: '2026-10-17T00:00:00.000Z', id: '11111111-1111-4111-8111-111111111111' })).toString('base64url');
    evaluationService.list.mockResolvedValueOnce({ items: [{ id: 'run-2' }], hasMore: true, nextCursor: { createdAt: '2026-10-16T00:00:00.000Z', id: '22222222-2222-4222-8222-222222222222' } });
    const response = await request(app).get(`/api/evaluations?limit=1&cursor=${cursor}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 'run-2' }]);
    expect(response.body.pagination.has_more).toBe(true);
    expect(evaluationService.list).toHaveBeenCalledWith(1, '11111111-1111-4111-8111-111111111111', {
      createdAt: '2026-10-17T00:00:00.000Z', id: '11111111-1111-4111-8111-111111111111'
    });
    const nextCursor = JSON.parse(Buffer.from(response.body.pagination.next_cursor, 'base64url').toString('utf8'));
    expect(nextCursor).toEqual({ createdAt: '2026-10-16T00:00:00.000Z', id: '22222222-2222-4222-8222-222222222222' });
  });

  it('rejects malformed run cursors and limits outside the supported range', async () => {
    const { app, evaluationService } = makeApp();
    expect((await request(app).get('/api/evaluations?cursor=%%%')).status).toBe(400);
    expect((await request(app).get('/api/evaluations?limit=101')).status).toBe(400);
    expect(evaluationService.list).not.toHaveBeenCalled();
  });

  it('exposes operational metrics only to authenticated users', async () => {
    const { app } = makeApp();
    const response = await request(app).get('/api/ops/metrics');
    expect(response.status).toBe(200);
    expect(response.body.data.processUptimeSeconds).toEqual(expect.any(Number));
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('lists datasets', async () => {
    const { app } = makeApp();
    const response = await request(app).get('/api/datasets');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });

  it('rejects a dataset without test cases', async () => {
    const { app, datasetService } = makeApp();
    const response = await request(app).post('/api/datasets').send({ name: 'Empty dataset', test_cases: [] });
    expect(response.status).toBe(400);
    expect(datasetService.create).not.toHaveBeenCalled();
  });

  it('saves dataset edits as a new version through PUT /api/datasets/:id', async () => {
    const { app, datasetService } = makeApp();
    const datasetId = '11111111-1111-4111-8111-111111111111';
    const response = await request(app).put(`/api/datasets/${datasetId}`).send({
      name: 'Corrected failure detection',
      description: 'Updated grading rules and policy context',
      test_cases: [{
        name: 'Abstains when evidence is missing',
        input: { message: 'What is the policy?', context: 'No policy was supplied.' },
        grading_rules: { mustAbstain: true }
      }]
    });

    expect(response.status).toBe(200);
    expect(response.body.data.latest_version).toBe(2);
    expect(response.body.data.test_cases).toHaveLength(1);
    expect(datasetService.createVersion).toHaveBeenCalledWith(datasetId, expect.objectContaining({
      name: 'Corrected failure detection',
      test_cases: [expect.objectContaining({
        name: 'Abstains when evidence is missing',
        required_keywords: [], forbidden_keywords: [], required_tools: [], forbidden_tools: [], tools: [],
        grading_rules: { mustAbstain: true }
      })]
    }), '11111111-1111-4111-8111-111111111111');
  });

  it('accepts versioned labeled golden examples and explicit semantic equivalents', async () => {
    const { app, datasetService } = makeApp();
    const response = await request(app).post('/api/datasets').send({
      name: 'Calibration set',
      test_cases: [{
        input: 'What is the status?',
        expected_output: 'Approved',
        grading_rules: { exactMatch: true, semanticEquivalents: ['Request approved'] },
        golden_examples: [{
          label: 'correct',
          response: { content: 'Request approved', toolCalls: [] },
          expected_passed: true,
          rationale: 'Explicitly accepted equivalent phrase'
        }]
      }]
    });
    expect(response.status).toBe(201);
    expect(datasetService.create).toHaveBeenCalledWith(expect.objectContaining({
      test_cases: [expect.objectContaining({
        golden_examples: [expect.objectContaining({ label: 'correct', expected_passed: true })],
        grading_rules: expect.objectContaining({ semanticEquivalents: ['Request approved'] })
      })]
    }), '11111111-1111-4111-8111-111111111111');
  });

  it('returns a dataset calibration report for the authenticated owner', async () => {
    const { app, datasetService } = makeApp();
    const datasetId = '11111111-1111-4111-8111-111111111111';
    const response = await request(app).get(`/api/datasets/${datasetId}/calibration`);
    expect(response.status).toBe(200);
    expect(response.body.data.schema_version).toBe('evalforge.grader-calibration/v1');
    expect(datasetService.calibrate).toHaveBeenCalledWith(datasetId, '11111111-1111-4111-8111-111111111111');
  });

  it('passes an explicit version_id to calibration and rejects a malformed one', async () => {
    const { app, datasetService } = makeApp();
    const datasetId = '11111111-1111-4111-8111-111111111111';
    const versionId = '44444444-4444-4444-8444-444444444444';
    const ok = await request(app).get(`/api/datasets/${datasetId}/calibration?version_id=${versionId}`);
    expect(ok.status).toBe(200);
    expect(datasetService.calibrate).toHaveBeenCalledWith(datasetId, '11111111-1111-4111-8111-111111111111', versionId);
    datasetService.calibrate.mockClear();
    const bad = await request(app).get(`/api/datasets/${datasetId}/calibration?version_id=not-a-uuid`);
    expect(bad.status).toBe(400);
    expect(datasetService.calibrate).not.toHaveBeenCalled();
  });

  it('rejects invalid dataset edits before calling the service', async () => {
    const { app, datasetService } = makeApp();
    const response = await request(app).put('/api/datasets/11111111-1111-4111-8111-111111111111').send({
      name: 'Invalid dataset', test_cases: []
    });
    expect(response.status).toBe(400);
    expect(datasetService.createVersion).not.toHaveBeenCalled();
  });

  it('rejects dataset edits with an invalid dataset id', async () => {
    const { app, datasetService } = makeApp();
    const response = await request(app).put('/api/datasets/not-a-uuid').send({
      name: 'Example', test_cases: [{ input: 'hello' }]
    });
    expect(response.status).toBe(400);
    expect(datasetService.createVersion).not.toHaveBeenCalled();
  });

  it('accepts a well-formed evaluation request and returns 202', async () => {
    const { app, evaluationService } = makeApp();
    const response = await request(app).post('/api/evaluations').send({
      dataset_id: '11111111-1111-4111-8111-111111111111', provider: 'mock', system_prompt: 'Be accurate'
    });
    expect(response.status).toBe(202);
    expect(response.body.data.status).toBe('queued');
    expect(evaluationService.create).toHaveBeenCalledOnce();
  });

  it('cancels a run through the owner-scoped service', async () => {
    const { app, evaluationService } = makeApp();
    const runId = '11111111-1111-4111-8111-111111111111';
    const response = await request(app).post(`/api/evaluations/${runId}/cancel`).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('cancelled');
    expect(evaluationService.cancel).toHaveBeenCalledWith(runId, '11111111-1111-4111-8111-111111111111');
  });

  it('accepts recorded evaluations and forwards the authenticated owner without queueing generation', async () => {
    const { app, evaluationService } = makeApp();
    const versionId = '22222222-2222-4222-8222-222222222222';
    const caseId = '33333333-3333-4333-8333-333333333333';
    const response = await request(app).post('/api/evaluations/recorded').send({
      dataset_version_id: versionId, source: 'support-agent', model: 'agent-v2',
      responses: [{ test_case_id: caseId, response: {
        content: 'Found the answer.', toolCalls: [],
        agentTrace: { schemaVersion: 'evalforge.agent-trace/v1', retrievalResults: [], citations: [], proposedToolCalls: [], executedToolResults: [], intermediateSteps: [] }
      } }]
    });
    expect(response.status).toBe(201);
    expect(response.body.data.provider).toBe('recorded');
    expect(evaluationService.createRecorded).toHaveBeenCalledWith(expect.objectContaining({ dataset_version_id: versionId }), '11111111-1111-4111-8111-111111111111');
    expect(evaluationService.create).not.toHaveBeenCalled();
  });

  it('rejects recorded responses without a trace before calling the service', async () => {
    const { app, evaluationService } = makeApp();
    const response = await request(app).post('/api/evaluations/recorded').send({
      dataset_version_id: '22222222-2222-4222-8222-222222222222', source: 'agent', model: 'v1',
      responses: [{ test_case_id: '33333333-3333-4333-8333-333333333333', response: { content: 'answer' } }]
    });
    expect(response.status).toBe(400);
    expect(evaluationService.createRecorded).not.toHaveBeenCalled();
  });


  it('accepts a repeated-run reliability campaign and returns 202', async () => {
    const { app, campaignService } = makeApp();
    const response = await request(app).post('/api/evaluation-campaigns').send({
      dataset_id: '11111111-1111-4111-8111-111111111111', provider: 'mock', repeat_count: 3
    });
    expect(response.status).toBe(202);
    expect(response.body.data.repeat_count).toBe(3);
    expect(campaignService.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mock', repeat_count: 3 }), '11111111-1111-4111-8111-111111111111');
  });

  it('rejects campaign repetition counts outside 2 through 10', async () => {
    const { app, campaignService } = makeApp();
    const response = await request(app).post('/api/evaluation-campaigns').send({
      dataset_id: '11111111-1111-4111-8111-111111111111', provider: 'mock', repeat_count: 11
    });
    expect(response.status).toBe(400);
    expect(campaignService.create).not.toHaveBeenCalled();
  });

  it('accepts Gemini as a supported provider', async () => {
    const { app, evaluationService } = makeApp();
    const response = await request(app).post('/api/evaluations').send({
      dataset_id: '11111111-1111-4111-8111-111111111111', provider: 'gemini', model: 'gemini-3.8-flash'
    });
    expect(response.status).toBe(202);
    expect(evaluationService.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gemini', model: 'gemini-3.8-flash' }), '11111111-1111-4111-8111-111111111111');
  });

  it('rejects an evaluation request without a dataset identifier', async () => {
    const { app, evaluationService } = makeApp();
    const response = await request(app).post('/api/evaluations').send({ provider: 'mock' });
    expect(response.status).toBe(400);
    expect(evaluationService.create).not.toHaveBeenCalled();
  });

  it('returns JSON for unknown routes', async () => {
    const { app } = makeApp();
    const response = await request(app).get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.message).toContain('Route not found');
  });
});
