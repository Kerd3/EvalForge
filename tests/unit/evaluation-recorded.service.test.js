import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  createRecordedEvaluationRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'completed' }),
  compareEvaluationRuns: vi.fn(), createEvaluationRun: vi.fn(), getEvaluationById: vi.fn(),
  getEvaluationWithResults: vi.fn(), listEvaluations: vi.fn(), updateRunStatus: vi.fn()
}));
vi.mock('../../src/repositories/evaluations.repository.js', () => repository);

import { createEvaluationService } from '../../src/services/evaluation.service.js';

describe('recorded evaluation service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps the public dataset_version_id to the repository argument and never enqueues generation', async () => {
    const enqueue = vi.fn();
    const service = createEvaluationService({ enqueue });
    const payload = {
      dataset_version_id: '11111111-1111-4111-8111-111111111111',
      source: 'external-rag', model: 'agent-v2',
      responses: [{ test_case_id: '22222222-2222-4222-8222-222222222222', response: {
        content: 'Answer', toolCalls: [],
        agentTrace: { schemaVersion: 'evalforge.agent-trace/v1', retrievalResults: [], citations: [], proposedToolCalls: [], executedToolResults: [], intermediateSteps: [] }
      } }]
    };
    await service.createRecorded(payload, '33333333-3333-4333-8333-333333333333');
    expect(repository.createRecordedEvaluationRun).toHaveBeenCalledWith(expect.objectContaining({
      datasetVersionId: payload.dataset_version_id,
      source: payload.source,
      model: payload.model,
      responses: payload.responses,
      ownerId: '33333333-3333-4333-8333-333333333333'
    }));
    expect(enqueue).not.toHaveBeenCalled();
  });
});
