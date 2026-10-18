import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool, closePool } from './db/pool.js';
import { createRedisConnection } from './db/redis.js';
import { evaluationQueue, enqueueEvaluation, enqueueEvaluationCampaign, closeEvaluationQueue } from './queues/evaluation.queue.js';
import { datasetService } from './services/dataset.service.js';
import { createEvaluationService } from './services/evaluation.service.js';
import { createEvaluationCampaignService } from './services/evaluation-campaign.service.js';
import { getRequestMetrics } from './observability/request-telemetry.js';
import { createRedisMetricsStore } from './observability/redis-metrics-store.js';

const evaluationService = createEvaluationService({ enqueue: enqueueEvaluation });
const campaignService = createEvaluationCampaignService({ enqueue: enqueueEvaluationCampaign });
const metricsConnection = createRedisConnection();
const metricsStore = createRedisMetricsStore(metricsConnection);
const app = createApp({
  datasetService,
  evaluationService,
  campaignService,
  trustProxyHops: env.TRUST_PROXY_HOPS,
  metricsStore,
  healthCheck: async () => {
    await pool.query('SELECT 1');
    const client = await evaluationQueue.client;
    await client.ping();
    return { status: 'ok', checks: { postgres: 'ok', redis: 'ok' }, service: 'evalforge-api' };
  },
  metricsProvider: async () => ({
    ...await metricsStore.get(),
    queue: await evaluationQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
  })
});

const server = app.listen(env.PORT, () => {
  console.log(JSON.stringify({ level: 'info', message: 'EvalForge API listening', port: env.PORT, environment: env.NODE_ENV }));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down EvalForge API.`);
  server.close(async () => {
    try {
      await closeEvaluationQueue();
      await metricsConnection.quit();
      await closePool();
      process.exit(0);
    } catch (error) {
      console.error('Shutdown error:', error.message);
      process.exit(1);
    }
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
