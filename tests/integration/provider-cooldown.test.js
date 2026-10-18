import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { createRedisCooldownStore } from '../../src/providers/redis-cooldown-store.js';
import { generateWithGeminiFallback } from '../../src/providers/llm-provider.js';

describe('Redis-shared provider cooldowns', () => {
  const prefix = `evalforge:test:provider-cooldown:${randomUUID()}`;
  let redisWorkerA;
  let redisWorkerB;
  let workerAStore;
  let workerBStore;
  let clockNow;

  const connectTestRedis = () => {
    const client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 1500,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => attempt < 2 ? 100 : null
    });
    // The connection rejection is asserted by beforeAll; consume ioredis' event
    // as well so an unavailable local Redis yields one concise setup failure.
    client.on('error', () => {});
    return client;
  };

  beforeAll(async () => {
    clockNow = Date.now();
    redisWorkerA = connectTestRedis();
    redisWorkerB = connectTestRedis();
    await Promise.all([redisWorkerA.connect(), redisWorkerB.connect()]);
    workerAStore = createRedisCooldownStore(redisWorkerA, { prefix, now: () => clockNow });
    workerBStore = createRedisCooldownStore(redisWorkerB, { prefix, now: () => clockNow });
  });

  afterAll(async () => {
    if (workerAStore) await Promise.all(['primary-model', 'fallback-model'].map((model) => workerAStore.delete(model)));
    await Promise.all([redisWorkerA?.quit(), redisWorkerB?.quit()].filter(Boolean));
  });

  it('shares a simulated 429 across workers and retries the primary after expiry', async () => {
    const firstCalls = [];
    const cooldownMs = 700;
    const firstResponse = await generateWithGeminiFallback({
      models: ['primary-model', 'fallback-model'],
      cooldowns: workerAStore,
      cooldownReasons: new Map(),
      args: {},
      generateForModel: async (model) => {
        firstCalls.push(model);
        if (model === 'primary-model') {
          const error = new Error('synthetic quota response');
          error.statusCode = 429;
          error.quotaExhausted = true;
          error.retryAfterMs = cooldownMs;
          throw error;
        }
        return { content: 'Worker A fallback', providerMetadata: {} };
      }
    });

    expect(firstCalls).toEqual(['primary-model', 'fallback-model']);
    expect(firstResponse.providerMetadata).toMatchObject({ actualModel: 'fallback-model', fallbackUsed: true });
    const sharedState = await workerBStore.get('primary-model');
    expect(sharedState).toMatchObject({ reason: 'quota/rate-limit' });
    expect(sharedState.until).toBeGreaterThan(Date.now());
    const primaryKey = `${prefix}:${createHash('sha256').update('primary-model').digest('hex')}`;
    expect(await redisWorkerA.pttl(primaryKey)).toBeGreaterThan(0);

    const shorterWrite = await workerBStore.set('primary-model', Date.now() + 100, 'timeout');
    expect(shorterWrite).toBe(0);
    expect(await workerAStore.get('primary-model')).toMatchObject({ reason: 'quota/rate-limit', until: sharedState.until });

    const secondCalls = [];
    const secondResponse = await generateWithGeminiFallback({
      models: ['primary-model', 'fallback-model'],
      cooldowns: workerBStore,
      cooldownReasons: new Map(),
      args: {},
      generateForModel: async (model) => {
        secondCalls.push(model);
        return { content: 'Worker B response', providerMetadata: {} };
      }
    });
    expect(secondCalls).toEqual(['fallback-model']);
    expect(secondResponse.providerMetadata.fallbackUsed).toBe(true);
    expect(secondResponse.providerMetadata.fallbackAttempts).toContainEqual(expect.objectContaining({
      model: 'primary-model', outcome: 'skipped_cooldown', reason: 'quota/rate-limit'
    }));

    clockNow = sharedState.until + 1;
    expect(await workerBStore.get('primary-model')).toBeNull();
    const afterExpiryCalls = [];
    const afterExpiryResponse = await generateWithGeminiFallback({
      models: ['primary-model', 'fallback-model'],
      cooldowns: workerBStore,
      cooldownReasons: new Map(),
      args: {},
      generateForModel: async (model) => {
        afterExpiryCalls.push(model);
        return { content: 'Primary recovered', providerMetadata: {} };
      }
    });
    expect(afterExpiryCalls).toEqual(['primary-model']);
    expect(afterExpiryResponse.providerMetadata).toMatchObject({ actualModel: 'primary-model', fallbackUsed: false });
  });
});
