import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

function makeApp() {
  const datasetService = {
    list: vi.fn().mockResolvedValue([{ id: 'dataset-1', name: 'Example', test_case_count: 1 }]),
    create: vi.fn().mockImplementation(async (data) => ({ id: 'dataset-1', ...data })),
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
  return { app: createApp({ datasetService, evaluationService }), datasetService, evaluationService };
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

  it('accepts a well-formed evaluation request and returns 202', async () => {
    const { app, evaluationService } = makeApp();
    const response = await request(app).post('/api/evaluations').send({
      dataset_id: '11111111-1111-4111-8111-111111111111', provider: 'mock', system_prompt: 'Be accurate'
    });
    expect(response.status).toBe(202);
    expect(response.body.data.status).toBe('queued');
    expect(evaluationService.create).toHaveBeenCalledOnce();
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
