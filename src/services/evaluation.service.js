import { env } from '../config/env.js';
import { HttpError } from '../middleware/error-handler.js';
import {
  compareEvaluationRuns,
  createRecordedEvaluationRun,
  createEvaluationRun,
  getEvaluationById,
  getEvaluationWithResults,
  listEvaluations,
  updateRunStatus
} from '../repositories/evaluations.repository.js';
import { gradeCase } from './grading.service.js';
import { validateAgentTrace } from './agent-trace.service.js';

export function createEvaluationService({ enqueue }) {
  return {
    async create(data, ownerId) {
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
        systemPrompt: data.system_prompt,
        ownerId
      });
      try {
        await enqueue(run.id);
      } catch (error) {
        await updateRunStatus(run.id, 'failed', `Could not enqueue evaluation: ${error.message}`);
        throw new HttpError(503, 'Could not enqueue evaluation. Check that Redis is running.');
      }
      return getEvaluationById(run.id, ownerId);
    },
    async createRecorded(data, ownerId) {
      // Reject oversized nested trace payloads even when called outside Express' body parser.
      let serialized;
      try { serialized = JSON.stringify(data); } catch { throw new HttpError(400, 'Recorded payload must be JSON serializable'); }
      if (Buffer.byteLength(serialized, 'utf8') > 900_000) throw new HttpError(413, 'Recorded payload exceeds the 900 KB limit');
      return createRecordedEvaluationRun({
        datasetVersionId: data.dataset_version_id,
        source: data.source,
        model: data.model,
        responses: data.responses,
        ownerId,
        gradeResponse: gradeCase,
        validateTrace: validateAgentTrace
      });
    },
    async list(limit = 50, ownerId) {
      return listEvaluations(limit, ownerId);
    },
    async getById(id, ownerId) {
      const run = await getEvaluationWithResults(id, ownerId);
      if (!run) throw new HttpError(404, 'Evaluation run not found');
      return run;
    },
    async cancel(id, ownerId) {
      const run = await getEvaluationById(id, ownerId);
      if (!run) throw new HttpError(404, 'Evaluation run not found');
      if (['completed', 'failed', 'cancelled'].includes(run.status)) {
        throw new HttpError(409, `Cannot cancel a run with status "${run.status}"`);
      }
      await updateRunStatus(id, 'cancelled', null, ownerId);
      return getEvaluationById(id, ownerId);
    },
    compare(baselineId, candidateId, ownerId) {
      return compareEvaluationRuns(baselineId, candidateId, ownerId);
    }
  };
}
