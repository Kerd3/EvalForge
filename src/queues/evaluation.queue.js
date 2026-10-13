import { Queue } from 'bullmq';
import { createRedisConnection } from '../db/redis.js';
import { env } from '../config/env.js';
import { EVALUATION_QUEUE_NAME } from './constants.js';
export { EVALUATION_QUEUE_NAME } from './constants.js';
const queueConnection = createRedisConnection();

export const evaluationQueue = new Queue(EVALUATION_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: env.EVAL_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 }
  }
});

export async function enqueueEvaluation(runId) {
  return evaluationQueue.add('evaluate-run', { runId }, { jobId: `run-${runId}` });
}

export async function closeEvaluationQueue() {
  await evaluationQueue.close();
  await queueConnection.quit();
}
