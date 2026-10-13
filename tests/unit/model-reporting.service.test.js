import { describe, expect, it } from 'vitest';
import { buildModelReport } from '../../src/services/model-reporting.service.js';

const makeResult = (overrides = {}) => ({
  test_case_name: 'sample',
  status: 'passed',
  actual_output: { content: 'ok', providerMetadata: { requestedModel: 'gemini-3.8-flash', actualModel: 'gemini-3.1-flash-lite', fallbackUsed: true, fallbackReason: 'Primary quota exceeded.' } },
  latency_ms: 1200,
  input_tokens: 100,
  output_tokens: 25,
  estimated_cost_usd: null,
  trace: [],
  ...overrides
});

describe('buildModelReport', () => {
  it('separates requested and actual model and aggregates fallback metrics', () => {
    const run = { provider: 'gemini', model: 'gemini-3.8-flash' };
    const report = buildModelReport(run, [makeResult(), makeResult({ test_case_name: 'second' })]);

    expect(report.requested_model).toBe('gemini-3.8-flash');
    expect(report.actual_models).toEqual(['gemini-3.1-flash-lite']);
    expect(report.mixed_model_run).toBe(false);
    expect(report.fallback_cases).toBe(2);
    expect(report.models[0].case_count).toBe(2);
    expect(report.models[0].pass_rate_percentage).toBe(100);
    expect(report.models[0].total_tokens).toBe(250);
    expect(report.models[0].fallback_reasons).toEqual(['Primary quota exceeded.']);
  });

  it('does not attribute provider errors to a model that never answered', () => {
    const run = { provider: 'gemini', model: 'gemini-3.8-flash' };
    const errorResult = makeResult({
      status: 'error', actual_output: null, latency_ms: 45000,
      input_tokens: 0, output_tokens: 0, error_message: 'HTTP 429 quota exceeded.'
    });
    const report = buildModelReport(run, [errorResult]);

    expect(report.models).toHaveLength(0);
    expect(report.cases_without_model_response).toBe(1);
    expect(report.provider_error_cases).toBe(1);
    expect(report.fallback_cases).toBe(0);
  });

  it('reports mixed-model runs separately by actual model', () => {
    const run = { provider: 'gemini', model: 'gemini-3.8-flash' };
    const report = buildModelReport(run, [
      makeResult(),
      makeResult({ actual_output: { content: 'ok', providerMetadata: { requestedModel: 'gemini-3.8-flash', actualModel: 'gemini-3.5-flash-lite', fallbackUsed: true } } })
    ]);

    expect(report.mixed_model_run).toBe(true);
    expect(report.model_count).toBe(2);
    expect(report.actual_models).toContain('gemini-3.1-flash-lite');
    expect(report.actual_models).toContain('gemini-3.5-flash-lite');
  });

  it('uses the configured mock model label for deterministic mock outputs', () => {
    const run = { provider: 'mock', model: 'mock-v1' };
    const report = buildModelReport(run, [makeResult({ actual_output: { content: 'ok', providerMetadata: { mode: 'mock', deterministic: true } }, trace: [] })]);
    expect(report.actual_models).toEqual(['mock-v1']);
    expect(report.models[0].pass_rate_percentage).toBe(100);
  });

  it('reports configured model-call cost, rate source, tokens, and total estimated cost', () => {
    const run = { provider: 'gemini', model: 'gemini-primary' };
    const report = buildModelReport(run, [makeResult({
      actual_output: { content: 'ok', providerMetadata: {
        requestedModel: 'gemini-primary', actualModel: 'gemini-fallback',
        costEstimate: { pricingStatus: 'estimated', estimatedCostUsd: 0.00012, calls: [{
          operation: 'generation', provider: 'gemini', model: 'gemini-fallback',
          inputTokens: 200, outputTokens: 30, pricingStatus: 'estimated', rateSource: 'model-specific',
          estimatedCostUsd: 0.00012, explanation: 'Estimated with exact model rates.'
        }] }
      } }, input_tokens: 200, output_tokens: 30, estimated_cost_usd: 0.00012
    })]);

    const model = report.models.find((item) => item.model === 'gemini-fallback');
    expect(model.model_call_count).toBe(1);
    expect(model.total_input_tokens).toBe(200);
    expect(model.total_output_tokens).toBe(30);
    expect(model.estimated_cost_usd).toBe(0.00012);
    expect(model.pricing_status).toBe('estimated');
    expect(model.pricing_sources).toContain('model-specific');
    expect(report.total_estimated_cost_usd).toBe(0.00012);
  });

  it('marks run cost as partial when one model call has rates and another call is unpriced', () => {
    const run = { provider: 'gemini', model: 'gemini-primary' };
    const report = buildModelReport(run, [makeResult({
      actual_output: { content: 'ok', providerMetadata: {
        requestedModel: 'gemini-primary', actualModel: 'gemini-primary',
        costEstimate: { pricingStatus: 'partial', estimatedCostUsd: null, knownEstimatedCostUsd: 0.000075, calls: [
          { operation: 'generation', provider: 'gemini', model: 'gemini-primary', inputTokens: 100, outputTokens: 50, pricingStatus: 'estimated', rateSource: 'model-specific', estimatedCostUsd: 0.000075, explanation: 'Configured generation rate.' },
          { operation: 'llm_judge', provider: 'gemini', model: 'gemini-judge', inputTokens: 200, outputTokens: 20, pricingStatus: 'unavailable', rateSource: null, estimatedCostUsd: null, explanation: 'Judge model pricing is missing.' }
        ] }
      } }, estimated_cost_usd: null, input_tokens: 300, output_tokens: 70
    })]);

    expect(report.total_estimated_cost_usd).toBeNull();
    expect(report.total_cost_status).toBe('partial');
    expect(report.total_known_estimated_cost_usd).toBe(0.000075);
    expect(report.total_cost_explanation).toContain('gemini-judge');
    expect(report.models.find((item) => item.model === 'gemini-judge').call_operations).toContain('llm_judge');
  });

  it('explains when exact model rates and provider-wide fallback rates are unavailable', () => {
    const run = { provider: 'gemini', model: 'gemini-primary' };
    const report = buildModelReport(run, [makeResult({
      actual_output: { content: 'ok', providerMetadata: {
        requestedModel: 'gemini-primary', actualModel: 'gemini-fallback',
        costEstimate: { pricingStatus: 'unavailable', estimatedCostUsd: null, explanation: 'Configure input and output rates.' , calls: [{
          operation: 'generation', provider: 'gemini', model: 'gemini-fallback', inputTokens: 100, outputTokens: 20,
          pricingStatus: 'unavailable', rateSource: null, estimatedCostUsd: null, explanation: 'Configure input and output rates.'
        }] }
      } }, estimated_cost_usd: null
    })]);

    const model = report.models.find((item) => item.model === 'gemini-fallback');
    expect(model.pricing_status).toBe('unavailable');
    expect(model.estimated_cost_usd).toBeNull();
    expect(model.pricing_explanation).toContain('Configure input and output rates.');
    expect(report.total_cost_status).toBe('unavailable');
    expect(report.total_cost_explanation).toContain('gemini-fallback');
  });
});
