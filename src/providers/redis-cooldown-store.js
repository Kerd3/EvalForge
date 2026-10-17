import { createHash } from 'node:crypto';

const UPSERT_IF_LATER = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and type(decoded) == 'table' and tonumber(decoded['until']) and tonumber(decoded['until']) >= tonumber(ARGV[1]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[2])
return 1
`;

/** Redis-backed model cooldowns shared by all workers using the same Redis database. */
export function createRedisCooldownStore(redis, { prefix = 'evalforge:provider-cooldown:gemini', now = () => Date.now() } = {}) {
  if (!redis || typeof redis.get !== 'function' || typeof redis.eval !== 'function') {
    throw new TypeError('A Redis client with get and eval methods is required');
  }

  const keyFor = (model) => {
    if (typeof model !== 'string' || !model.trim()) throw new TypeError('Model must be a non-empty string');
    const digest = createHash('sha256').update(model).digest('hex');
    return `${prefix}:${digest}`;
  };

  return {
    async get(model) {
      const key = keyFor(model);
      const raw = await redis.get(key);
      if (!raw) return null;
      let value;
      try { value = JSON.parse(raw); } catch { await redis.del(key); return null; }
      const until = Number(value?.until);
      if (!Number.isFinite(until) || typeof value?.reason !== 'string' || until <= now()) {
        await redis.del(key);
        return null;
      }
      return { until, reason: value.reason };
    },

    async set(model, until, reason) {
      if (!Number.isFinite(until) || typeof reason !== 'string' || !reason) {
        throw new TypeError('Cooldown expiry and reason are required');
      }
      const ttl = Math.ceil(until - now());
      if (ttl <= 0) return 0;
      const payload = JSON.stringify({ until, reason });
      return redis.eval(UPSERT_IF_LATER, 1, keyFor(model), String(until), String(ttl), payload);
    },

    async delete(model) {
      return redis.del(keyFor(model));
    }
  };
}
