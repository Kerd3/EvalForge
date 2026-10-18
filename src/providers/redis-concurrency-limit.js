import { randomUUID } from 'node:crypto';

const acquireScript = `
  local now = tonumber(ARGV[1])
  local leaseUntil = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local token = ARGV[4]
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  if redis.call('ZCARD', KEYS[1]) >= limit then return 0 end
  redis.call('ZADD', KEYS[1], leaseUntil, token)
  redis.call('PEXPIRE', KEYS[1], leaseUntil - now)
  return 1
`;

const releaseScript = "return redis.call('ZREM', KEYS[1], ARGV[1])";

export function createRedisProviderConcurrencyLimit(redis, {
  prefix = 'evalforge:provider-slots',
  leaseMs = 240_000,
  pollMs = 100,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!redis || typeof redis.eval !== 'function') throw new TypeError('Redis concurrency limiter requires an eval-capable Redis client');
  if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new TypeError('Redis concurrency lease must be at least 1000ms');

  return async function runWithProviderLimit(provider, limit, operation) {
    if (!['openai', 'gemini'].includes(provider)) throw new TypeError('Unsupported provider concurrency group');
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Provider concurrency limit must be a positive integer');
    const key = prefix + ':' + provider;
    const token = randomUUID();
    while (true) {
      const timestamp = now();
      const acquired = await redis.eval(acquireScript, 1, key, timestamp, timestamp + leaseMs, limit, token);
      if (Number(acquired) === 1) break;
      await sleep(pollMs);
    }

    try {
      return await operation();
    } finally {
      await redis.eval(releaseScript, 1, key, token);
    }
  };
}
