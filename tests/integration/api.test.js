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
    })
  };
  const evaluationService = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'queued' }),
    getById: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'completed', results: [] }),
    cancel: vi.fn().mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'cancelled' }),
    compare: vi.fn().mockResolvedValue({ pass_rate_delta_percentage_points: 5 })
  };
  const campaignService = {
    create: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', status: 'queued', repeat_count: 3 }),
    getById: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', status: 'completed', reliability: {} }),
    cancel: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', status: 'cancelled', reliability: {} })
  };
  return { app: createApp({ datasetService, evaluationService, campaignService }), datasetService, evaluationService, campaignService };
}

afterEach(() => vi.restoreAllMocks());

describe('EvalForge API routes', () => {
  it('returns a successful health response', async () => {
    const { app } = makeApp();
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
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
    }));
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


  it('accepts a repeated-run reliability campaign and returns 202', async () => {
    const { app, campaignService } = makeApp();
    const response = await request(app).post('/api/evaluation-campaigns').send({
      dataset_id: '11111111-1111-4111-8111-111111111111', provider: 'mock', repeat_count: 3
    });
    expect(response.status).toBe(202);
    expect(response.body.data.repeat_count).toBe(3);
    expect(campaignService.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mock', repeat_count: 3 }));
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
    expect(evaluationService.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gemini', model: 'gemini-3.8-flash' }));
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
