import { Worker } from 'bullmq';
import { createRedisConnection } from '../db/redis.js';
import { closePool } from '../db/pool.js';
import { env } from '../config/env.js';
import { EVALUATION_QUEUE_NAME } from '../queues/constants.js';
import { processEvaluationRun } from '../services/evaluation-runner.service.js';
import { updateRunStatus } from '../repositories/evaluations.repository.js';

const connection = createRedisConnection();
const worker = new Worker(
  EVALUATION_QUEUE_NAME,
  async (job) => {
    if (job.name !== 'evaluate-run') throw new Error(`Unknown job type: ${job.name}`);
    await processEvaluationRun(job.data.runId);
  },
  {
    connection,
    concurrency: env.EVAL_CONCURRENCY,
    lockDuration: env.EVAL_LOCK_DURATION_MS
  }
);

worker.on('completed', (job) => {
  console.log(JSON.stringify({ level: 'info', message: 'Evaluation job completed', jobId: job.id, runId: job.data.runId }));
});
worker.on('failed', async (job, error) => {
  console.error(JSON.stringify({ level: 'error', message: 'Evaluation job failed', jobId: job?.id, error: error.message }));
  if (job?.data?.runId && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    try { await updateRunStatus(job.data.runId, 'failed', error.message); }
    catch (statusError) { console.error('Could not mark failed run:', statusError.message); }
  }
});
worker.on('error', (error) => console.error('BullMQ worker error:', error.message));

console.log(`EvalForge worker ready (concurrency=${env.EVAL_CONCURRENCY}).`);

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down worker.`);
  await worker.close();
  await connection.quit();
  await closePool();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
