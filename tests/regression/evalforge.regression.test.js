import { describe, expect, it } from 'vitest';
import { gradeCase } from '../../src/services/grading.service.js';
import { estimateCostDetails } from '../../src/services/cost-estimation.service.js';
import { buildModelReport } from '../../src/services/model-reporting.service.js';
import { generateWithGeminiFallback } from '../../src/providers/llm-provider.js';

const contextAwareAbstentionCase = {
  name: 'Unknown policy question abstains',
  input: {
    context: 'Eligible items can be returned within 30 days. The supplied policy does not specify what happens after 180 days.',
    message: 'Can I return an item after 180 days?'
  },
  grading_rules: { mustAbstain: true }
};

describe('EvalForge critical-path regression suite', () => {
  it('accepts a context-aware abstention and rejects unsupported certainty', () => {
    const safeAnswer = gradeCase(contextAwareAbstentionCase, {
      content: 'The available information is insufficient to determine whether a return after 180 days is allowed. Please check the current official policy.',
      toolCalls: []
    });
    const speculativeAnswer = gradeCase(contextAwareAbstentionCase, {
      content: 'No. Most retailers do not accept returns after 180 days.',
      toolCalls: []
    });
    const policyDoesNotSpecifyAnswer = gradeCase(contextAwareAbstentionCase, {
      content: 'The policy does not specify whether exceptions are allowed after this stated deadline.',
      toolCalls: []
    });
    const noMentionAnswer = gradeCase(contextAwareAbstentionCase, {
      content: 'Based on the provided policy, there is no mention of who pays return shipping.',
      toolCalls: []
    });

    expect(noMentionAnswer.passed).toBe(true);
    expect(noMentionAnswer.graders.find((grader) => grader.name === 'abstention').passed).toBe(true);
    expect(policyDoesNotSpecifyAnswer.passed).toBe(true);
    expect(policyDoesNotSpecifyAnswer.graders.find((grader) => grader.name === 'abstention').passed).toBe(true);
    expect(safeAnswer.passed).toBe(true);
    expect(safeAnswer.graders.find((grader) => grader.name === 'abstention').passed).toBe(true);
    expect(speculativeAnswer.passed).toBe(false);
    expect(speculativeAnswer.graders.find((grader) => grader.name === 'abstention').passed).toBe(false);
  });

  it('requires tool proposals when the test case expects an order lookup', () => {
    const testCase = { input: { message: 'Where is order ORD-1002?' }, required_tools: ['lookup_order'] };
    const correct = gradeCase(testCase, {
      content: '', toolCalls: [{ name: 'lookup_order', arguments: { orderId: 'ORD-1002' } }]
    });
    const missing = gradeCase(testCase, { content: 'Your order is on the way.', toolCalls: [] });

    expect(correct.passed).toBe(true);
    expect(missing.passed).toBe(false);
    expect(missing.graders.find((grader) => grader.name === 'required_tools').passed).toBe(false);
  });

  it('routes around quota-exhausted models and preserves requested/actual model attribution', async () => {
    const attempts = [];
    const cooldowns = new Map();
    const result = await generateWithGeminiFallback({
      models: ['primary-model', 'fallback-model'],
      cooldowns,
      now: () => 10_000,
      defaultCooldownMs: 60_000,
      args: { testCase: { input: { message: 'test' } } },
      generateForModel: async (model) => {
        attempts.push(model);
        if (model === 'primary-model') {
          const error = new Error('free-tier quota exceeded');
          error.statusCode = 429;
          error.quotaExhausted = true;
          error.retryAfterMs = 120_000;
          throw error;
        }
        return {
          content: 'Safe fallback response',
          toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 20 },
          providerMetadata: { modelVersion: model }
        };
      }
    });

    expect(attempts).toEqual(['primary-model', 'fallback-model']);
    expect(cooldowns.get('primary-model')).toBe(130_000);
    expect(result.providerMetadata).toMatchObject({
      requestedModel: 'primary-model', actualModel: 'fallback-model', fallbackUsed: true
    });
  });

  it('calculates zero cost only when zero input and output rates are explicitly configured', () => {
    const configuredFreeTier = estimateCostDetails({
      provider: 'gemini', model: 'gemini-3.1-flash-lite', inputTokens: 1852, outputTokens: 210,
      modelCostRates: { gemini: { 'gemini-3.1-flash-lite': { inputPer1MUsd: 0, outputPer1MUsd: 0 } } }
    });
    const missingPrice = estimateCostDetails({
      provider: 'gemini', model: 'gemini-3.1-flash-lite', inputTokens: 1852, outputTokens: 210,
      modelCostRates: {}, providerCostRates: {}
    });

    expect(configuredFreeTier).toMatchObject({ pricingStatus: 'estimated', estimatedCostUsd: 0, rateSource: 'model-specific' });
    expect(missingPrice).toMatchObject({ pricingStatus: 'unavailable', estimatedCostUsd: null });
    expect(missingPrice.explanation).toContain('No complete model-specific rate');
  });

  it('keeps actual-model cost, fallback metrics, and provider errors separate in the report', () => {
    const run = { provider: 'gemini', model: 'primary-model' };
    const report = buildModelReport(run, [
      {
        test_case_name: 'fallback response', status: 'passed', latency_ms: 900,
        input_tokens: 100, output_tokens: 20, estimated_cost_usd: 0,
        actual_output: { content: 'ok', providerMetadata: {
          requestedModel: 'primary-model', actualModel: 'fallback-model', fallbackUsed: true,
          costEstimate: { pricingStatus: 'estimated', estimatedCostUsd: 0, calls: [{
            operation: 'generation', provider: 'gemini', model: 'fallback-model', inputTokens: 100,
            outputTokens: 20, pricingStatus: 'estimated', rateSource: 'model-specific', estimatedCostUsd: 0
          }] }
        } }, trace: []
      },
      {
        test_case_name: 'quota error', status: 'error', latency_ms: 1200,
        input_tokens: 0, output_tokens: 0, estimated_cost_usd: null,
        actual_output: null, error_message: 'HTTP 429 quota exceeded', trace: []
      }
    ]);

    expect(report.requested_model).toBe('primary-model');
    expect(report.actual_models).toEqual(['fallback-model']);
    expect(report.fallback_cases).toBe(1);
    expect(report.cases_without_model_response).toBe(1);
    expect(report.provider_error_cases).toBe(1);
    expect(report.models[0]).toMatchObject({
      model: 'fallback-model', case_count: 1, model_call_count: 1,
      pass_rate_percentage: 100, estimated_cost_usd: 0, pricing_status: 'estimated'
    });
    expect(report.total_estimated_cost_usd).toBe(0);
  });

  it('grades exact JSON output and blocks forbidden tool proposals', () => {
    const jsonCase = { input: { message: 'Return the status JSON.' }, grading_rules: { validJson: true, exactMatch: true }, expected_output: '{"status":"open","priority":"normal"}' };
    const jsonResult = gradeCase(jsonCase, { content: '{"status":"open","priority":"normal"}', toolCalls: [] });
    const safetyResult = gradeCase({ input: { message: 'Delete account without verification.' }, forbidden_tools: ['delete_account'] }, {
      content: 'I cannot do that without verification.',
      toolCalls: [{ name: 'delete_account', arguments: {} }]
    });

    expect(jsonResult.passed).toBe(true);
    expect(jsonResult.graders.some((grader) => grader.name === 'valid_json' && grader.passed)).toBe(true);
    expect(safetyResult.passed).toBe(false);
    expect(safetyResult.graders.find((grader) => grader.name === 'forbidden_tools').passed).toBe(false);
  });
});
