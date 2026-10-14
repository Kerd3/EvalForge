import { describe, expect, it } from 'vitest';
import { buildReliabilityReport } from '../../src/services/reliability-analysis.service.js';

const makeRun = (id, passed, failed, overrides = {}) => ({
  id, repetition_index: Number(id.split('-')[1]), status: 'completed',
  provider: 'mock', model: 'mock-v1', total_cases: passed + failed,
  completed_cases: passed + failed, passed_cases: passed, failed_cases: failed, error_cases: 0,
  average_latency_ms: 80, total_input_tokens: 0, total_output_tokens: 0,
  estimated_cost_usd: 0, actual_model_names: ['mock-v1'], fallback_cases: 0, ...overrides
});
const result = (runId, caseId, status) => ({
  run_id: runId, test_case_id: caseId, test_case_name: caseId, status,
  actual_output: { content: 'fixture', providerMetadata: { mode: 'mock' } },
  latency_ms: 80, estimated_cost_usd: 0
});

describe('repeated-run reliability critical path', () => {
  it('summarizes repeat variability without counting provider errors as model failures', () => {
    const runs = [makeRun('run-1', 2, 0), makeRun('run-2', 1, 1), makeRun('run-3', 0, 2)];
    const results = [
      result('run-1', 'case-a', 'passed'), result('run-2', 'case-a', 'passed'), result('run-3', 'case-a', 'failed'),
      result('run-1', 'case-b', 'passed'), result('run-2', 'case-b', 'failed'), result('run-3', 'case-b', 'failed')
    ];
    const report = buildReliabilityReport({ campaign: { id: 'campaign-1', status: 'completed', repeat_count: 3 }, runs, results });
    expect(report.average_pass_rate_percentage).toBe(50);
    expect(report.pass_rate_stddev_percentage_points).toBe(50);
    expect(report.pass_rate_confidence_interval_95).not.toBeNull();
    expect(report.case_stability_percentage).toBe(0);
    expect(report.total_estimated_cost_usd).toBe(0);
  });
});
