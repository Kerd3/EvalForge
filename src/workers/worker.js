import { Worker } from 'bullmq';
import { createRedisConnection } from '../db/redis.js';
import { createRedisCooldownStore } from '../providers/redis-cooldown-store.js';
import { createRedisProviderConcurrencyLimit } from '../providers/redis-concurrency-limit.js';
import { configureGeminiCooldownStore, configureProviderConcurrencyLimit } from '../providers/llm-provider.js';
import { closePool } from '../db/pool.js';
import { env } from '../config/env.js';
import { EVALUATION_QUEUE_NAME } from '../queues/constants.js';
import { processEvaluationRun } from '../services/evaluation-runner.service.js';
import { processEvaluationCampaign } from '../services/evaluation-campaign-runner.service.js';
import { failEvaluationCampaign, updateRunStatus } from '../repositories/evaluations.repository.js';

const connection = createRedisConnection();
const cooldownConnection = createRedisConnection();
configureGeminiCooldownStore(createRedisCooldownStore(cooldownConnection));
configureProviderConcurrencyLimit(createRedisProviderConcurrencyLimit(cooldownConnection, {
  // Lease exceeds the maximum configured Gemini request + retry wait; if a
  // worker dies, abandoned slots eventually expire rather than blocking work.
  leaseMs: (2 * env.GEMINI_REQUEST_TIMEOUT_MS) + (2 * env.GEMINI_MIN_REQUEST_INTERVAL_MS) + 150_000
}));
const worker = new Worker(
  EVALUATION_QUEUE_NAME,
  async (job) => {
    if (job.name === 'evaluate-run') return processEvaluationRun(job.data.runId);
    if (job.name === 'evaluate-campaign') return processEvaluationCampaign(job.data.campaignId);
    throw new Error(`Unknown job type: ${job.name}`);
  },
  {
    connection,
    concurrency: env.EVAL_CONCURRENCY,
    lockDuration: env.EVAL_LOCK_DURATION_MS
  }
);

worker.on('completed', (job) => {
  console.log(JSON.stringify({ level: 'info', message: 'Evaluation job completed', jobId: job.id, runId: job.data.runId ?? null, campaignId: job.data.campaignId ?? null }));
});
worker.on('failed', async (job, error) => {
  console.error(JSON.stringify({ level: 'error', message: 'Evaluation job failed', jobId: job?.id, error: error.message }));
  if (job?.attemptsMade >= (job.opts.attempts ?? 1)) {
    try {
      if (job.name === 'evaluate-campaign' && job.data?.campaignId) {
        await failEvaluationCampaign(job.data.campaignId, error.message);
      } else if (job.data?.runId) {
        await updateRunStatus(job.data.runId, 'failed', error.message);
      }
    } catch (statusError) { console.error('Could not mark failed job status:', statusError.message); }
  }
});
worker.on('error', (error) => console.error('BullMQ worker error:', error.message));

console.log(`EvalForge worker ready (concurrency=${env.EVAL_CONCURRENCY}).`);

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down worker.`);
  await worker.close();
  await connection.quit();
  await cooldownConnection.quit();
  configureProviderConcurrencyLimit(null);
  await closePool();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
