import { describe, expect, it } from 'vitest';
import { estimateCostDetails } from '../../src/services/cost-estimation.service.js';

describe('model-specific cost estimation', () => {
  it('prefers exact model rates over provider-wide fallback rates', () => {
    const result = estimateCostDetails({
      provider: 'gemini', model: 'gemini-3.1-flash-lite', inputTokens: 100, outputTokens: 50,
      modelCostRates: { gemini: { 'gemini-3.1-flash-lite': { inputPer1MUsd: 0.25, outputPer1MUsd: 1 } } },
      providerCostRates: { gemini: { inputPer1MUsd: 99, outputPer1MUsd: 99 } }
    });
    expect(result.pricingStatus).toBe('estimated');
    expect(result.rateSource).toBe('model-specific');
    expect(result.estimatedCostUsd).toBe(0.000075);
  });

  it('labels provider-wide fallback estimates so they are not mistaken for exact model pricing', () => {
    const result = estimateCostDetails({
      provider: 'gemini', model: 'gemini-unconfigured', inputTokens: 100, outputTokens: 50,
      modelCostRates: {},
      providerCostRates: { gemini: { inputPer1MUsd: 1, outputPer1MUsd: 2 } }
    });
    expect(result.pricingStatus).toBe('estimated');
    expect(result.rateSource).toBe('provider-default');
    expect(result.explanation).toContain('may not match the exact model');
    expect(result.estimatedCostUsd).toBe(0.0002);
  });

  it('explains missing rates instead of guessing cost', () => {
    const result = estimateCostDetails({
      provider: 'gemini', model: 'gemini-unconfigured', inputTokens: 100, outputTokens: 50,
      modelCostRates: {}, providerCostRates: { gemini: { inputPer1MUsd: 1 } }
    });
    expect(result.pricingStatus).toBe('unavailable');
    expect(result.estimatedCostUsd).toBeNull();
    expect(result.explanation).toContain('output rate is missing');
    expect(result.explanation).toContain('MODEL_COST_RATES_JSON');
  });

  it('supports zero rates when explicitly configured and handles mock mode transparently', () => {
    const freeTier = estimateCostDetails({
      provider: 'gemini', model: 'gemini-free', inputTokens: 100, outputTokens: 50,
      modelCostRates: { gemini: { 'gemini-free': { inputPer1MUsd: 0, outputPer1MUsd: 0 } } }
    });
    expect(freeTier.estimatedCostUsd).toBe(0);
    expect(freeTier.rateSource).toBe('model-specific');

    const mock = estimateCostDetails({ provider: 'mock', model: 'mock-v1' });
    expect(mock.pricingStatus).toBe('not_applicable');
    expect(mock.estimatedCostUsd).toBe(0);
    expect(mock.explanation).toContain('no API usage charge');
  });

  it('prices cached input separately and preserves pricing provenance in the snapshot', () => {
    const result = estimateCostDetails({
      provider: 'openai', model: 'gpt-test', inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100,
      modelCostRates: { openai: { 'gpt-test': {
        inputPer1MUsd: 2, cachedInputPer1MUsd: 0.5, outputPer1MUsd: 8,
        pricingSource: 'provider pricing page', effectiveDate: '2026-10-01', tier: 'standard',
        assumptions: ['USD list pricing']
      } } }
    });
    expect(result.pricingStatus).toBe('estimated');
    expect(result.estimatedCostUsd).toBe(0.0022);
    expect(result).toMatchObject({
      rateSource: 'model-specific', pricingSource: 'provider pricing page',
      pricingEffectiveDate: '2026-10-01', pricingTier: 'standard',
      pricingAssumptions: ['USD list pricing'], cachedInputRatePer1MUsd: 0.5
    });
    expect(Number.isNaN(Date.parse(result.pricingCapturedAt))).toBe(false);
  });

  it('keeps a known subtotal when cached or extra billable usage lacks rates', () => {
    const cached = estimateCostDetails({
      provider: 'gemini', model: 'gemini-test', inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100,
      modelCostRates: { gemini: { 'gemini-test': { inputPer1MUsd: 2, outputPer1MUsd: 8 } } }
    });
    expect(cached.pricingStatus).toBe('partial');
    expect(cached.estimatedCostUsd).toBeNull();
    expect(cached.knownEstimatedCostUsd).toBe(0.002);
    expect(cached.explanation).toContain('no cachedInputPer1MUsd rate');

    const extra = estimateCostDetails({
      provider: 'gemini', model: 'gemini-test', inputTokens: 1000, outputTokens: 100,
      modelCostRates: { gemini: { 'gemini-test': { inputPer1MUsd: 2, outputPer1MUsd: 8 } } },
      unsupportedCategories: ['tool-use prompt tokens']
    });
    expect(extra.pricingStatus).toBe('partial');
    expect(extra.estimatedCostUsd).toBeNull();
    expect(extra.explanation).toContain('tool-use prompt tokens usage was reported');
  });
});
