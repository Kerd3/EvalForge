import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { createRedisProviderConcurrencyLimit } from '../../src/providers/redis-concurrency-limit.js';

describe('Redis-shared provider concurrency limits', () => {
  const prefix = `evalforge:test:provider-slots:${randomUUID()}`;
  let redisA;
  let redisB;
  let runA;
  let runB;

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
    runA = createRedisProviderConcurrencyLimit(redisA, { prefix, leaseMs: 3000, pollMs: 10 });
    runB = createRedisProviderConcurrencyLimit(redisB, { prefix, leaseMs: 3000, pollMs: 10 });
  });

  afterAll(async () => {
    await Promise.all([redisA?.del(`${prefix}:gemini`), redisB?.del(`${prefix}:openai`)].filter(Boolean));
    await Promise.all([redisA?.quit(), redisB?.quit()].filter(Boolean));
  });

  it('enforces a single provider slot across independent worker clients', async () => {
    let active = 0;
    let maximum = 0;
    let releaseFirst;
    let announceFirst;
    let secondStarted = false;
    const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const first = runA('gemini', 1, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      announceFirst();
      await firstGate;
      active -= 1;
    });
    await firstStarted;
    const second = runB('gemini', 1, async () => {
      secondStarted = true;
      active += 1;
      maximum = Math.max(maximum, active);
      active -= 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(secondStarted).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
    expect(maximum).toBe(1);
  });
});
