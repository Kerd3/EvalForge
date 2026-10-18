import { Buffer } from 'node:buffer';

const recordScript = `
  redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
  if ARGV[6] == '1' then redis.call('HINCRBY', KEYS[1], ARGV[2], 1) end
  redis.call('HINCRBY', KEYS[1], ARGV[3], ARGV[5])
  local maximum = tonumber(redis.call('HGET', KEYS[1], ARGV[4]) or '0')
  if tonumber(ARGV[5]) > maximum then redis.call('HSET', KEYS[1], ARGV[4], ARGV[5]) end
  return 1
`;

export function createRedisMetricsStore(redis, { key = 'evalforge:ops:http-metrics' } = {}) {
  if (!redis || typeof redis.eval !== 'function' || typeof redis.hgetall !== 'function') {
    throw new TypeError('Redis metrics store requires an eval-capable Redis client');
  }

  return {
    async record({ method, route, statusCode, durationMs }) {
      const dimension = Buffer.from(JSON.stringify({ method, route, statusCode: Math.floor(statusCode / 100) * 100 }), 'utf8').toString('base64url');
      const field = (name) => `route:${dimension}:${name}`;
      await redis.eval(recordScript, 1, key,
        field('requests'), field('serverErrors'), field('durationUsTotal'), field('durationUsMax'),
        String(Math.max(0, Math.round(durationMs * 1000))), statusCode >= 500 ? '1' : '0');
    },
    async get() {
      const values = await redis.hgetall(key);
      const routes = new Map();
      for (const [name, value] of Object.entries(values)) {
        const match = name.match(/^route:([A-Za-z0-9_-]+):(requests|serverErrors|durationUsTotal|durationUsMax)$/);
        if (!match) continue;
        let dimensions;
        try { dimensions = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); }
        catch { continue; }
        const entry = routes.get(match[1]) ?? { ...dimensions, requests: 0, serverErrors: 0, durationMsTotal: 0, durationMsMax: 0 };
        const numeric = Number(value);
        if (match[2] === 'requests') entry.requests = numeric;
        if (match[2] === 'serverErrors') entry.serverErrors = numeric;
        if (match[2] === 'durationUsTotal') entry.durationMsTotal = numeric / 1000;
        if (match[2] === 'durationUsMax') entry.durationMsMax = numeric / 1000;
        routes.set(match[1], entry);
      }
      return {
        collectedAt: new Date().toISOString(),
        processUptimeSeconds: Math.floor(process.uptime()),
        requests: [...routes.values()]
      };
    }
  };
}
