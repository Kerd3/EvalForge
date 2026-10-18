import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';

describe('BullMQ queue recovery', () => {
  const queueName = `evalforge-test-recovery-${randomUUID()}`;
  let connection;
  let queue;
  let worker;
  let workerConnection;

  const redisConnection = () => new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    connectTimeout: 1500,
    retryStrategy: (attempt) => attempt < 2 ? 100 : null
  });

  beforeAll(async () => {
    connection = redisConnection();
    queue = new Queue(queueName, { connection, defaultJobOptions: { removeOnComplete: false, attempts: 3, backoff: { type: 'fixed', delay: 20 } } });
    await queue.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close().catch(() => {});
    await workerConnection?.quit().catch(() => {});
    await queue?.obliterate({ force: true }).catch(() => {});
    await queue?.close().catch(() => {});
    await connection?.quit().catch(() => {});
  });

  it('deduplicates repeated job IDs and resumes persisted waiting jobs after a worker restart', async () => {
    const jobId = `resume-${randomUUID()}`;
    const original = await queue.add('resume-check', { sequence: 1 }, { jobId });
    const duplicate = await queue.add('resume-check', { sequence: 2 }, { jobId });
    expect(duplicate.id).toBe(original.id);
    expect((await queue.getJobCounts('waiting')).waiting).toBe(1);

    await queue.close();
    await connection.quit();
    connection = redisConnection();
    queue = new Queue(queueName, { connection, defaultJobOptions: { removeOnComplete: false, attempts: 3, backoff: { type: 'fixed', delay: 20 } } });
    await queue.waitUntilReady();

    const processed = new Promise((resolve, reject) => {
      workerConnection = redisConnection();
      worker = new Worker(queueName, async (job) => job.data.sequence, { connection: workerConnection, concurrency: 1 });
      worker.on('completed', (job, result) => { if (job.id === jobId) resolve({ job, result }); });
      worker.on('failed', reject);
    });
    const result = await Promise.race([
      processed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Persisted queue job was not resumed')), 5000))
    ]);
    expect(result.result).toBe(1);
    expect(result.job.attemptsMade).toBe(1);
    await worker.close();
    worker = null;
    await workerConnection.quit();
    workerConnection = null;
  });

  it('retries a transient job failure and eventually completes', async () => {
    let calls = 0;
    const completed = new Promise((resolve, reject) => {
      workerConnection = redisConnection();
      worker = new Worker(queueName, async () => {
        calls += 1;
        if (calls === 1) throw new Error('synthetic transient failure');
        return 'recovered';
      }, { connection: workerConnection, concurrency: 1 });
      worker.on('completed', (job, result) => { if (job.name === 'retry-check') resolve({ job, result }); });
      worker.on('failed', (job, error) => { if (job?.name === 'retry-check' && job.attemptsMade >= 3) reject(error); });
    });
    await queue.add('retry-check', {}, { jobId: `retry-${randomUUID()}` });
    const result = await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Retried queue job was not completed')), 5000))
    ]);
    expect(calls).toBe(2);
    expect(result.result).toBe('recovered');
    expect(result.job.attemptsMade).toBe(2);
    await worker.close();
    worker = null;
    await workerConnection.quit();
    workerConnection = null;
  });
});
