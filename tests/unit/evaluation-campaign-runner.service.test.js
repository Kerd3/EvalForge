import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEvaluationCampaignRunIds: vi.fn(),
  getEvaluationCampaignState: vi.fn(),
  getEvaluationById: vi.fn(),
  updateEvaluationCampaignStatus: vi.fn(),
  processEvaluationRun: vi.fn()
}));

vi.mock('../../src/repositories/evaluations.repository.js', () => ({
  getEvaluationCampaignRunIds: mocks.getEvaluationCampaignRunIds,
  getEvaluationCampaignState: mocks.getEvaluationCampaignState,
  getEvaluationById: mocks.getEvaluationById,
  updateEvaluationCampaignStatus: mocks.updateEvaluationCampaignStatus
}));
vi.mock('../../src/services/evaluation-runner.service.js', () => ({
  processEvaluationRun: mocks.processEvaluationRun
}));

import { processEvaluationCampaign } from '../../src/services/evaluation-campaign-runner.service.js';

const campaign = { id: 'campaign-1', repeat_count: 2, status: 'running' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEvaluationCampaignState.mockResolvedValue(campaign);
  mocks.getEvaluationCampaignRunIds.mockResolvedValue(['run-1', 'run-2']);
  mocks.getEvaluationById.mockImplementation(async (id) => ({ id, status: 'queued' }));
  mocks.updateEvaluationCampaignStatus.mockResolvedValue(undefined);
  mocks.processEvaluationRun.mockResolvedValue(undefined);
});

describe('processEvaluationCampaign', () => {
  it('processes child runs sequentially and marks the campaign completed', async () => {
    const order = [];
    mocks.processEvaluationRun.mockImplementation(async (runId) => {
      order.push(`start-${runId}`);
      await Promise.resolve();
      order.push(`end-${runId}`);
    });

    await processEvaluationCampaign('campaign-1');

    expect(order).toEqual(['start-run-1', 'end-run-1', 'start-run-2', 'end-run-2']);
    expect(mocks.updateEvaluationCampaignStatus).toHaveBeenCalledWith('campaign-1', 'running');
    expect(mocks.updateEvaluationCampaignStatus).toHaveBeenLastCalledWith('campaign-1', 'completed');
  });

  it('does not start repetitions after a campaign is cancelled', async () => {
    mocks.getEvaluationCampaignState
      .mockResolvedValueOnce({ ...campaign, status: 'queued' })
      .mockResolvedValueOnce({ ...campaign, status: 'running' })
      .mockResolvedValueOnce({ ...campaign, status: 'cancelled' });

    await processEvaluationCampaign('campaign-1');

    expect(mocks.processEvaluationRun).not.toHaveBeenCalled();
    expect(mocks.updateEvaluationCampaignStatus).toHaveBeenCalledTimes(1);
    expect(mocks.updateEvaluationCampaignStatus).toHaveBeenCalledWith('campaign-1', 'running');
  });

  it('rejects a campaign whose stored child-run count does not match its repeat count', async () => {
    mocks.getEvaluationCampaignRunIds.mockResolvedValue(['run-1']);

    await expect(processEvaluationCampaign('campaign-1')).rejects.toThrow('expected 2 runs but found 1');
  });
});
