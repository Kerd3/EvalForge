import { env } from '../config/env.js';
import { HttpError } from '../middleware/error-handler.js';
import {
  cancelEvaluationCampaign,
  createEvaluationCampaign,
  getEvaluationCampaignById,
  getEvaluationCampaignState,
  failEvaluationCampaign
} from '../repositories/evaluations.repository.js';

function ensureProviderConfigured(provider) {
  if (provider === 'openai' && !env.OPENAI_API_KEY) {
    throw new HttpError(400, 'OPENAI_API_KEY is not configured. Use provider "mock" or add your key to .env.');
  }
  if (provider === 'gemini' && !env.GEMINI_API_KEY) {
    throw new HttpError(400, 'GEMINI_API_KEY is not configured. Add your key to .env and restart the API and worker, or use provider "mock".');
  }
}

function resolveModel(provider, suppliedModel) {
  const defaultModels = {
    mock: 'mock-v1',
    openai: env.DEFAULT_OPENAI_MODEL,
    gemini: env.DEFAULT_GEMINI_MODEL
  };
  return suppliedModel ?? defaultModels[provider];
}

export function createEvaluationCampaignService({ enqueue }) {
  return {
    async create(data, ownerId) {
      ensureProviderConfigured(data.provider);
      const campaign = await createEvaluationCampaign({
        datasetId: data.dataset_id,
        datasetVersionId: data.dataset_version_id,
        provider: data.provider,
        model: resolveModel(data.provider, data.model),
        systemPrompt: data.system_prompt,
        repeatCount: data.repeat_count,
        ownerId
      });
      try {
        await enqueue(campaign.id);
      } catch (error) {
        const message = `Could not enqueue evaluation campaign: ${error.message}`;
        await failEvaluationCampaign(campaign.id, message);
        throw new HttpError(503, 'Could not enqueue evaluation campaign. Check that Redis is running.');
      }
      return getEvaluationCampaignById(campaign.id, ownerId);
    },

    async getById(id, ownerId) {
      const campaign = await getEvaluationCampaignById(id, ownerId);
      if (!campaign) throw new HttpError(404, 'Evaluation campaign not found');
      return campaign;
    },

    async cancel(id, ownerId) {
      const campaign = await getEvaluationCampaignState(id, ownerId);
      if (!campaign) throw new HttpError(404, 'Evaluation campaign not found');
      if (['completed', 'failed', 'cancelled'].includes(campaign.status)) {
        throw new HttpError(409, `Cannot cancel a campaign with status "${campaign.status}"`);
      }
      await cancelEvaluationCampaign(id, ownerId);
      return getEvaluationCampaignById(id, ownerId);
    }
  };
}
