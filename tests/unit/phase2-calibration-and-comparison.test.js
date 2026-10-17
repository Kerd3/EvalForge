import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/pool.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

import { pool } from '../../src/db/pool.js';
import { buildPairedComparison, calibrateGoldenExamples } from '../../src/services/evaluation-quality.service.js';
import { getDatasetById } from '../../src/repositories/datasets.repository.js';
import { compareEvaluationRuns } from '../../src/repositories/evaluations.repository.js';

afterEach(() => vi.clearAllMocks());

const baseCase = {
  id: 'c1', name: 'Policy keyword', input: 'Q',
  required_keywords: ['policy'], forbidden_keywords: ['guaranteed refund'],
  required_tools: [], forbidden_tools: [], grading_rules: {}
};
const ex = (label, content, expected_passed) => ({ label, response: { content, toolCalls: [] }, expected_passed });

describe('golden calibration — hand-checked fixture', () => {
  // Hand calculation (grader passes iff text has the word "policy" and not "guaranteed refund"):
  //  1 "The policy applies."            expected pass -> grader pass  => TP
  //  2 "The policy applies, ok."        expected pass -> grader pass  => TP
  //  3 "...guaranteed refund..."        expected fail -> grader fail  => TN
  //  4 "Nothing relevant."              expected fail -> grader fail  => TN
  //  5 "Nothing relevant here."         expected fail -> grader fail  => TN
  //  6 "The policy is fine."            expected fail -> grader pass  => FP (mislabeled/over-lenient)
  //  7 "Available info incomplete."     expected pass -> grader fail  => FN
  // TP=2 TN=3 FP=1 FN=1 n=7; accuracy=5/7; precision=2/3; recall=2/3; specificity=3/4; F1=2/3
  const report = calibrateGoldenExamples({
    dataset: { id: 'd', name: 'Golden', latest_version_id: 'v1', latest_version: 1 },
    testCases: [{
      ...baseCase,
      golden_examples: [
        ex('correct', 'The policy applies.', true),
        ex('correct', 'The policy applies, ok.', true),
        ex('incorrect', 'Refund policy: guaranteed refund.', false),
        ex('incorrect', 'Nothing relevant.', false),
        ex('adversarial', 'Nothing relevant here.', false),
        ex('conflicting', 'The policy is fine.', false),
        ex('ambiguous', 'Available info incomplete.', true)
      ]
    }]
  });

  it('matches independently computed confusion counts and metrics', () => {
    expect(report.status).toBe('calibrated');
    expect(report.confusion_matrix).toMatchObject({ true_positive: 2, true_negative: 3, false_positive: 1, false_negative: 1, evaluator_error: 0 });
    expect(report.summary).toMatchObject({
      evaluated_examples: 7, accuracy: 0.7143, precision: 0.6667, recall: 0.6667, specificity: 0.75, f1_score: 0.6667
    });
  });

  it('breaks results down by golden label', () => {
    expect(report.by_label.correct).toMatchObject({ examples: 2, correct: 2 });
    expect(report.by_label.conflicting).toMatchObject({ false_positives: 1, correct: 0 });
    expect(report.by_label.ambiguous).toMatchObject({ false_negatives: 1 });
    expect(report.by_label.adversarial).toMatchObject({ examples: 1, correct: 1 });
  });
});

describe('golden calibration — undefined denominators and exceptions', () => {
  it('returns null (not 0, NaN or Infinity) when a denominator is empty', () => {
    // Only expected-pass examples that the grader passes: no negatives, so specificity is undefined.
    const onlyPositives = calibrateGoldenExamples({
      dataset: {}, testCases: [{ ...baseCase, golden_examples: [ex('correct', 'The policy applies.', true)] }]
    });
    expect(onlyPositives.summary.specificity).toBeNull();
    expect(onlyPositives.summary.precision).toBe(1);
    expect(onlyPositives.summary.recall).toBe(1);

    // Only expected-fail examples that the grader fails: no predicted/actual positives.
    const onlyNegatives = calibrateGoldenExamples({
      dataset: {}, testCases: [{ ...baseCase, golden_examples: [ex('incorrect', 'Nothing.', false)] }]
    });
    expect(onlyNegatives.summary).toMatchObject({ precision: null, recall: null, f1_score: null, specificity: 1, accuracy: 1 });
    for (const value of Object.values(onlyNegatives.summary)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('keeps evaluator exceptions separate from grader misclassification', () => {
    const exploding = { label: 'correct', expected_passed: true, response: { get content() { throw new Error('boom'); } } };
    const report = calibrateGoldenExamples({
      dataset: {}, testCases: [{ ...baseCase, golden_examples: [exploding, ex('correct', 'The policy applies.', true)] }]
    });
    expect(report.confusion_matrix).toMatchObject({ evaluator_error: 1, true_positive: 1, false_positive: 0, false_negative: 0 });
    expect(report.summary.evaluated_examples).toBe(1);
    expect(report.summary.calibration_complete).toBe(false);
    expect(report.examples.find((item) => item.outcome === 'evaluator_error').error).toBe('boom');
  });

  it('returns an explicit no-data status when there are no golden examples', () => {
    const report = calibrateGoldenExamples({ dataset: { id: 'x' }, testCases: [baseCase] });
    expect(report.status).toBe('no_calibration_data');
    expect(report.summary).toMatchObject({ golden_examples: 0, accuracy: null, precision: null, recall: null, specificity: null, f1_score: null });
  });
});

const row = (id, status, extra = {}) => ({ test_case_id: id, test_case_name: id, status, ...extra });

describe('paired comparison — independently computed examples', () => {
  it('matches hand-calculated rates, counts, and conservative interval', () => {
    // baseline P P F F P F ; candidate P F P P P F  -> 2 improvements, 1 regression, 3 unchanged
    const base = ['P', 'P', 'F', 'F', 'P', 'F'].map((v, i) => row(`t${i}`, v === 'P' ? 'passed' : 'failed'));
    const cand = ['P', 'F', 'P', 'P', 'P', 'F'].map((v, i) => row(`t${i}`, v === 'P' ? 'passed' : 'failed'));
    const result = buildPairedComparison(base, cand);
    expect(result.baseline_pass_rate).toMatchObject({ passed: 3, answered: 6 });
    expect(result.baseline_pass_rate.interval).toMatchObject({ low_percentage: 18.76, high_percentage: 81.24 });
    expect(result.candidate_pass_rate.interval).toMatchObject({ low_percentage: 30, high_percentage: 90.32 });
    expect(result.paired_analysis).toMatchObject({ matched_graded_cases: 6, improvements: 2, regressions: 1, pass_rate_delta_percentage_points: 16.67 });
    expect(result.paired_analysis.confidence_interval_95).toMatchObject({ low_percentage_points: -53.04, high_percentage_points: 71.18 });
  });

  it('never reports zero uncertainty for small all-agreement samples', () => {
    const rows = [row('a', 'passed'), row('b', 'failed')];
    const result = buildPairedComparison(rows, rows);
    expect(result.paired_analysis.pass_rate_delta_percentage_points).toBe(0);
    expect(result.paired_analysis.confidence_interval_95).toMatchObject({ low_percentage_points: -71.53, high_percentage_points: 71.53 });
  });

  it('handles all-improvement and all-regression samples', () => {
    const fails = ['a', 'b', 'c', 'd'].map((id) => row(id, 'failed'));
    const passes = ['a', 'b', 'c', 'd'].map((id) => row(id, 'passed'));
    const improved = buildPairedComparison(fails, passes).paired_analysis;
    expect(improved).toMatchObject({ improvements: 4, regressions: 0, pass_rate_delta_percentage_points: 100 });
    expect(improved.confidence_interval_95).toMatchObject({ low_percentage_points: -11.35, high_percentage_points: 100 });
    const regressed = buildPairedComparison(passes.slice(0, 3), fails.slice(0, 3)).paired_analysis;
    expect(regressed.confidence_interval_95).toMatchObject({ low_percentage_points: -100, high_percentage_points: 25.22 });
  });

  it('does not invent estimates for zero or one matched graded case', () => {
    const none = buildPairedComparison([row('a', 'passed')], [row('b', 'passed')]);
    expect(none.paired_analysis).toMatchObject({ matched_graded_cases: 0, pass_rate_delta_percentage_points: null, confidence_interval_95: null });
    const one = buildPairedComparison([row('a', 'passed')], [row('a', 'failed')]);
    expect(one.paired_analysis).toMatchObject({ matched_graded_cases: 1, regressions: 1, confidence_interval_95: null });
    expect(one.paired_analysis.sample_size_note).toMatch(/at least two/i);
  });

  it('excludes pending, error, and unmatched cases and discloses each count', () => {
    const base = [row('a', 'passed'), row('b', 'passed'), row('only-base', 'passed'), row('p', 'pending')];
    const cand = [row('a', 'failed'), row('b', 'error', { failure_category: 'provider_error' }), row('only-cand', 'passed'), row('p', 'passed')];
    const result = buildPairedComparison(base, cand);
    expect(result.paired_analysis).toMatchObject({ matched_graded_cases: 1, regressions: 1, unmatched_or_ungraded_cases: 4 });
    expect(result.paired_analysis.excluded_breakdown).toEqual({ only_in_baseline: 1, only_in_candidate: 1, in_both_but_not_graded_in_both: 2 });
    expect(result.data_quality).toMatchObject({ baseline_answered_cases: 3, candidate_answered_cases: 3, baseline_pending_or_error_cases: 1, candidate_pending_or_error_cases: 1 });
  });

  it('discloses duplicate rows instead of silently overwriting them', () => {
    const result = buildPairedComparison([row('a', 'passed'), row('a', 'failed')], [row('a', 'passed')]);
    expect(result.data_quality.duplicate_test_case_rows_ignored).toEqual({ baseline: 1, candidate: 0 });
    expect(result.paired_analysis.matched_graded_cases).toBe(1);
  });

  it('warns when runs come from different dataset versions', () => {
    const result = buildPairedComparison([row('a', 'passed')], [row('b', 'passed')], { baselineDatasetVersionId: 'v1', candidateDatasetVersionId: 'v2' });
    expect(result.data_quality.same_dataset_version).toBe(false);
    expect(result.data_quality.comparability_warning).toMatch(/different dataset versions/i);
    const same = buildPairedComparison([row('a', 'passed')], [row('a', 'passed')], { baselineDatasetVersionId: 'v1', candidateDatasetVersionId: 'v1' });
    expect(same.data_quality.comparability_warning).toBeNull();
  });

  it('does not report an empty run as "all cases graded"', () => {
    expect(buildPairedComparison([], []).data_quality).toMatchObject({ baseline_all_cases_graded: false, candidate_all_cases_graded: false });
  });
});

describe('ownership and version scoping', () => {
  const USER_A = '11111111-1111-4111-8111-111111111111';
  const USER_B = '22222222-2222-4222-8222-222222222222';
  const RUN_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const RUN_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('refuses to compare runs the caller does not own, without calculating anything', async () => {
    // The database applies the owner predicate, so User B's lookup of User A's runs returns no rows.
    pool.query.mockResolvedValue({ rows: [] });
    await expect(compareEvaluationRuns(RUN_1, RUN_2, USER_B)).rejects.toMatchObject({ statusCode: 404 });
    for (const [sql, params] of pool.query.mock.calls) {
      expect(String(sql)).toMatch(/owner_id\s*=\s*\$2/);
      expect(params[1]).toBe(USER_B);
    }
  });

  it('scopes a historical calibration version by dataset id, owner id, and version id', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const VERSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const result = await getDatasetById('dddddddd-dddd-4ddd-8ddd-dddddddddddd', USER_A, VERSION);
    expect(result).toBeNull();
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('d.owner_id = $2');
    expect(String(sql)).toContain('dataset_id = d.id AND ($3::uuid IS NULL OR id = $3)');
    expect(params).toEqual(['dddddddd-dddd-4ddd-8ddd-dddddddddddd', USER_A, VERSION]);
  });
});
