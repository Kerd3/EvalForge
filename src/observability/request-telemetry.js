import { randomUUID } from 'node:crypto';

const counters = new Map();

function routeLabel(req) {
  const route = req.route?.path;
  if (typeof route === 'string') return `${req.baseUrl ?? ''}${route}`;
  return req.path.startsWith('/api/') ? '/api/unmatched' : '/static';
}

export function requestTelemetry(req, res, next, metricsStore = null) {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  res.setHeader('x-request-id', requestId);
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const key = `${req.method} ${routeLabel(req)} ${Math.floor(res.statusCode / 100)}xx`;
    const current = counters.get(key) ?? { requests: 0, errors: 0, durationMsTotal: 0, durationMsMax: 0 };
    current.requests += 1;
    if (res.statusCode >= 500) current.errors += 1;
    current.durationMsTotal += durationMs;
    current.durationMsMax = Math.max(current.durationMsMax, durationMs);
    counters.set(key, current);
    if (metricsStore) {
      metricsStore.record({ method: req.method, route: routeLabel(req), statusCode: res.statusCode, durationMs })
        .catch((error) => console.error(JSON.stringify({ level: 'error', message: 'Could not persist request metrics', requestId, error: error.message })));
    }
    console.log(JSON.stringify({
      level: res.statusCode >= 500 ? 'error' : 'info',
      message: 'HTTP request completed', requestId, method: req.method,
      route: routeLabel(req), statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100
    }));
  });
  next();
}

export function getRequestMetrics() {
  return {
    processUptimeSeconds: Math.floor(process.uptime()),
    requests: [...counters.entries()].map(([route, metrics]) => ({ route, ...metrics }))
  };
}

export function resetRequestMetrics() {
  counters.clear();
}
