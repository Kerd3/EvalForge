import { env } from '../config/env.js';
import { estimateCostDetails as calculateCostDetails } from '../services/cost-estimation.service.js';
import { createConcurrencyLimit } from './concurrency-limit.js';

const limitOpenAiCall = createConcurrencyLimit(env.OPENAI_MAX_CONCURRENCY);
const limitGeminiCall = createConcurrencyLimit(env.GEMINI_MAX_CONCURRENCY);
let sharedProviderConcurrencyLimit = null;

export function configureProviderConcurrencyLimit(limit) {
  if (limit !== null && typeof limit !== 'function') {
    throw new TypeError('Provider concurrency limiter must be a function');
  }
  sharedProviderConcurrencyLimit = limit;
}

function withProviderLimit(provider, localLimit, operation) {
  if (sharedProviderConcurrencyLimit) return sharedProviderConcurrencyLimit(provider, localLimit, operation);
  return (provider === 'openai' ? limitOpenAiCall : limitGeminiCall)(operation);
}

function serializeInput(input) {
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
}

/**
 * Builds the user content sent to a real model. Test fixtures such as
 * mock_response must never be sent to Gemini/OpenAI; context is optional
 * reference material that lets a case evaluate evidence-grounded behavior.
 */
export function buildModelInput(input) {
  if (!input || typeof input !== 'object' || typeof input.message !== 'string') {
    return input;
  }

  const context = typeof input.context === 'string' ? input.context.trim() : '';
  if (!context) return input.message;

  return [
    'Reference context (use as evidence for factual claims; if it does not answer the question, say so rather than speculate):',
    context,
    '',
    'User message:',
    input.message
  ].join('\n');
}

function toOpenAITools(tools = []) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} }
    }
  }));
}

const geminiTypes = {
  object: 'OBJECT',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY'
};

export function toGeminiSchema(schema = {}) {
  const converted = {};
  if (typeof schema.type === 'string') converted.type = geminiTypes[schema.type.toLowerCase()] ?? schema.type.toUpperCase();
  if (typeof schema.description === 'string') converted.description = schema.description;
  if (Array.isArray(schema.required)) converted.required = schema.required;
  if (Array.isArray(schema.enum)) converted.enum = schema.enum;
  if (typeof schema.nullable === 'boolean') converted.nullable = schema.nullable;
  if (typeof schema.format === 'string') converted.format = schema.format;
  if (typeof schema.minimum === 'number') converted.minimum = schema.minimum;
  if (typeof schema.maximum === 'number') converted.maximum = schema.maximum;
  if (typeof schema.minItems === 'number') converted.minItems = schema.minItems;
  if (typeof schema.maxItems === 'number') converted.maxItems = schema.maxItems;
  if (schema.properties && typeof schema.properties === 'object') {
    converted.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, propertySchema]) => [name, toGeminiSchema(propertySchema)])
    );
  }
  if (schema.items && typeof schema.items === 'object') converted.items = toGeminiSchema(schema.items);
  return converted;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One shared throttle is used by all Gemini provider instances in this worker
// process, so concurrent evaluation runs do not all hit the free-tier limit at
// once. This is process-local; a multi-worker deployment should use a shared
// Redis token bucket instead.
let geminiThrottleTail = Promise.resolve();
let nextGeminiRequestAt = 0;

async function waitForGeminiRequestSlot(minIntervalMs) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) return;

  let release;
  const previous = geminiThrottleTail;
  geminiThrottleTail = new Promise((resolve) => { release = resolve; });
  await previous;

  try {
    const waitMs = Math.max(0, nextGeminiRequestAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    nextGeminiRequestAt = Date.now() + minIntervalMs;
  } finally {
    release();
  }
}

/**
 * Parse provider retry hints. Gemini may return a human-readable message such
 * as "Please retry in 51.2s" rather than an HTTP Retry-After header.
 */
function parseDurationMs(durationText) {
  if (typeof durationText !== 'string') return null;
  const unitPattern = /(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?=\d|\s|$|[.,])/gi;
  const multipliers = {
    millisecond: 1, milliseconds: 1, msec: 1, msecs: 1, ms: 1,
    second: 1000, seconds: 1000, sec: 1000, secs: 1000, s: 1000,
    minute: 60000, minutes: 60000, min: 60000, mins: 60000, m: 60000,
    hour: 3600000, hours: 3600000, hr: 3600000, hrs: 3600000, h: 3600000,
    day: 86400000, days: 86400000, d: 86400000
  };
  let total = 0;
  let matches = 0;
  for (const match of durationText.matchAll(unitPattern)) {
    const unit = match[2].toLowerCase();
    const multiplier = multipliers[unit] ?? multipliers[unit.replace(/s$/, '')];
    if (multiplier === undefined) continue;
    total += Number(match[1]) * multiplier;
    matches += 1;
  }
  return matches > 0 && Number.isFinite(total) ? Math.ceil(total) : null;
}

/**
 * Parse provider retry hints, including compact compound durations such as
 * "20h15m33.3s". A large parsed delay is not necessarily safe to sleep inside
 * a worker; fetchWithRetries caps automatic waits and reports longer quota
 * resets to the caller instead.
 */
export function parseRetryDelayMs(bodyText = '', retryAfterHeader = null, nowMs = Date.now()) {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const retryDateMs = Date.parse(retryAfterHeader);
    if (Number.isFinite(retryDateMs)) return Math.max(0, retryDateMs - nowMs);
  }

  const retryInMatch = bodyText.match(/retry\s+in\s+([^\n]+)/i);
  if (retryInMatch) {
    const durationMatch = retryInMatch[1].match(/^\s*((?:\d+(?:\.\d+)?\s*(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\s*)+)/i);
    if (durationMatch) {
      const parsed = parseDurationMs(durationMatch[1]);
      if (parsed !== null) return parsed;
    }
  }

  const retryDelayMatch = bodyText.match(/"retryDelay"\s*:\s*"([^"]+)"/i);
  if (retryDelayMatch) {
    const parsed = parseDurationMs(retryDelayMatch[1]);
    if (parsed !== null) return parsed;
  }

  return null;
}

function isRequestTimeoutError(error) {
  return error?.code === 'GEMINI_REQUEST_TIMEOUT'
    || error?.name === 'TimeoutError'
    || /operation was aborted due to timeout|request timed out|timed out while waiting for a response/i.test(String(error?.message ?? ''));
}

// Temporary Gemini service failures (including HTTP 503 high demand) should
// move to the next configured model instead of retrying the same model under
// the worker's shared per-request throttle. 408/500/502/503/504 are transient;
// authentication and request-validation errors are intentionally excluded.
function isGeminiTransientServiceError(error) {
  return [408, 500, 502, 503, 504].includes(Number(error?.statusCode))
    || error?.providerUnavailable === true;
}

async function fetchWithRetries(url, options, { maxAttempts = 2, minIntervalMs = 0, requestTimeoutMs = 45000 } = {}) {
  let lastError;
  // Do not keep a worker asleep for minutes/hours because of a provider quota
  // reset. Short request-rate delays may be retried once; long resets become a
  // normal, inspectable case error that the user can retry later.
  const maxAutomaticRetryWaitMs = 120_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (minIntervalMs > 0) await waitForGeminiRequestSlot(minIntervalMs);
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(requestTimeoutMs) });
      if (response.ok) return response;

      const body = await response.text();
      const retryDelayMs = parseRetryDelayMs(body, response.headers.get('retry-after'));
      const quotaExhausted = /quota exceeded|RESOURCE_EXHAUSTED|free_tier_requests/i.test(body);
      const error = new Error(
        `LLM provider returned HTTP ${response.status}: ${body.slice(0, 500)}`
      );
      error.statusCode = response.status;
      if (retryDelayMs !== null) error.retryAfterMs = retryDelayMs;
      if (quotaExhausted) error.quotaExhausted = true;

      const transient = response.status === 408 || response.status === 429 || response.status >= 500;
      const fallbackToAnotherModel = isGeminiTransientServiceError(error);
      const delayTooLong = retryDelayMs !== null && retryDelayMs > maxAutomaticRetryWaitMs;
      const quotaWithoutHint = quotaExhausted && retryDelayMs === null;
      if (!transient || fallbackToAnotherModel || attempt === maxAttempts || delayTooLong || quotaWithoutHint) {
        if (delayTooLong || quotaWithoutHint) {
          error.retryDeferred = true;
          error.message += delayTooLong
            ? `\nAutomatic retry skipped because the provider requested a ${Math.ceil(retryDelayMs / 1000)}-second wait. Retry after the quota resets.`
            : '\nAutomatic retry skipped because the provider reported quota exhaustion without a usable retry time.';
        }
        throw error;
      }

      lastError = error;
      // Honor short provider hints. For provider errors without a hint, use a
      // short exponential backoff. Long waits are handled above, not slept on.
      await sleep(retryDelayMs ?? Math.min(30000, 1000 * (2 ** (attempt - 1))));
    } catch (error) {
      lastError = error;
      // A timeout is passed to model-level fallback immediately instead of
      // spending another full request timeout retrying the same slow model.
      if (isRequestTimeoutError(error)) {
        const timeoutError = new Error(`Gemini request timed out after ${requestTimeoutMs} ms.`);
        timeoutError.name = 'TimeoutError';
        timeoutError.code = 'GEMINI_REQUEST_TIMEOUT';
        timeoutError.providerTimeout = true;
        timeoutError.requestTimeoutMs = requestTimeoutMs;
        timeoutError.cause = error;
        throw timeoutError;
      }
      // Return 5xx/service-availability errors to model-level fallback now.
      // Retrying the same model would incur another throttle interval first.
      if (isGeminiTransientServiceError(error)) throw error;
      const nonRetryableHttpError = error.statusCode && error.statusCode < 500 && error.statusCode !== 408 && error.statusCode !== 429;
      if (attempt === maxAttempts || nonRetryableHttpError || error.retryDeferred) throw error;
      // HTTP failures have already waited using the response's retry hint.
      // Other network failures receive bounded exponential backoff.
      if (!error.statusCode) await sleep(Math.min(30000, 1000 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

export function mapGeminiResponse(payload = {}) {
  const candidate = payload.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content = parts
    // Do not mix any provider-marked thought part into the answer being graded.
    .filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text)
    .join('');
  const toolCalls = parts
    .filter((part) => part.functionCall && typeof part.functionCall.name === 'string')
    .map((part) => ({
      name: part.functionCall.name,
      arguments: part.functionCall.args ?? {}
    }));

  return {
    content,
    toolCalls,
    // When usageMetadata (or its prompt count) is absent, report usage as null so
    // downstream accounting records "unknown" instead of a fabricated zero.
    usage: Number.isFinite(Number(payload.usageMetadata?.promptTokenCount))
      && payload.usageMetadata?.promptTokenCount !== null
      ? {
        inputTokens: Number(payload.usageMetadata.promptTokenCount),
        // Gemini reports thinking tokens separately; include them in total output
        // usage because they are part of output-token consumption on thinking models.
        // Gemini omits zero-valued fields, so an absent count here means zero.
        outputTokens: Number(payload.usageMetadata.candidatesTokenCount ?? 0)
          + Number(payload.usageMetadata.thoughtsTokenCount ?? 0)
      }
      : null,
    providerMetadata: {
      responseId: payload.responseId,
      finishReason: candidate?.finishReason,
      modelVersion: payload.modelVersion,
      thoughtsTokens: Number(payload.usageMetadata?.thoughtsTokenCount ?? 0)
    }
  };
}

function createGeminiProviderForModel(model) {
  if (!env.GEMINI_API_KEY) {
    const error = new Error('GEMINI_API_KEY is not configured. Add your key to .env and restart the API and worker, or use provider "mock".');
    error.statusCode = 400;
    throw error;
  }

  const resolvedModel = model || env.DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolvedModel)}:generateContent`;

  return {
    name: 'gemini',
    model: resolvedModel,
    async generate({ testCase, systemPrompt }) {
      const modelInput = buildModelInput(testCase.input);
      const contents = [{ role: 'user', parts: [{ text: serializeInput(modelInput) }] }];
      const body = { contents, generationConfig: { temperature: 0 } };
      if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

      const tools = (testCase.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        parameters: toGeminiSchema(tool.parameters ?? { type: 'object', properties: {} })
      }));
      if (tools.length) body.tools = [{ functionDeclarations: tools }];

      const response = await withProviderLimit('gemini', env.GEMINI_MAX_CONCURRENCY, () => fetchWithRetries(endpoint, {
        method: 'POST',
        headers: {
          'x-goog-api-key': env.GEMINI_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }, { minIntervalMs: env.GEMINI_MIN_REQUEST_INTERVAL_MS, requestTimeoutMs: env.GEMINI_REQUEST_TIMEOUT_MS }));
      const payload = await response.json();
      return mapGeminiResponse(payload);
    },
    async judge({ systemPrompt, testCase, response }) {
      const rubric = testCase.grading_rules?.judgeRubric ?? 'Score whether the answer correctly follows the test requirements and is supported by the provided input. Do not reward unsupported claims.';
      const prompt = `Evaluate an AI response. Return only JSON with keys score (number from 0 to 1), passed (boolean), and explanation (string).\nRubric: ${rubric}\nTest input: ${serializeInput(testCase.input)}\nExpected output: ${serializeInput(testCase.expected_output ?? '')}\nResponse: ${response.content}\nRequired keywords: ${JSON.stringify(testCase.required_keywords ?? [])}`;
      const result = await this.generate({
        testCase: { ...testCase, input: prompt, tools: [] },
        systemPrompt: systemPrompt || 'You are a strict evaluator. Be consistent and evidence-based.'
      });
      let parsed;
      try {
        const cleaned = result.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        parsed = JSON.parse(cleaned);
      } catch { parsed = null; }
      if (!parsed || typeof parsed.score !== 'number' || typeof parsed.passed !== 'boolean') {
        return { score: 0, passed: false, explanation: 'Gemini judge returned malformed JSON.', usage: result.usage, providerMetadata: result.providerMetadata ?? {} };
      }
      return {
        score: Math.max(0, Math.min(1, parsed.score)),
        passed: parsed.passed,
        explanation: String(parsed.explanation ?? ''),
        usage: result.usage,
        providerMetadata: result.providerMetadata ?? {}
      };
    }
  };
}


// Used by standalone consumers; the worker configures a Redis-backed store so
// independent worker processes honor the same model cooldowns.
const geminiModelCooldownUntil = new Map();
const geminiModelCooldownReason = new Map();
let sharedGeminiCooldownStore = null;

export function configureGeminiCooldownStore(store) {
  if (store !== null && (!store || typeof store.get !== 'function' || typeof store.set !== 'function')) {
    throw new TypeError('Gemini cooldown store must provide get and set methods');
  }
  sharedGeminiCooldownStore = store;
}

export function buildGeminiModelChain(primaryModel, fallbackModelsText = '') {
  const models = [
    primaryModel,
    ...String(fallbackModelsText ?? '').split(',').map((item) => item.trim())
  ].filter((item) => typeof item === 'string' && item.length > 0);
  return [...new Set(models)];
}

function isGeminiQuotaOrRateLimitError(error) {
  return error?.statusCode === 429 || error?.quotaExhausted === true;
}

function isGeminiTimeoutError(error) {
  return error?.providerTimeout === true || error?.code === 'GEMINI_REQUEST_TIMEOUT' || isRequestTimeoutError(error);
}

export function getGeminiCooldownMs(error, defaultCooldownMs = 60000) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) {
    return Math.ceil(error.retryAfterMs);
  }
  const message = String(error?.message ?? '').toLowerCase();
  // A daily/free-tier quota error without a retry hint should not be hammered
  // again on every test case. One day is a conservative fallback cooldown.
  if (/free_tier_requests|quota_exceeded|daily quota|requests per day|per_day/.test(message)) {
    return 24 * 60 * 60 * 1000;
  }
  return Math.max(1000, defaultCooldownMs);
}

/**
 * Try configured Gemini models in order. Switch for quota/rate-limit
 * failures, request timeouts, and temporary HTTP service errors (such as 503).
 * Auth/config/validation errors are surfaced rather than hidden by another
 * model. `cooldowns` is injectable for tests.
 */
export async function generateWithGeminiFallback({
  models,
  generateForModel,
  args,
  cooldowns = geminiModelCooldownUntil,
  cooldownReasons = geminiModelCooldownReason,
  now = () => Date.now(),
  defaultCooldownMs = 60000,
  timeoutCooldownMs = 60000,
  unavailableCooldownMs = 30000
}) {
  const candidates = [...new Set((models ?? []).filter((item) => typeof item === 'string' && item.length > 0))];
  if (!candidates.length) throw new Error('No Gemini model is configured. Set DEFAULT_GEMINI_MODEL.');

  const requestedModel = candidates[0];
  const failures = [];
  const skipped = [];

  for (const candidate of candidates) {
    const storedCooldown = await cooldowns.get(candidate);
    const cooldownUntil = typeof storedCooldown === 'number' ? storedCooldown : Number(storedCooldown?.until ?? 0);
    if (cooldownUntil > now()) {
      skipped.push({ model: candidate, cooldownUntil, reason: storedCooldown?.reason ?? cooldownReasons.get(candidate) ?? 'quota/rate-limit' });
      continue;
    }

    try {
      const response = await generateForModel(candidate, args);
      const fallbackUsed = candidate !== requestedModel;
      const priorDetails = [
        ...failures.map(({ model, error }) => `${model}: ${error.message}`),
        ...skipped.map(({ model, reason, cooldownUntil }) => `${model}: ${reason} cooldown until ${new Date(cooldownUntil).toISOString()}`)
      ];
      const fallbackReason = fallbackUsed
        ? `Switched from ${requestedModel} because a configured model timed out, was rate-limited/quota-exhausted, or temporarily unavailable. ${priorDetails.join(' | ')}`
        : null;
      // Structured, additive copy of the same facts that fallbackReason prose
      // describes, so the UI can summarize without parsing text.
      const fallbackAttempts = fallbackUsed ? [
        ...failures.map(({ model, error, cooldownUntil: until, reason }) => ({
          model, outcome: 'failed', reason,
          http_status: Number.isInteger(Number(error?.statusCode)) ? Number(error.statusCode) : null,
          message: String(error?.message ?? '').slice(0, 400),
          cooldown_until: new Date(until).toISOString()
        })),
        ...skipped.map(({ model, reason, cooldownUntil: until }) => ({
          model, outcome: 'skipped_cooldown', reason, http_status: null, message: null,
          cooldown_until: new Date(until).toISOString()
        }))
      ] : [];
      return {
        ...response,
        providerMetadata: {
          ...(response?.providerMetadata ?? {}),
          requestedModel,
          actualModel: candidate,
          fallbackUsed,
          ...(fallbackReason ? { fallbackReason } : {}),
          ...(fallbackAttempts.length ? { fallbackAttempts } : {})
        }
      };
    } catch (error) {
      const timedOut = isGeminiTimeoutError(error);
      const quotaLimited = isGeminiQuotaOrRateLimitError(error);
      const serviceUnavailable = isGeminiTransientServiceError(error);
      if (!timedOut && !quotaLimited && !serviceUnavailable) throw error;
      const reason = timedOut ? 'timeout' : quotaLimited ? 'quota/rate-limit' : 'provider-unavailable';
      const cooldownMs = timedOut
        ? Math.max(1000, timeoutCooldownMs)
        : quotaLimited
          ? getGeminiCooldownMs(error, defaultCooldownMs)
          : getGeminiCooldownMs(error, unavailableCooldownMs);
      const until = now() + cooldownMs;
      await cooldowns.set(candidate, until, reason);
      cooldownReasons.set(candidate, reason);
      failures.push({ model: candidate, error, cooldownUntil: until, reason });
    }
  }

  const cooldownTimes = (await Promise.all(candidates.map(async (candidate) => {
    const stored = await cooldowns.get(candidate);
    return typeof stored === 'number' ? stored : Number(stored?.until ?? 0);
  })))
    .filter((until) => Number.isFinite(until) && until > now());
  const retryAfterMs = cooldownTimes.length ? Math.max(0, Math.min(...cooldownTimes) - now()) : defaultCooldownMs;
  const details = [
    ...failures.map(({ model: name, error }) => `${name}: ${String(error.message).slice(0, 180)}`),
    ...skipped.map(({ model: name, cooldownUntil, reason }) => `${name}: ${reason} cooldown until ${new Date(cooldownUntil).toISOString()}`)
  ];
  const allReasons = [...failures.map((item) => item.reason), ...skipped.map((item) => item.reason)];
  const allUnavailableFromTimeout = allReasons.length > 0 && allReasons.every((reason) => reason === 'timeout');
  const allUnavailableFromQuota = allReasons.length > 0 && allReasons.every((reason) => reason === 'quota/rate-limit');
  const allUnavailableFromService = allReasons.length > 0 && allReasons.every((reason) => reason === 'provider-unavailable');
  let finalMessage;
  if (allUnavailableFromTimeout) {
    finalMessage = `All configured Gemini models timed out while waiting for a response. ${details.join(' | ')}. ` +
      `The earliest timeout cooldown expires in approximately ${Math.ceil(retryAfterMs / 1000)} seconds.`;
  } else if (allUnavailableFromQuota) {
    finalMessage = `All configured Gemini models are currently rate-limited, quota-exhausted, or in cooldown. ${details.join(' | ')}. ` +
      `Earliest retry is in approximately ${Math.ceil(retryAfterMs / 1000)} seconds.`;
  } else if (allUnavailableFromService) {
    finalMessage = `All configured Gemini models returned temporary service-availability errors (such as HTTP 503). ${details.join(' | ')}. ` +
      `The provider may be experiencing high demand. Earliest retry is in approximately ${Math.ceil(retryAfterMs / 1000)} seconds.`;
  } else {
    finalMessage = `No configured Gemini model could return a response because of timeout, quota, or temporary availability errors. ${details.join(' | ')}. ` +
      `Earliest retry is in approximately ${Math.ceil(retryAfterMs / 1000)} seconds.`;
  }
  const error = new Error(finalMessage);
  error.statusCode = allUnavailableFromTimeout ? 504 : allUnavailableFromQuota ? 429 : 503;
  error.quotaExhausted = allUnavailableFromQuota;
  error.providerTimeout = allUnavailableFromTimeout;
  error.providerUnavailable = !allUnavailableFromTimeout && !allUnavailableFromQuota;
  error.code = allUnavailableFromTimeout ? 'GEMINI_REQUEST_TIMEOUT'
    : allUnavailableFromQuota ? 'GEMINI_MODELS_RATE_LIMITED' : 'GEMINI_MODELS_UNAVAILABLE';
  error.retryDeferred = true;
  error.retryAfterMs = retryAfterMs;
  error.modelErrors = details;
  throw error;
}

function createGeminiProvider(model) {
  const primaryModel = model || env.DEFAULT_GEMINI_MODEL;
  const primaryProvider = createGeminiProviderForModel(primaryModel);
  const modelChain = buildGeminiModelChain(primaryModel, env.GEMINI_FALLBACK_MODELS);
  const wrapper = {
    name: 'gemini',
    model: primaryModel,
    async generate(args) {
      return generateWithGeminiFallback({
        models: modelChain,
        args,
        defaultCooldownMs: env.GEMINI_DEFAULT_QUOTA_COOLDOWN_MS,
        timeoutCooldownMs: env.GEMINI_DEFAULT_TIMEOUT_COOLDOWN_MS,
        unavailableCooldownMs: env.GEMINI_DEFAULT_UNAVAILABLE_COOLDOWN_MS,
        cooldowns: sharedGeminiCooldownStore ?? geminiModelCooldownUntil,
        cooldownReasons: geminiModelCooldownReason,
        generateForModel: async (candidate, requestArgs) => {
          if (candidate === primaryModel) return primaryProvider.generate(requestArgs);
          return createGeminiProviderForModel(candidate).generate(requestArgs);
        }
      });
    },
    async judge(args) {
      // Reuse the existing judge prompt/parser while binding `this` to the
      // wrapper so the judge's own generation call also gets model fallback.
      return primaryProvider.judge.call(wrapper, args);
    }
  };
  return wrapper;
}

export function createLlmProvider({ provider, model }) {
  if (provider === 'mock') {
    return {
      name: 'mock',
      model: model || 'mock-v1',
      async generate({ testCase }) {
        const input = testCase.input;
        const mockResponse = input && typeof input === 'object' ? input.mock_response : undefined;
        if (mockResponse && typeof mockResponse === 'object') {
          return {
            content: typeof mockResponse.content === 'string' ? mockResponse.content : '',
            toolCalls: Array.isArray(mockResponse.toolCalls) ? mockResponse.toolCalls : [],
            ...(mockResponse.agentTrace && typeof mockResponse.agentTrace === 'object'
              ? { agentTrace: mockResponse.agentTrace } : {}),
            usage: { inputTokens: 0, outputTokens: 0 },
            providerMetadata: { mode: 'mock', deterministic: true }
          };
        }
        const message = typeof input === 'string' ? input : (input?.message ?? JSON.stringify(input));
        return {
          content: `Mock response for: ${message}`,
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          providerMetadata: { mode: 'mock', deterministic: true }
        };
      },
      async judge({ testCase, response }) {
        const required = testCase.required_keywords ?? [];
        const missing = required.filter((item) => !response.content.toLowerCase().includes(item.toLowerCase()));
        return {
          score: missing.length === 0 ? 1 : 0,
          passed: missing.length === 0,
          explanation: missing.length ? `Missing keywords: ${missing.join(', ')}` : 'Mock judge: required keywords were present.',
          usage: { inputTokens: 0, outputTokens: 0 },
          providerMetadata: { mode: 'mock', deterministic: true, operation: 'local-grader' }
        };
      }
    };
  }

  if (provider === 'gemini') return createGeminiProvider(model);

  if (provider !== 'openai') throw new Error(`Unsupported provider: ${provider}`);
  if (!env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY is required when provider is "openai". Use provider "mock" to run without an API key.');
    error.statusCode = 400;
    throw error;
  }

  const resolvedModel = model || env.DEFAULT_OPENAI_MODEL;
  const baseUrl = env.OPENAI_BASE_URL.replace(/\/$/, '');
  return {
    name: 'openai',
    model: resolvedModel,
    async generate({ testCase, systemPrompt }) {
      const modelInput = buildModelInput(testCase.input);
      const userContent = serializeInput(modelInput);
      const openAiTools = toOpenAITools(testCase.tools ?? []);
      const body = {
        model: resolvedModel,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: userContent }
        ],
        temperature: 0
      };
      if (openAiTools.length) {
        body.tools = openAiTools;
        body.tool_choice = 'auto';
      }
      const response = await withProviderLimit('openai', env.OPENAI_MAX_CONCURRENCY, () => fetchWithRetries(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }));
      const payload = await response.json();
      const message = payload.choices?.[0]?.message;
      const toolCalls = (message?.tool_calls ?? []).map((call) => {
        let argumentsValue = call.function?.arguments ?? '{}';
        try { argumentsValue = JSON.parse(argumentsValue); } catch { /* preserve invalid arguments for inspection */ }
        return { name: call.function?.name ?? 'unknown', arguments: argumentsValue, id: call.id };
      });
      return {
        content: typeof message?.content === 'string' ? message.content : '',
        toolCalls,
        usage: Number.isFinite(Number(payload.usage?.prompt_tokens)) && payload.usage?.prompt_tokens !== null
          ? {
            inputTokens: Number(payload.usage.prompt_tokens),
            outputTokens: Number(payload.usage.completion_tokens ?? 0)
          }
          : null,
        providerMetadata: {
          responseId: payload.id,
          finishReason: payload.choices?.[0]?.finish_reason,
          requestedModel: resolvedModel,
          actualModel: payload.model || resolvedModel,
          fallbackUsed: false
        }
      };
    },
    async judge({ systemPrompt, testCase, response }) {
      const rubric = testCase.grading_rules?.judgeRubric ?? 'Score whether the answer correctly follows the test requirements and is supported by the provided input. Do not reward unsupported claims.';
      const prompt = `Evaluate an AI response. Return only JSON with keys score (number from 0 to 1), passed (boolean), and explanation (string).\nRubric: ${rubric}\nTest input: ${serializeInput(testCase.input)}\nExpected output: ${serializeInput(testCase.expected_output ?? '')}\nResponse: ${response.content}\nRequired keywords: ${JSON.stringify(testCase.required_keywords ?? [])}`;
      const result = await this.generate({
        testCase: { ...testCase, input: prompt, tools: [] },
        systemPrompt: systemPrompt || 'You are a strict evaluator. Be consistent and evidence-based.'
      });
      let parsed;
      try { parsed = JSON.parse(result.content); } catch { parsed = null; }
      if (!parsed || typeof parsed.score !== 'number' || typeof parsed.passed !== 'boolean') {
        return { score: 0, passed: false, explanation: 'LLM judge returned malformed JSON.', usage: result.usage, providerMetadata: result.providerMetadata ?? {} };
      }
      return {
        score: Math.max(0, Math.min(1, parsed.score)),
        passed: parsed.passed,
        explanation: String(parsed.explanation ?? ''),
        usage: result.usage,
        providerMetadata: result.providerMetadata ?? {}
      };
    }
  };
}

function providerCostRatesFromEnv() {
  return {
    openai: {
      inputPer1MUsd: env.OPENAI_INPUT_COST_PER_1M_USD,
      outputPer1MUsd: env.OPENAI_OUTPUT_COST_PER_1M_USD
    },
    gemini: {
      inputPer1MUsd: env.GEMINI_INPUT_COST_PER_1M_USD,
      outputPer1MUsd: env.GEMINI_OUTPUT_COST_PER_1M_USD
    }
  };
}

export function estimateCostDetails({ provider, model, inputTokens = 0, outputTokens = 0 }) {
  return calculateCostDetails({
    provider, model, inputTokens, outputTokens,
    modelCostRates: env.MODEL_COST_RATES,
    providerCostRates: providerCostRatesFromEnv()
  });
}

export function estimateCostUsd({ provider, model, inputTokens = 0, outputTokens = 0 }) {
  return estimateCostDetails({ provider, model, inputTokens, outputTokens }).estimatedCostUsd;
}
