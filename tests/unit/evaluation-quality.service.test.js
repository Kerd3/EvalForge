import { describe, expect, it } from 'vitest';
import {
  buildEvaluationQualityReport,
  buildPairedComparison,
  calibrateGoldenExamples
} from '../../src/services/evaluation-quality.service.js';

const testCase = {
  id: 'case-1',
  name: 'Keyword control',
  input: 'Question',
  required_keywords: ['policy'],
  forbidden_keywords: ['guaranteed refund'],
  required_tools: [],
  forbidden_tools: [],
  grading_rules: {}
};

describe('calibrateGoldenExamples', () => {
  it('reports labeled accuracy by category and preserves dataset version identity', () => {
    const report = calibrateGoldenExamples({
      dataset: { id: 'ds-1', name: 'Golden', latest_version_id: 'version-2', latest_version: 2 },
      testCases: [{
        ...testCase,
        golden_examples: [
          { label: 'correct', response: { content: 'The policy is available.', toolCalls: [] }, expected_passed: true },
          { label: 'incorrect', response: { content: 'A guaranteed refund is given.', toolCalls: [] }, expected_passed: false },
          // Intentional false positive: a wrong label says this should fail, but the grader passes.
          { label: 'conflicting', response: { content: 'The policy is available.', toolCalls: [] }, expected_passed: false },
          // Intentional false negative: the expected safe response should pass, but misses the required keyword.
          { label: 'ambiguous', response: { content: 'The available information is incomplete.', toolCalls: [] }, expected_passed: true }
        ]
      }]
    });

    expect(report.dataset).toMatchObject({ id: 'ds-1', dataset_version_id: 'version-2', version_number: 2 });
    expect(report.summary).toMatchObject({
      golden_examples: 4,
      evaluated_examples: 4,
      false_positive_count: 1,
      false_negative_count: 1,
      accuracy: 0.5
    });
    expect(report.confusion_matrix).toMatchObject({ true_positive: 1, true_negative: 1, false_positive: 1, false_negative: 1 });
    expect(report.by_label.conflicting.false_positives).toBe(1);
    expect(report.by_label.ambiguous.false_negatives).toBe(1);
  });

  it('returns an explicit uncalibrated report when no labeled examples exist', () => {
    const report = calibrateGoldenExamples({ dataset: { id: 'ds-2' }, testCases: [testCase] });
    expect(report.summary.calibration_complete).toBe(false);
    expect(report.summary.evaluated_examples).toBe(0);
    expect(report.summary.accuracy).toBeNull();
    expect(report.summary.interpretation).toMatch(/No golden examples/i);
  });
});

describe('buildEvaluationQualityReport', () => {
  it('keeps provider, evaluator, and model failures separate from pass-rate denominator', () => {
    const report = buildEvaluationQualityReport([
      { status: 'passed' },
      { status: 'failed' },
      { status: 'error', failure_category: 'provider_error' },
      { status: 'error', failure_category: 'evaluator_error' },
      { status: 'failed', failure_category: 'model_failure' },
      { status: 'error' },
      { status: 'pending' }
    ]);

    expect(report.totals).toMatchObject({ test_cases: 7, passed: 1, failed: 2, answered: 3, pending: 1, error_status: 3 });
    expect(report.model_quality.pass_rate_percentage).toBeCloseTo(100 / 3, 2);
    expect(report.model_quality.sample_size).toBe(3);
    expect(report.model_quality.confidence_interval_95).toMatchObject({ confidence_level: 0.95 });
    expect(report.failures).toMatchObject({
      provider_errors: 1,
      evaluator_errors: 1,
      model_failures: 1,
      unclassified_legacy_errors: 1
    });
  });
});

describe('buildPairedComparison', () => {
  it('calculates paired improvements, regressions, uncertainty, and excluded cases', () => {
    const baseline = [
      { test_case_id: 'a', test_case_name: 'A', status: 'passed', score: 1 },
      { test_case_id: 'b', test_case_name: 'B', status: 'failed', score: 0 },
      { test_case_id: 'c', test_case_name: 'C', status: 'error', failure_category: 'provider_error' },
      { test_case_id: 'only-base', test_case_name: 'Base only', status: 'passed' }
    ];
    const candidate = [
      { test_case_id: 'a', test_case_name: 'A', status: 'failed', score: 0 },
      { test_case_id: 'b', test_case_name: 'B', status: 'passed', score: 1 },
      { test_case_id: 'c', test_case_name: 'C', status: 'error', failure_category: 'evaluator_error' },
      { test_case_id: 'only-candidate', test_case_name: 'Candidate only', status: 'passed' }
    ];

    const report = buildPairedComparison(baseline, candidate);
    expect(report.baseline_pass_rate).toMatchObject({ passed: 2, answered: 3 });
    expect(report.candidate_pass_rate).toMatchObject({ passed: 2, answered: 3 });
    expect(report.paired_analysis).toMatchObject({
      matched_graded_cases: 2,
      unmatched_or_ungraded_cases: 3,
      improvements: 1,
      regressions: 1,
      pass_rate_delta_percentage_points: 0
    });
    expect(report.paired_analysis.confidence_interval_95).toMatchObject({ confidence_level: 0.95 });
    expect(report.paired_analysis.confidence_interval_95.low_percentage_points).toBeLessThan(0);
    expect(report.paired_analysis.confidence_interval_95.high_percentage_points).toBeGreaterThan(0);
    expect(report.data_quality).toMatchObject({ baseline_pending_or_error_cases: 1, candidate_pending_or_error_cases: 1 });
    expect(report.cases.find((item) => item.test_case_id === 'c').included_in_paired_analysis).toBe(false);
  });

  it('does not fabricate confidence intervals when the paired sample is too small', () => {
    const report = buildPairedComparison(
      [{ test_case_id: 'a', status: 'passed' }],
      [{ test_case_id: 'a', status: 'failed' }]
    );
    expect(report.paired_analysis.matched_graded_cases).toBe(1);
    expect(report.paired_analysis.confidence_interval_95).toBeNull();
  });

  it('does not report zero uncertainty when the small paired sample has no disagreements', () => {
    const report = buildPairedComparison(
      [{ test_case_id: 'a', status: 'passed' }, { test_case_id: 'b', status: 'failed' }],
      [{ test_case_id: 'a', status: 'passed' }, { test_case_id: 'b', status: 'failed' }]
    );
    expect(report.paired_analysis.pass_rate_delta_percentage_points).toBe(0);
    expect(report.paired_analysis.confidence_interval_95.low_percentage_points).toBeLessThan(0);
    expect(report.paired_analysis.confidence_interval_95.high_percentage_points).toBeGreaterThan(0);
  });
});
