import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saved = [];
const repo = vi.hoisted(() => ({
  state: { run: { id: 'r1', provider: 'gemini', model: 'req-model', system_prompt: 's', status: 'running' }, cases: [] },
  saved: []
}));

vi.mock('../../src/repositories/evaluations.repository.js', () => ({
  addAuditEvent: vi.fn(),
  getEvaluationById: vi.fn(async () => repo.state.run),
  getEvaluationContext: vi.fn(async () => ({ run: repo.state.run, cases: repo.state.cases })),
  getResult: vi.fn(async () => null),
  markResultStarted: vi.fn(),
  saveEvaluationResult: vi.fn(async (row) => { repo.saved.push(row); }),
  updateRunStatus: vi.fn(async () => true)
}));

const provider = vi.hoisted(() => ({ generate: vi.fn(), judge: undefined }));
const cost = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../src/providers/llm-provider.js', () => ({
  createLlmProvider: () => ({ name: 'gemini', model: 'req-model', generate: provider.generate }),
  estimateCostDetails: (args) => {
    cost.calls.push(args);
    return {
      pricingStatus: 'estimated', estimatedCostUsd: (args.inputTokens + args.outputTokens) / 1e6,
      knownEstimatedCostUsd: (args.inputTokens + args.outputTokens) / 1e6,
      rateSource: 'model-specific', pricingSource: 'test source', pricingEffectiveDate: '2026-10-01',
      pricingTier: 'standard', pricingAssumptions: ['fixture'], pricingCapturedAt: '2026-10-18T00:00:00.000Z',
      model: args.model, explanation: 'ok'
    };
  }
}));

import { processEvaluationRun, usageWasReported } from '../../src/services/evaluation-runner.service.js';
import { buildEvaluationQualityReport } from '../../src/services/evaluation-quality.service.js';

const testCase = { id: 'tc1', name: 'Case', input: 'hi', required_keywords: ['hello'], forbidden_keywords: [], required_tools: [], forbidden_tools: [], grading_rules: {} };

beforeEach(() => { repo.saved.length = 0; cost.calls.length = 0; repo.state.cases = [testCase]; provider.generate.mockReset(); });
afterEach(() => vi.clearAllMocks());

const last = () => repo.saved.at(-1);

describe('failure classification in the runner', () => {
  it('classifies a provider HTTP 503 as provider_error at the generation stage (an error, not a graded failure)', async () => {
    provider.generate.mockRejectedValue(Object.assign(new Error('HTTP 503 UNAVAILABLE'), { statusCode: 503 }));
    await processEvaluationRun('r1');
    expect(last()).toMatchObject({ status: 'error', failureCategory: 'provider_error', errorStage: 'generation', score: null });
  });

  it('classifies an invalid response envelope as model_failure at model_response and counts it as graded failed', async () => {
    provider.generate.mockResolvedValue(null);
    await processEvaluationRun('r1');
    expect(last()).toMatchObject({ status: 'failed', failureCategory: 'model_failure', errorStage: 'model_response', score: 0 });
  });

  it('classifies a response with no usable text or tool calls as model_failure', async () => {
    provider.generate.mockResolvedValue({ content: '   ', toolCalls: [], usage: { inputTokens: 5, outputTokens: 0 }, providerMetadata: { actualModel: 'req-model' } });
    await processEvaluationRun('r1');
    expect(last()).toMatchObject({ status: 'failed', failureCategory: 'model_failure', errorStage: 'model_response' });
  });

  it('classifies a deterministic-grader exception as evaluator_error at the grading stage', async () => {
    // A response whose content getter throws makes the grader itself throw.
    provider.generate.mockResolvedValue({ get content() { throw new Error('grader blew up'); }, toolCalls: [] });
    await processEvaluationRun('r1');
    expect(last()).toMatchObject({ status: 'error', failureCategory: 'evaluator_error', errorStage: 'grading' });
  });

  it('leaves an ordinary graded failure unclassified (not a provider/evaluator error)', async () => {
    provider.generate.mockResolvedValue({ content: 'Goodbye.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 }, providerMetadata: { actualModel: 'req-model' } });
    await processEvaluationRun('r1');
    expect(last()).toMatchObject({ status: 'failed', failureCategory: null, errorStage: null });
  });
});

describe('fallback attribution and cost accounting', () => {
  it('prices a fallback response by the model that actually answered', async () => {
    provider.generate.mockResolvedValue({
      content: 'hello', toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 },
      providerMetadata: { requestedModel: 'req-model', actualModel: 'fallback-model', fallbackUsed: true }
    });
    await processEvaluationRun('r1');
    expect(cost.calls.at(-1)).toMatchObject({ model: 'fallback-model', inputTokens: 100, outputTokens: 50 });
    expect(last()).toMatchObject({ status: 'passed', inputTokens: 100, outputTokens: 50 });
    expect(last().actualOutput.providerMetadata.costEstimate.calls[0].model).toBe('fallback-model');
  });

  it('persists detailed usage and the per-call historical pricing snapshot', async () => {
    provider.generate.mockResolvedValue({
      content: 'hello', toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, reasoningTokens: 10, toolUsePromptTokens: 3, totalTokens: 150 },
      providerMetadata: { requestedModel: 'req-model', actualModel: 'fallback-model', fallbackUsed: true, serviceTier: 'priority' }
    });
    await processEvaluationRun('r1');
    expect(cost.calls.at(-1)).toMatchObject({
      model: 'fallback-model', cachedInputTokens: 20, unsupportedCategories: ['tool-use prompt tokens']
    });
    expect(last().actualOutput.providerMetadata.costEstimate.calls[0]).toMatchObject({
      cachedInputTokens: 20, reasoningTokens: 10, toolUsePromptTokens: 3, totalTokens: 150,
      providerServiceTier: 'priority', pricingSource: 'test source', pricingEffectiveDate: '2026-10-01'
    });
    expect(last().actualOutput.providerMetadata.costEstimate.pricingSnapshots[0]).toMatchObject({
      model: 'fallback-model', pricingTier: 'standard', pricingAssumptions: ['fixture'],
      pricingCapturedAt: '2026-10-18T00:00:00.000Z', providerServiceTier: 'priority'
    });
  });

  it('records unavailable cost, never an actual $0, when the provider reports no usage', async () => {
    provider.generate.mockResolvedValue({ content: 'hello', toolCalls: [], usage: null, providerMetadata: { actualModel: 'req-model' } });
    await processEvaluationRun('r1');
    expect(last().status).toBe('passed');
    expect(last().estimatedCostUsd).toBeNull();
    expect(last().actualOutput.providerMetadata.costEstimate.pricingStatus).toBe('unavailable');
    expect(cost.calls).toHaveLength(0);
  });

  it('usageWasReported only accepts finite numeric token counts', () => {
    expect(usageWasReported({ inputTokens: 0, outputTokens: 0 })).toBe(true);
    expect(usageWasReported(null)).toBe(false);
    expect(usageWasReported(undefined)).toBe(false);
    expect(usageWasReported({ inputTokens: 1 })).toBe(false);
  });
});

describe('legacy rows', () => {
  it('does not guess a category for legacy error rows', () => {
    const report = buildEvaluationQualityReport([
      { status: 'error', failure_category: null, error_message: 'old failure' },
      { status: 'error', failure_category: 'provider_error' },
      { status: 'passed' }
    ]);
    expect(report.failures).toMatchObject({ provider_errors: 1, evaluator_errors: 0, model_failures: 0, unclassified_legacy_errors: 1 });
    expect(report.model_quality).toMatchObject({ sample_size: 1, pass_rate_percentage: 100 });
  });
});
