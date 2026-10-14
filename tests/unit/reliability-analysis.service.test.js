import { describe, expect, it } from 'vitest';
import { buildReliabilityReport } from '../../src/services/reliability-analysis.service.js';

function makeRun(index, overrides = {}) {
  return {
    id: `run-${index}`,
    repetition_index: index,
    status: 'completed',
    provider: 'mock',
    model: 'mock-v1',
    total_cases: 3,
    completed_cases: 3,
    passed_cases: 2,
    failed_cases: 1,
    error_cases: 0,
    average_latency_ms: 120,
    total_input_tokens: 0,
    total_output_tokens: 0,
    estimated_cost_usd: 0,
    actual_model_names: ['mock-v1'],
    fallback_cases: 0,
    ...overrides
  };
}

function makeResult(runId, caseId, status, overrides = {}) {
  return {
    run_id: runId,
    test_case_id: caseId,
    test_case_name: caseId,
    status,
    actual_output: { content: 'fixture', providerMetadata: { mode: 'mock' } },
    latency_ms: 100,
    estimated_cost_usd: 0,
    ...overrides
  };
}

const campaign = { id: 'campaign-1', status: 'completed', repeat_count: 3 };

describe('buildReliabilityReport', () => {
  it('summarizes repeated run pass rates, range, variance, confidence interval, and stable cases', () => {
    const runs = [
      makeRun(1, { passed_cases: 3, failed_cases: 0 }),
      makeRun(2, { passed_cases: 2, failed_cases: 1 }),
      makeRun(3, { passed_cases: 1, failed_cases: 2 })
    ];
    const results = [
      makeResult('run-1', 'always-passes', 'passed'), makeResult('run-2', 'always-passes', 'passed'), makeResult('run-3', 'always-passes', 'passed'),
      makeResult('run-1', 'varies', 'passed'), makeResult('run-2', 'varies', 'failed'), makeResult('run-3', 'varies', 'passed'),
      makeResult('run-1', 'always-fails', 'failed'), makeResult('run-2', 'always-fails', 'failed'), makeResult('run-3', 'always-fails', 'failed')
    ];

    const report = buildReliabilityReport({ campaign, runs, results });
    expect(report.planned_runs).toBe(3);
    expect(report.completed_runs).toBe(3);
    expect(report.analyzed_runs).toBe(3);
    expect(report.average_pass_rate_percentage).toBe(66.67);
    expect(report.pass_rate_stddev_percentage_points).toBe(33.33);
    expect(report.pass_rate_confidence_interval_95.method).toContain("Student's t");
    expect(report.per_case.find((item) => item.test_case_id === 'always-passes').stable_across_repeats).toBe(true);
    expect(report.per_case.find((item) => item.test_case_id === 'varies').stable_across_repeats).toBe(false);
    expect(report.case_stability_percentage).toBe(66.67);
  });

  it('excludes provider errors from the pass-rate denominator and reports them separately', () => {
    const runs = [makeRun(1, { passed_cases: 1, failed_cases: 1, error_cases: 1, total_cases: 3 })];
    const results = [
      makeResult('run-1', 'pass', 'passed'),
      makeResult('run-1', 'fail', 'failed'),
      makeResult('run-1', 'error', 'error', { actual_output: null, estimated_cost_usd: null })
    ];
    const report = buildReliabilityReport({ campaign, runs, results });
    expect(report.run_summaries[0].pass_rate_percentage).toBe(50);
    expect(report.per_case.find((item) => item.test_case_id === 'error').error_runs).toBe(1);
  });

  it('does not fabricate a confidence interval for a single completed repeat', () => {
    const report = buildReliabilityReport({
      campaign: { ...campaign, repeat_count: 2 },
      runs: [makeRun(1, { total_cases: 1, completed_cases: 1, passed_cases: 1, failed_cases: 0 })],
      results: [makeResult('run-1', 'one-case', 'passed')]
    });
    expect(report.pass_rate_confidence_interval_95).toBeNull();
    expect(report.pass_rate_stddev_percentage_points).toBeNull();
  });

  it('marks aggregate cost unavailable when any answered case lacks a stored estimate', () => {
    const runs = [makeRun(1, { passed_cases: 2, failed_cases: 0, total_cases: 2 })];
    const results = [
      makeResult('run-1', 'priced', 'passed', { estimated_cost_usd: 0.0001 }),
      makeResult('run-1', 'unpriced', 'passed', { estimated_cost_usd: null })
    ];
    const report = buildReliabilityReport({ campaign, runs, results });
    expect(report.cost_estimate_status).toBe('partial');
    expect(report.total_estimated_cost_usd).toBeNull();
    expect(report.known_cost_subtotal_usd).toBe(0.0001);
  });


  it('does not assume an errored model call cost zero when usage was not recorded', () => {
    const runs = [makeRun(1, { passed_cases: 1, failed_cases: 0, error_cases: 1, total_cases: 2 })];
    const results = [
      makeResult('run-1', 'priced', 'passed', { estimated_cost_usd: 0 }),
      makeResult('run-1', 'error', 'error', { actual_output: null, estimated_cost_usd: null })
    ];
    const report = buildReliabilityReport({ campaign, runs, results });
    expect(report.cost_estimate_status).toBe('partial');
    expect(report.total_estimated_cost_usd).toBeNull();
    expect(report.run_summaries[0].estimated_cost_usd).toBeNull();
  });

  it('records mixed actual-model routing rather than assuming the requested model answered', () => {
    const runs = [
      makeRun(1, { provider: 'gemini', model: 'gemini-primary', actual_model_names: ['gemini-fallback'] }),
      makeRun(2, { provider: 'gemini', model: 'gemini-primary', actual_model_names: ['gemini-primary', 'gemini-fallback'] })
    ];
    const results = [
      makeResult('run-1', 'a', 'passed', { actual_output: { content: 'ok', providerMetadata: { actualModel: 'gemini-fallback' } } }),
      makeResult('run-2', 'a', 'passed', { actual_output: { content: 'ok', providerMetadata: { actualModel: 'gemini-primary' } } }),
      makeResult('run-2', 'b', 'failed', { actual_output: { content: 'no', providerMetadata: { actualModel: 'gemini-fallback' } }, estimated_cost_usd: 0 })
    ];
    const report = buildReliabilityReport({ campaign, runs, results });
    expect(report.actual_models).toEqual(['gemini-fallback', 'gemini-primary']);
    expect(report.mixed_model_runs).toBe(1);
    expect(report.interpretation.model_routing).toContain('Quota fallback');
  });
});
