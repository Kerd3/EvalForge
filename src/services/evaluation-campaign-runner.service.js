import {
  getEvaluationCampaignRunIds,
  getEvaluationCampaignState,
  getEvaluationById,
  updateEvaluationCampaignStatus
} from '../repositories/evaluations.repository.js';
import { processEvaluationRun } from './evaluation-runner.service.js';

/**
 * Process campaign repetitions sequentially so repeats stay ordered and do not
 * intentionally increase provider request concurrency. Individual runs retain
 * their normal per-case checkpoints, which makes a retried campaign resumable.
 */
export async function processEvaluationCampaign(campaignId) {
  const campaign = await getEvaluationCampaignState(campaignId);
  if (!campaign) throw new Error(`Evaluation campaign ${campaignId} was not found`);
  if (campaign.status === 'cancelled') return;

  await updateEvaluationCampaignStatus(campaignId, 'running');
  const afterStart = await getEvaluationCampaignState(campaignId);
  if (!afterStart || afterStart.status === 'cancelled') return;
  const runIds = await getEvaluationCampaignRunIds(campaignId);
  if (runIds.length !== Number(campaign.repeat_count)) {
    throw new Error(`Campaign ${campaignId} expected ${campaign.repeat_count} runs but found ${runIds.length}`);
  }

  for (const runId of runIds) {
    const currentCampaign = await getEvaluationCampaignState(campaignId);
    if (!currentCampaign || currentCampaign.status === 'cancelled') return;

    const run = await getEvaluationById(runId);
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) continue;
    await processEvaluationRun(runId);
  }

  const finalCampaign = await getEvaluationCampaignState(campaignId);
  if (finalCampaign && finalCampaign.status !== 'cancelled') {
    // `completed` means the planned repetitions were processed; individual runs
    // can still contain failed cases or terminal execution errors.
    await updateEvaluationCampaignStatus(campaignId, 'completed');
  }
}
