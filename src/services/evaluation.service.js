import { env } from '../config/env.js';
import { HttpError } from '../middleware/error-handler.js';
import {
  compareEvaluationRuns,
  createEvaluationRun,
  getEvaluationById,
  getEvaluationWithResults,
  listEvaluations,
  updateRunStatus
} from '../repositories/evaluations.repository.js';

export function createEvaluationService({ enqueue }) {
  return {
    async create(data) {
      if (data.provider === 'openai' && !env.OPENAI_API_KEY) {
        throw new HttpError(400, 'OPENAI_API_KEY is not configured. Use provider "mock" or add your key to .env.');
      }
      if (data.provider === 'gemini' && !env.GEMINI_API_KEY) {
        throw new HttpError(400, 'GEMINI_API_KEY is not configured. Add your key to .env and restart the API and worker, or use provider "mock".');
      }
      const defaultModels = {
        mock: 'mock-v1',
        openai: env.DEFAULT_OPENAI_MODEL,
        gemini: env.DEFAULT_GEMINI_MODEL
      };
      const run = await createEvaluationRun({
        datasetId: data.dataset_id,
        datasetVersionId: data.dataset_version_id,
        provider: data.provider,
        model: data.model ?? defaultModels[data.provider],
        systemPrompt: data.system_prompt
      });
      try {
        await enqueue(run.id);
      } catch (error) {
        await updateRunStatus(run.id, 'failed', `Could not enqueue evaluation: ${error.message}`);
        throw new HttpError(503, 'Could not enqueue evaluation. Check that Redis is running.');
      }
      return getEvaluationById(run.id);
    },
    async list(limit = 50) {
      return listEvaluations(limit);
    },
    async getById(id) {
      const run = await getEvaluationWithResults(id);
      if (!run) throw new HttpError(404, 'Evaluation run not found');
      return run;
    },
    async cancel(id) {
      const run = await getEvaluationById(id);
      if (!run) throw new HttpError(404, 'Evaluation run not found');
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        throw new HttpError(409, `Cannot cancel a run with status "${run.status}"`);
      }
      await updateRunStatus(id, 'cancelled');
      return getEvaluationById(id);
    },
    compare(baselineId, candidateId) {
      return compareEvaluationRuns(baselineId, candidateId);
    }
  };
}
