import { describe, expect, it } from 'vitest';
import { buildModelInput, buildGeminiModelChain, createLlmProvider, estimateCostUsd, generateWithGeminiFallback, getGeminiCooldownMs, mapGeminiResponse, parseRetryDelayMs, toGeminiSchema } from '../../src/providers/llm-provider.js';


describe('real-provider test input building', () => {
  it('includes case context with the user message', () => {
    const prompt = buildModelInput({
      message: 'Can I return this after 180 days?',
      context: 'The supplied policy does not specify returns after 180 days.',
      mock_response: { content: 'This fixture must not be sent to real models.' }
    });

    expect(prompt).toContain('The supplied policy does not specify returns after 180 days.');
    expect(prompt).toContain('Can I return this after 180 days?');
    expect(prompt).not.toContain('mock_response');
    expect(prompt).not.toContain('This fixture must not be sent to real models.');
  });

  it('preserves existing message-only inputs', () => {
    expect(buildModelInput({ message: 'hello' })).toBe('hello');
    expect(buildModelInput('hello')).toBe('hello');
  });
});

describe('mock LLM provider', () => {
  it('returns a configured fixture deterministically', async () => {
    const provider = createLlmProvider({ provider: 'mock', model: 'mock-v1' });
    const testCase = { input: { message: 'Where is my order?', mock_response: { content: 'Order shipped.', toolCalls: [{ name: 'lookup_order', arguments: { id: '1' } }] } } };
    const first = await provider.generate({ testCase, systemPrompt: 'Be helpful' });
    const second = await provider.generate({ testCase, systemPrompt: 'Be helpful' });
    expect(first).toEqual(second);
    expect(first.content).toBe('Order shipped.');
    expect(first.toolCalls[0].name).toBe('lookup_order');
  });

  it('has a fallback response when no fixture is supplied', async () => {
    const provider = createLlmProvider({ provider: 'mock' });
    const response = await provider.generate({ testCase: { input: { message: 'hello' } } });
    expect(response.content).toContain('hello');
  });

  it('reports mock provider usage as zero external API cost', () => {
    expect(estimateCostUsd({ provider: 'mock', model: 'mock-v1', inputTokens: 10, outputTokens: 20 })).toBe(0);
  });
});


describe('Gemini response mapping', () => {
  it('normalizes text, proposed function calls, token usage, and metadata', () => {
    const mapped = mapGeminiResponse({
      responseId: 'resp-demo',
      modelVersion: 'gemini-3.8-flash',
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [
          { text: 'Internal thought summary should not be graded.', thought: true },
          { text: 'Looking up the order now.' },
          { functionCall: { name: 'lookup_order', args: { orderId: 'ORD-1002' } } }
        ] }
      }],
      usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 8, thoughtsTokenCount: 3, totalTokenCount: 32 }
    });

    expect(mapped.content).toBe('Looking up the order now.');
    expect(mapped.toolCalls).toEqual([{ name: 'lookup_order', arguments: { orderId: 'ORD-1002' } }]);
    expect(mapped.usage).toEqual({ inputTokens: 21, outputTokens: 11 });
    expect(mapped.providerMetadata.thoughtsTokens).toBe(3);
    expect(mapped.providerMetadata.finishReason).toBe('STOP');
    expect(mapped.providerMetadata.modelVersion).toBe('gemini-3.8-flash');
  });

  it('handles an empty or blocked Gemini response without crashing', () => {
    expect(mapGeminiResponse({})).toMatchObject({
      content: '', toolCalls: [], usage: null
    });
  });

  it('converts standard JSON Schema types for Gemini function declarations', () => {
    expect(toGeminiSchema({
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'The order identifier.' },
        limit: { type: 'integer' },
        items: { type: 'array', items: { type: 'string' } }
      },
      required: ['orderId']
    })).toEqual({
      type: 'OBJECT',
      properties: {
        orderId: { type: 'STRING', description: 'The order identifier.' },
        limit: { type: 'INTEGER' },
        items: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['orderId']
    });
  });
});


describe('provider retry delay parsing', () => {
  it('reads Gemini human-readable retry delays', () => {
    expect(parseRetryDelayMs('Please retry in 51.196596842s.')).toBe(51197);
  });

  it('reads an HTTP Retry-After value in seconds', () => {
    expect(parseRetryDelayMs('', '3')).toBe(3000);
  });

  it('reads structured retryDelay values', () => {
    expect(parseRetryDelayMs('{"error":{"details":[{"retryDelay":"2.5s"}]}}')).toBe(2500);
  });

  it('parses compact multi-unit retry durations from quota errors', () => {
    expect(parseRetryDelayMs('Please retry in 20h15m33.347750059s.')).toBe(72933348);
  });

  it('returns null when no retry hint exists', () => {
    expect(parseRetryDelayMs('{"error":{"message":"quota exceeded"}}')).toBeNull();
  });
});


describe('Gemini model fallback strategy', () => {
  it('builds an ordered fallback chain and removes duplicate model IDs', () => {
    expect(buildGeminiModelChain(
      'gemini-3.8-flash',
      'gemini-3.1-flash-lite, gemini-3.5-flash-lite,gemini-3.1-flash-lite, '
    )).toEqual([
      'gemini-3.8-flash',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite'
    ]);
  });

  it('switches to the next model on quota exhaustion and records which model responded', async () => {
    const calls = [];
    const cooldowns = new Map();
    const response = await generateWithGeminiFallback({
      models: ['primary-model', 'fallback-model'],
      cooldowns,
      now: () => 1000,
      defaultCooldownMs: 60000,
      args: { testCase: {} },
      generateForModel: async (model) => {
        calls.push(model);
        if (model === 'primary-model') {
          const error = new Error('quota exceeded, free_tier_requests');
          error.statusCode = 429;
          error.quotaExhausted = true;
          error.retryAfterMs = 3600000;
          throw error;
        }
        return { content: 'Fallback response', toolCalls: [], providerMetadata: { responseId: 'demo-response' } };
      }
    });

    expect(calls).toEqual(['primary-model', 'fallback-model']);
    expect(cooldowns.get('primary-model')).toBe(3601000);
    expect(response.content).toBe('Fallback response');
    expect(response.providerMetadata).toMatchObject({
      responseId: 'demo-response', requestedModel: 'primary-model',
      actualModel: 'fallback-model', fallbackUsed: true
    });
    expect(response.providerMetadata.fallbackReason).toContain('primary-model');
  });

  it('switches to the next model after a request timeout and records timeout fallback metadata', async () => {
    const calls = [];
    const cooldowns = new Map();
    const cooldownReasons = new Map();
    const response = await generateWithGeminiFallback({
      models: ['slow-model', 'fallback-model'],
      cooldowns,
      cooldownReasons,
      now: () => 1000,
      timeoutCooldownMs: 60000,
      args: {},
      generateForModel: async (model) => {
        calls.push(model);
        if (model === 'slow-model') {
          const error = new Error('Gemini request timed out after 45000 ms.');
          error.name = 'TimeoutError';
          error.code = 'GEMINI_REQUEST_TIMEOUT';
          error.providerTimeout = true;
          throw error;
        }
        return { content: 'Fallback response', toolCalls: [], providerMetadata: {} };
      }
    });

    expect(calls).toEqual(['slow-model', 'fallback-model']);
    expect(cooldowns.get('slow-model')).toBe(61000);
    expect(cooldownReasons.get('slow-model')).toBe('timeout');
    expect(response.providerMetadata).toMatchObject({
      requestedModel: 'slow-model', actualModel: 'fallback-model', fallbackUsed: true
    });
    expect(response.providerMetadata.fallbackReason).toContain('timed out');
  });

  it('falls back to the next model when Gemini returns HTTP 503 high demand', async () => {
    const calls = [];
    const cooldowns = new Map();
    const cooldownReasons = new Map();
    const response = await generateWithGeminiFallback({
      models: ['busy-model', 'fallback-model'],
      cooldowns,
      cooldownReasons,
      now: () => 1000,
      unavailableCooldownMs: 30000,
      args: {},
      generateForModel: async (model) => {
        calls.push(model);
        if (model === 'busy-model') {
          const error = new Error('LLM provider returned HTTP 503: model is experiencing high demand.');
          error.statusCode = 503;
          throw error;
        }
        return { content: 'Grounded fallback response', toolCalls: [], providerMetadata: {} };
      }
    });

    expect(calls).toEqual(['busy-model', 'fallback-model']);
    expect(cooldowns.get('busy-model')).toBe(31000);
    expect(cooldownReasons.get('busy-model')).toBe('provider-unavailable');
    expect(response.content).toBe('Grounded fallback response');
    expect(response.providerMetadata).toMatchObject({
      requestedModel: 'busy-model', actualModel: 'fallback-model', fallbackUsed: true
    });
    expect(response.providerMetadata.fallbackReason).toContain('HTTP 503');
  });

  it('reports a provider-unavailable error if all configured models return HTTP 503', async () => {
    const cooldowns = new Map();
    const cooldownReasons = new Map();
    await expect(generateWithGeminiFallback({
      models: ['busy-model', 'also-busy-model'],
      cooldowns,
      cooldownReasons,
      now: () => 1000,
      unavailableCooldownMs: 30000,
      args: {},
      generateForModel: async (model) => {
        const error = new Error(`LLM provider returned HTTP 503 for ${model}: high demand.`);
        error.statusCode = 503;
        throw error;
      }
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'GEMINI_MODELS_UNAVAILABLE',
      quotaExhausted: false,
      providerUnavailable: true
    });
  });

  it('returns an explicit timeout error when all configured models time out', async () => {
    const cooldowns = new Map();
    const cooldownReasons = new Map();
    await expect(generateWithGeminiFallback({
      models: ['slow-model'],
      cooldowns,
      cooldownReasons,
      now: () => 1000,
      timeoutCooldownMs: 60000,
      args: {},
      generateForModel: async () => {
        const error = new Error('Gemini request timed out after 45000 ms.');
        error.name = 'TimeoutError';
        error.code = 'GEMINI_REQUEST_TIMEOUT';
        error.providerTimeout = true;
        throw error;
      }
    })).rejects.toMatchObject({
      statusCode: 504, providerTimeout: true, code: 'GEMINI_REQUEST_TIMEOUT'
    });
  });

  it('skips a model already in cooldown without calling it again', async () => {
    const calls = [];
    const cooldowns = new Map([['primary-model', 5000]]);
    const response = await generateWithGeminiFallback({
      models: ['primary-model', 'fallback-model'],
      cooldowns,
      now: () => 1000,
      args: {},
      generateForModel: async (model) => {
        calls.push(model);
        return { content: 'OK', toolCalls: [], providerMetadata: {} };
      }
    });

    expect(calls).toEqual(['fallback-model']);
    expect(response.providerMetadata.actualModel).toBe('fallback-model');
    expect(response.providerMetadata.fallbackUsed).toBe(true);
  });

  it('does not hide authentication/configuration errors by switching models', async () => {
    const calls = [];
    await expect(generateWithGeminiFallback({
      models: ['primary-model', 'fallback-model'],
      cooldowns: new Map(),
      now: () => 1000,
      args: {},
      generateForModel: async (model) => {
        calls.push(model);
        const error = new Error('Invalid API key');
        error.statusCode = 403;
        throw error;
      }
    })).rejects.toThrow('Invalid API key');
    expect(calls).toEqual(['primary-model']);
  });

  it('reports when every configured model is still in cooldown', async () => {
    await expect(generateWithGeminiFallback({
      models: ['primary-model', 'fallback-model'],
      cooldowns: new Map([['primary-model', 5000], ['fallback-model', 9000]]),
      now: () => 1000,
      args: {},
      generateForModel: async () => { throw new Error('This should not be called'); }
    })).rejects.toMatchObject({ statusCode: 429, quotaExhausted: true, retryAfterMs: 4000 });
  });

  it('honors provider retry times and safely defers daily quota errors without a hint', () => {
    expect(getGeminiCooldownMs({ retryAfterMs: 3600000 }, 60000)).toBe(3600000);
    expect(getGeminiCooldownMs({ message: 'free_tier_requests quota exceeded' }, 60000)).toBe(86400000);
    expect(getGeminiCooldownMs({ message: 'temporary rate limit' }, 60000)).toBe(60000);
  });
});
