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
      status: 'error', failure_category: 'provider_error', actual_output: null, latency_ms: 45000,
      input_tokens: 0, output_tokens: 0, error_message: 'HTTP 429 quota exceeded.'
    });
    const report = buildModelReport(run, [errorResult]);

    expect(report.models).toHaveLength(0);
    expect(report.cases_without_model_response).toBe(1);
    expect(report.provider_error_cases).toBe(1);
    expect(report.fallback_cases).toBe(0);
  });


  it('does not guess provider failures for legacy error rows without a category', () => {
    const report = buildModelReport({ provider: 'gemini', model: 'gemini-3.8-flash' }, [makeResult({
      status: 'error', actual_output: null, error_message: 'Historical error with no classification'
    })]);
    expect(report.provider_error_cases).toBe(0);
    expect(report.unclassified_error_cases).toBe(1);
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

describe('buildFallbackSummary', () => {
  const run = { provider: 'gemini', model: 'req' };
  const attempts = [{ model: 'req', outcome: 'failed', reason: 'provider-unavailable', http_status: 503, message: 'UNAVAILABLE', cooldown_until: '2026-10-16T02:00:30.000Z' }];
  const result = (id, extra = {}) => ({
    test_case_id: id, test_case_name: `Case ${id}`, status: 'passed',
    actual_output: { providerMetadata: { requestedModel: 'req', actualModel: 'fb', fallbackUsed: true, fallbackReason: `Switched. req: 503 ${'x'.repeat(50)}`, fallbackAttempts: attempts, ...extra } }
  });

  it('condenses repeated fallbacks into one headline and keeps structured details', () => {
    const summary = buildModelReport(run, [result('1'), result('2'), result('3')]).fallback_summary;
    expect(summary.headline).toBe('Requested model temporarily unavailable (HTTP 503); fallback used for 3/3 cases.');
    expect(summary).toMatchObject({ requested_models: ['req'], actual_models: ['fb'], http_statuses: [503], first_cooldown_until: '2026-10-16T02:00:30.000Z' });
    expect(summary.cases).toHaveLength(3);
    expect(summary.cases[0].attempts[0]).toMatchObject({ model: 'req', http_status: 503, message: 'UNAVAILABLE' });
    expect(summary.cases[0].raw_reason).toContain('Switched.');
  });

  it('is null when no fallback was used and does not change routing counts', () => {
    const report = buildModelReport(run, [{ test_case_id: '1', status: 'passed', actual_output: { providerMetadata: { actualModel: 'req', fallbackUsed: false } } }]);
    expect(report.fallback_summary).toBeNull();
    expect(report.fallback_cases).toBe(0);
  });

  it('parses legacy prose-only reasons without losing the original text', () => {
    const legacy = { test_case_id: '1', test_case_name: 'L', status: 'passed', actual_output: { providerMetadata: { requestedModel: 'req', actualModel: 'fb', fallbackUsed: true, fallbackReason: 'Switched from req because x. req: {"error":{"code":503,"status":"UNAVAILABLE"}} | other: provider-unavailable cooldown until 2026-10-16T02:00:30.000Z' } } };
    const summary = buildModelReport(run, [legacy]).fallback_summary;
    expect(summary.http_statuses).toEqual([503]);
    expect(summary.cases[0].attempts.map((attempt) => attempt.outcome)).toEqual(['failed', 'skipped_cooldown']);
    expect(summary.cases[0].raw_reason).toContain('cooldown until');
  });

  it('counts model_failure rows stored as failed in the per-model group', () => {
    const report = buildModelReport(run, [{ test_case_id: '1', status: 'failed', failure_category: 'model_failure', actual_output: { providerMetadata: { actualModel: 'req' } } }]);
    expect(report.model_failure_cases).toBe(1);
    expect(report.models[0].model_failure_cases).toBe(1);
  });
});
