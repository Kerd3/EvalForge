import { gradeCase } from './grading.service.js';

const GOLDEN_LABELS = ['correct', 'incorrect', 'ambiguous', 'conflicting', 'adversarial'];
const Z_95 = 1.959963984540054;
const Z_975 = 2.241402727604947;

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(digits));
}

function wilsonBounds(successes, trials, z = Z_95) {
  if (!trials) return null;
  const p = successes / trials;
  const z2 = z ** 2;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p) / trials) + (z2 / (4 * trials ** 2)))) / denominator;
  return {
    low: Math.max(0, center - halfWidth),
    high: Math.min(1, center + halfWidth)
  };
}

function wilsonInterval(successes, trials) {
  const bounds = wilsonBounds(successes, trials);
  if (!bounds) return null;
  return {
    low_percentage: round(bounds.low * 100, 2),
    high_percentage: round(bounds.high * 100, 2),
    confidence_level: 0.95,
    method: 'Wilson score interval for a binomial proportion'
  };
}

function emptyLabelSummary() {
  return { examples: 0, evaluated: 0, correct: 0, false_positives: 0, false_negatives: 0, evaluator_errors: 0 };
}

/**
 * Run the deterministic grader against human-labeled responses attached to an
 * immutable dataset version. Golden examples are measurements, not automatic
 * changes to the grading rules.
 */
export function calibrateGoldenExamples({ dataset, testCases = [] }) {
  const examples = [];
  const byLabel = Object.fromEntries(GOLDEN_LABELS.map((label) => [label, emptyLabelSummary()]));
  const confusion = { true_positive: 0, true_negative: 0, false_positive: 0, false_negative: 0, evaluator_error: 0 };

  for (const testCase of testCases) {
    const goldenExamples = Array.isArray(testCase.golden_examples) ? testCase.golden_examples : [];
    for (let index = 0; index < goldenExamples.length; index += 1) {
      const golden = goldenExamples[index];
      const label = GOLDEN_LABELS.includes(golden?.label) ? golden.label : 'ambiguous';
      const summary = byLabel[label];
      summary.examples += 1;
      try {
        const grade = gradeCase(testCase, golden.response ?? {});
        const actualPassed = Boolean(grade.passed);
        const expectedPassed = Boolean(golden.expected_passed);
        let outcome;
        if (expectedPassed && actualPassed) {
          outcome = 'true_positive';
          confusion.true_positive += 1;
        } else if (!expectedPassed && !actualPassed) {
          outcome = 'true_negative';
          confusion.true_negative += 1;
        } else if (!expectedPassed && actualPassed) {
          outcome = 'false_positive';
          confusion.false_positive += 1;
          summary.false_positives += 1;
        } else {
          outcome = 'false_negative';
          confusion.false_negative += 1;
          summary.false_negatives += 1;
        }
        summary.evaluated += 1;
        if (expectedPassed === actualPassed) summary.correct += 1;
        examples.push({
          test_case_id: testCase.id ?? null,
          test_case_name: testCase.name ?? 'Unnamed test case',
          example_index: index,
          label,
          expected_passed: expectedPassed,
          actual_passed: actualPassed,
          actual_score: grade.score,
          outcome,
          rationale: golden.rationale ?? null,
          graders: grade.graders
        });
      } catch (error) {
        summary.evaluator_errors += 1;
        confusion.evaluator_error += 1;
        examples.push({
          test_case_id: testCase.id ?? null,
          test_case_name: testCase.name ?? 'Unnamed test case',
          example_index: index,
          label,
          expected_passed: Boolean(golden?.expected_passed),
          actual_passed: null,
          actual_score: null,
          outcome: 'evaluator_error',
          rationale: golden?.rationale ?? null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const evaluated = confusion.true_positive + confusion.true_negative + confusion.false_positive + confusion.false_negative;
  const predictedPositive = confusion.true_positive + confusion.false_positive;
  const actualPositive = confusion.true_positive + confusion.false_negative;
  const actualNegative = confusion.true_negative + confusion.false_positive;
  const precision = predictedPositive ? confusion.true_positive / predictedPositive : null;
  const recall = actualPositive ? confusion.true_positive / actualPositive : null;
  const specificity = actualNegative ? confusion.true_negative / actualNegative : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? 2 * precision * recall / (precision + recall)
    : precision === 0 && recall === 0 ? 0 : null;

  return {
    schema_version: 'evalforge.grader-calibration/v1',
    dataset: {
      id: dataset?.id ?? null,
      name: dataset?.name ?? null,
      dataset_version_id: dataset?.latest_version_id ?? null,
      version_number: dataset?.latest_version ?? null
    },
    status: evaluated > 0 ? 'calibrated' : examples.length > 0 ? 'evaluator_errors_only' : 'no_calibration_data',
    summary: {
      golden_examples: examples.length,
      evaluated_examples: evaluated,
      evaluator_errors: confusion.evaluator_error,
      accuracy: evaluated ? round((confusion.true_positive + confusion.true_negative) / evaluated, 4) : null,
      precision: round(precision, 4),
      recall: round(recall, 4),
      specificity: round(specificity, 4),
      f1_score: round(f1, 4),
      false_positive_count: confusion.false_positive,
      false_negative_count: confusion.false_negative,
      calibration_complete: examples.length > 0 && confusion.evaluator_error === 0,
      interpretation: evaluated
        ? 'Metrics compare deterministic-grader verdicts against explicitly labeled golden responses. Evaluator-error examples are excluded from confusion-matrix metrics.'
        : 'No golden examples were evaluated. Add labeled golden_examples to test cases and create a new dataset version to preserve the calibration set.'
    },
    confusion_matrix: confusion,
    by_label: byLabel,
    examples
  };
}

/** Summarize one run without treating provider/evaluator errors as model quality failures. */
export function buildEvaluationQualityReport(results = []) {
  const rows = Array.isArray(results) ? results : [];
  const passed = rows.filter((result) => result.status === 'passed').length;
  const failed = rows.filter((result) => result.status === 'failed').length;
  const errored = rows.filter((result) => result.status === 'error').length;
  const pending = rows.filter((result) => result.status === 'pending').length;
  const classified = (category) => rows.filter((result) => result.failure_category === category).length;
  const unclassifiedErrors = rows.filter((result) => result.status === 'error' && !result.failure_category).length;
  const answered = passed + failed;

  return {
    schema_version: 'evalforge.evaluation-quality/v1',
    totals: {
      test_cases: rows.length,
      passed,
      failed,
      answered,
      pending,
      error_status: errored
    },
    model_quality: {
      pass_rate_percentage: answered ? round(passed / answered * 100, 2) : null,
      sample_size: answered,
      confidence_interval_95: wilsonInterval(passed, answered),
      interval_assumption: 'Each passed/failed test case is treated as a binary observation. The Wilson interval describes uncertainty in the observed pass rate; it does not correct for correlated or non-representative test cases.'
    },
    failures: {
      provider_errors: classified('provider_error'),
      evaluator_errors: classified('evaluator_error'),
      model_failures: classified('model_failure'),
      unclassified_legacy_errors: unclassifiedErrors,
      categories: {
        provider_error: 'The generation provider call failed before a response could be graded, or an external provider call used by the judge failed.',
        evaluator_error: 'A deterministic grader, grading pipeline, or evaluation-result processing step failed.',
        model_failure: 'The model returned no usable text or proposed tool calls, so it could not produce a gradable response.'
      }
    }
  };
}

function outcomeIsGraded(result) {
  return result && ['passed', 'failed'].includes(result.status);
}

function passRate(results) {
  const answered = results.filter(outcomeIsGraded);
  const passed = answered.filter((result) => result.status === 'passed').length;
  return {
    passed,
    answered: answered.length,
    rate: answered.length ? passed / answered.length * 100 : null,
    interval: wilsonInterval(passed, answered.length)
  };
}

/** Build a paired baseline/candidate comparison on shared, graded test-case IDs. */
export function buildPairedComparison(baselineResults = [], candidateResults = [], { baselineDatasetVersionId = null, candidateDatasetVersionId = null } = {}) {
  // A run should hold one result per test case (the database enforces it). If a
  // caller ever passes duplicates, keep the first row deterministically and
  // disclose the count instead of silently overwriting.
  const indexFirst = (rows) => {
    const byId = new Map();
    let duplicates = 0;
    for (const row of rows) {
      if (byId.has(row.test_case_id)) duplicates += 1;
      else byId.set(row.test_case_id, row);
    }
    return { byId, duplicates };
  };
  const baseIndex = indexFirst(baselineResults);
  const candidateIndex = indexFirst(candidateResults);
  const baseById = baseIndex.byId;
  const candidateById = candidateIndex.byId;
  const allIds = new Set([...baseById.keys(), ...candidateById.keys()]);
  const cases = [...allIds].map((id) => {
    const base = baseById.get(id);
    const candidate = candidateById.get(id);
    const baselineStatus = base?.status ?? 'not_present';
    const candidateStatus = candidate?.status ?? 'not_present';
    const bothGraded = outcomeIsGraded(base) && outcomeIsGraded(candidate);
    const regression = baselineStatus === 'passed' && candidateStatus === 'failed';
    const improvement = baselineStatus === 'failed' && candidateStatus === 'passed';
    return {
      test_case_id: id,
      test_case_name: candidate?.test_case_name ?? base?.test_case_name ?? 'Unnamed test case',
      baseline_status: baselineStatus,
      candidate_status: candidateStatus,
      changed: Boolean(base && candidate && baselineStatus !== candidateStatus),
      regression,
      improvement,
      included_in_paired_analysis: bothGraded,
      baseline_failure_category: base?.failure_category ?? null,
      candidate_failure_category: candidate?.failure_category ?? null,
      baseline_score: numeric(base?.score),
      candidate_score: numeric(candidate?.score)
    };
  });

  const baseRate = passRate(baselineResults);
  const candidateRate = passRate(candidateResults);
  const paired = cases.filter((item) => item.included_in_paired_analysis);
  const deltas = paired.map((item) => (item.candidate_status === 'passed' ? 1 : 0) - (item.baseline_status === 'passed' ? 1 : 0));
  const pairedDelta = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null;
  let pairedCi = null;
  if (deltas.length >= 2) {
    const improvementCount = deltas.filter((value) => value === 1).length;
    const regressionCount = deltas.filter((value) => value === -1).length;
    // Conservative interval for p(improvement) - p(regression). Each marginal
    // Wilson interval uses 97.5% coverage; Bonferroni gives at least 95% joint
    // coverage without assuming the mutually-exclusive outcomes are independent.
    const improvementBounds = wilsonBounds(improvementCount, deltas.length, Z_975);
    const regressionBounds = wilsonBounds(regressionCount, deltas.length, Z_975);
    pairedCi = {
      low_percentage_points: round(Math.max(-1, improvementBounds.low - regressionBounds.high) * 100, 2),
      high_percentage_points: round(Math.min(1, improvementBounds.high - regressionBounds.low) * 100, 2),
      confidence_level: 0.95,
      method: 'Conservative paired difference interval using Bonferroni-adjusted Wilson bounds',
      assumptions: 'The interval is the difference between the improvement and regression proportions among matched, graded cases. It uses 97.5% marginal Wilson bounds to provide at least 95% coverage by Bonferroni; matched cases should be independent across case IDs. Small samples can yield wide intervals, which is preferable to reporting zero uncertainty merely because no discordant cases were observed.'
    };
  }

  const baselineHasOnlyGraded = baselineResults.length > 0 && baselineResults.every((row) => ['passed', 'failed'].includes(row.status));
  const candidateHasOnlyGraded = candidateResults.length > 0 && candidateResults.every((row) => ['passed', 'failed'].includes(row.status));
  const onlyInBaseline = cases.filter((item) => item.candidate_status === 'not_present').length;
  const onlyInCandidate = cases.filter((item) => item.baseline_status === 'not_present').length;
  const inBothButUngraded = cases.filter((item) => item.baseline_status !== 'not_present'
    && item.candidate_status !== 'not_present' && !item.included_in_paired_analysis).length;
  const sameDatasetVersion = baselineDatasetVersionId && candidateDatasetVersionId
    ? baselineDatasetVersionId === candidateDatasetVersionId : null;
  const comparabilityWarning = sameDatasetVersion === false
    ? 'These runs used different dataset versions. Test cases are matched by test-case ID, and every dataset version stores its own test-case IDs, so cases are not expected to match across versions. Compare runs of the same dataset version for a paired estimate.'
    : null;
  return {
    schema_version: 'evalforge.paired-comparison/v1',
    baseline_pass_rate: baseRate,
    candidate_pass_rate: candidateRate,
    pass_rate_delta_percentage_points: baseRate.rate === null || candidateRate.rate === null
      ? null : round(candidateRate.rate - baseRate.rate, 2),
    paired_analysis: {
      matched_graded_cases: paired.length,
      unmatched_or_ungraded_cases: cases.length - paired.length,
      excluded_breakdown: {
        only_in_baseline: onlyInBaseline,
        only_in_candidate: onlyInCandidate,
        in_both_but_not_graded_in_both: inBothButUngraded
      },
      improvements: cases.filter((item) => item.improvement).length,
      regressions: cases.filter((item) => item.regression).length,
      pass_rate_delta_percentage_points: pairedDelta === null ? null : round(pairedDelta * 100, 2),
      confidence_interval_95: pairedCi,
      sample_size_note: paired.length < 2
        ? 'At least two matched, graded cases are required to estimate a paired confidence interval.'
        : 'Paired uncertainty is estimated only from test-case IDs present and graded in both runs.',
      assumptions: 'This is a paired analysis of binary pass/fail outcomes. Provider errors, evaluator errors, pending cases, and test cases missing from either run are excluded from the paired estimator.'
    },
    data_quality: {
      baseline_dataset_version_id: baselineDatasetVersionId,
      candidate_dataset_version_id: candidateDatasetVersionId,
      same_dataset_version: sameDatasetVersion,
      comparability_warning: comparabilityWarning,
      duplicate_test_case_rows_ignored: { baseline: baseIndex.duplicates, candidate: candidateIndex.duplicates },
      baseline_answered_cases: baseRate.answered,
      candidate_answered_cases: candidateRate.answered,
      baseline_pending_or_error_cases: baselineResults.length - baseRate.answered,
      candidate_pending_or_error_cases: candidateResults.length - candidateRate.answered,
      baseline_all_cases_graded: baselineHasOnlyGraded,
      candidate_all_cases_graded: candidateHasOnlyGraded
    },
    cases
  };
}
