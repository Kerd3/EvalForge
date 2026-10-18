import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { createRedisMetricsStore } from '../../src/observability/redis-metrics-store.js';

describe('Redis-persisted operational metrics', () => {
  const key = `evalforge:test:http-metrics:${randomUUID()}`;
  let redisA;
  let redisB;
  let storeA;
  let storeB;

  const connectTestRedis = () => {
    const client = new Redis(env.REDIS_URL, {
      lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => attempt < 2 ? 100 : null
    });
    client.on('error', () => {});
    return client;
  };

  beforeAll(async () => {
    redisA = connectTestRedis();
    redisB = connectTestRedis();
    await Promise.all([redisA.connect(), redisB.connect()]);
    storeA = createRedisMetricsStore(redisA, { key });
    storeB = createRedisMetricsStore(redisB, { key });
  });

  afterAll(async () => {
    await redisA?.del(key);
    await Promise.all([redisA?.quit(), redisB?.quit()].filter(Boolean));
  });

  it('aggregates request counters across independent API clients', async () => {
    await storeA.record({ method: 'GET', route: '/api/health', statusCode: 200, durationMs: 4.5 });
    await storeB.record({ method: 'GET', route: '/api/health', statusCode: 200, durationMs: 10.25 });
    await storeB.record({ method: 'GET', route: '/api/health', statusCode: 503, durationMs: 2 });
    const metrics = await storeA.get();
    expect(metrics.requests).toContainEqual(expect.objectContaining({
      method: 'GET', route: '/api/health', statusCode: 200,
      requests: 2, serverErrors: 0, durationMsTotal: 14.75, durationMsMax: 10.25
    }));
    expect(metrics.requests).toContainEqual(expect.objectContaining({
      method: 'GET', route: '/api/health', statusCode: 500,
      requests: 1, serverErrors: 1, durationMsTotal: 2, durationMsMax: 2
    }));
  });
});
