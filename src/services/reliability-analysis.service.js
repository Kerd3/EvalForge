const T_95_TWO_SIDED = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262
};

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1));
}

function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function safeObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; }
    catch { return {}; }
  }
  return {};
}

function actualModelFor(result, run) {
  const output = safeObject(result.actual_output);
  const metadata = safeObject(output.providerMetadata);
  const name = metadata.actualModel ?? metadata.modelVersion ?? metadata.model;
  if (name) return String(name);
  return run.provider === 'mock' && result.actual_output ? String(run.model) : null;
}

function runPassRate(run) {
  const passed = Number(run.passed_cases ?? 0);
  const failed = Number(run.failed_cases ?? 0);
  const answered = passed + failed;
  return answered ? (passed / answered) * 100 : null;
}

function confidenceInterval95(values, standardDeviation) {
  if (values.length < 2 || standardDeviation === null) return null;
  const degreesOfFreedom = values.length - 1;
  // Campaigns are intentionally capped at 10 repeats by API validation.
  // Fallback to a conservative high critical value if this is called directly with more data.
  const tCritical = T_95_TWO_SIDED[degreesOfFreedom] ?? 2.262;
  const average = mean(values);
  const halfWidth = tCritical * standardDeviation / Math.sqrt(values.length);
  return {
    low: round(Math.max(0, average - halfWidth)),
    high: round(Math.min(100, average + halfWidth)),
    half_width_percentage_points: round(halfWidth),
    method: "Student's t interval over completed run-level pass rates"
  };
}

function summarizeCases(runs, results) {
  const completedRunIds = new Set(runs.filter((run) => run.status === 'completed').map((run) => run.id));
  const groups = new Map();
  for (const result of results) {
    if (!completedRunIds.has(result.run_id)) continue;
    const key = result.test_case_id;
    if (!groups.has(key)) {
      groups.set(key, {
        test_case_id: key,
        test_case_name: result.test_case_name ?? 'Unnamed test case',
        passed_runs: 0, failed_runs: 0, error_runs: 0, pending_runs: 0,
        _answerStatuses: [], _actualModels: new Set()
      });
    }
    const group = groups.get(key);
    if (result.status === 'passed') { group.passed_runs += 1; group._answerStatuses.push('passed'); }
    else if (result.status === 'failed') { group.failed_runs += 1; group._answerStatuses.push('failed'); }
    else if (result.status === 'error') group.error_runs += 1;
    else group.pending_runs += 1;
    const run = runs.find((item) => item.id === result.run_id);
    const actualModel = run ? actualModelFor(result, run) : null;
    if (actualModel) group._actualModels.add(actualModel);
  }

  const cases = [...groups.values()].map((group) => {
    const answeredRuns = group.passed_runs + group.failed_runs;
    const passRate = answeredRuns ? group.passed_runs / answeredRuns * 100 : null;
    const passCount = group._answerStatuses.filter((status) => status === 'passed').length;
    const failCount = group._answerStatuses.length - passCount;
    const statusConsistency = answeredRuns ? Math.max(passCount, failCount) / answeredRuns * 100 : null;
    return {
      test_case_id: group.test_case_id,
      test_case_name: group.test_case_name,
      passed_runs: group.passed_runs,
      failed_runs: group.failed_runs,
      error_runs: group.error_runs,
      answered_runs: answeredRuns,
      pass_rate_percentage: round(passRate),
      status_consistency_percentage: round(statusConsistency),
      stable_across_repeats: answeredRuns >= 2 && (passCount === answeredRuns || failCount === answeredRuns),
      actual_models: [...group._actualModels].sort()
    };
  }).sort((a, b) => a.test_case_name.localeCompare(b.test_case_name));

  const eligible = cases.filter((item) => item.answered_runs >= 2);
  const stable = eligible.filter((item) => item.stable_across_repeats).length;
  return {
    cases,
    cases_with_multiple_answers: eligible.length,
    stable_cases: stable,
    case_stability_percentage: eligible.length ? round(stable / eligible.length * 100) : null,
    caveat: 'Case stability is calculated only for cases with at least two passed/failed outcomes. Provider errors are reported separately and do not count as pass/fail outcomes.'
  };
}

export function buildReliabilityReport({ campaign, runs = [], results = [] }) {
  const completedRuns = runs.filter((run) => run.status === 'completed');
  const passRates = completedRuns.map(runPassRate).filter((value) => value !== null);
  const averagePassRate = mean(passRates);
  const passRateStddev = sampleStandardDeviation(passRates);
  const ci = confidenceInterval95(passRates, passRateStddev);

  const latencyValues = results
    .filter((result) => completedRuns.some((run) => run.id === result.run_id))
    .map((result) => numeric(result.latency_ms))
    .filter((value) => value !== null);
  const latencyMean = mean(latencyValues);
  const latencyStddev = sampleStandardDeviation(latencyValues);

  const costRelevantResults = results.filter((result) =>
    completedRuns.some((run) => run.id === result.run_id) && ['passed', 'failed', 'error'].includes(result.status)
  );
  const pricedResults = costRelevantResults.filter((result) => numeric(result.estimated_cost_usd) !== null);
  const knownCostSubtotal = pricedResults.reduce((sum, result) => sum + numeric(result.estimated_cost_usd), 0);
  const hasMissingCost = costRelevantResults.some((result) => numeric(result.estimated_cost_usd) === null);
  const totalEstimatedCost = costRelevantResults.length && !hasMissingCost ? knownCostSubtotal : null;
  const costStatus = !costRelevantResults.length ? 'unavailable' : hasMissingCost
    ? (pricedResults.length ? 'partial' : 'unavailable') : 'estimated';
  const costByRun = new Map();
  for (const run of completedRuns) {
    const runCostRows = costRelevantResults.filter((result) => result.run_id === run.id);
    const runMissingCost = runCostRows.some((result) => numeric(result.estimated_cost_usd) === null);
    const runKnownCost = runCostRows.reduce((sum, result) => sum + (numeric(result.estimated_cost_usd) ?? 0), 0);
    costByRun.set(run.id, runCostRows.length && !runMissingCost ? round(runKnownCost, 10) : null);
  }

  const caseSummary = summarizeCases(runs, results);
  const actualModels = new Set();
  let mixedModelRuns = 0;
  for (const run of completedRuns) {
    const runModels = new Set(results
      .filter((result) => result.run_id === run.id && ['passed', 'failed'].includes(result.status))
      .map((result) => actualModelFor(result, run))
      .filter(Boolean));
    runModels.forEach((model) => actualModels.add(model));
    if (runModels.size > 1) mixedModelRuns += 1;
  }

  const runSummaries = runs.map((run) => {
    const answered = Number(run.passed_cases ?? 0) + Number(run.failed_cases ?? 0);
    return {
      id: run.id,
      repetition_index: Number(run.repetition_index),
      status: run.status,
      total_cases: Number(run.total_cases ?? 0),
      completed_cases: Number(run.completed_cases ?? 0),
      passed_cases: Number(run.passed_cases ?? 0),
      failed_cases: Number(run.failed_cases ?? 0),
      error_cases: Number(run.error_cases ?? 0),
      answered_cases: answered,
      pass_rate_percentage: round(runPassRate(run)),
      average_latency_ms: round(numeric(run.average_latency_ms), 0),
      total_input_tokens: Number(run.total_input_tokens ?? 0),
      total_output_tokens: Number(run.total_output_tokens ?? 0),
      estimated_cost_usd: run.status === 'completed' ? (costByRun.get(run.id) ?? null) : null,
      actual_model_names: Array.isArray(run.actual_model_names) ? run.actual_model_names : [],
      fallback_cases: Number(run.fallback_cases ?? 0),
      created_at: run.created_at,
      completed_at: run.completed_at
    };
  });

  const failureClassification = {
    provider_errors: results.filter((result) => result.failure_category === 'provider_error').length,
    evaluator_errors: results.filter((result) => result.failure_category === 'evaluator_error').length,
    model_failures: results.filter((result) => result.failure_category === 'model_failure').length,
    unclassified_legacy_errors: results.filter((result) => result.status === 'error' && !result.failure_category).length
  };

  return {
    failure_classification: failureClassification,
    status: campaign.status,
    planned_runs: Number(campaign.repeat_count ?? runs.length),
    completed_runs: completedRuns.length,
    failed_runs: runs.filter((run) => run.status === 'failed').length,
    cancelled_runs: runs.filter((run) => run.status === 'cancelled').length,
    analyzed_runs: passRates.length,
    average_pass_rate_percentage: round(averagePassRate),
    pass_rate_stddev_percentage_points: round(passRateStddev),
    minimum_pass_rate_percentage: passRates.length ? round(Math.min(...passRates)) : null,
    maximum_pass_rate_percentage: passRates.length ? round(Math.max(...passRates)) : null,
    pass_rate_confidence_interval_95: ci,
    average_case_latency_ms: round(latencyMean, 0),
    case_latency_stddev_ms: round(latencyStddev, 0),
    total_estimated_cost_usd: round(totalEstimatedCost, 10),
    known_cost_subtotal_usd: round(knownCostSubtotal, 10),
    cost_estimate_status: costStatus,
    actual_models: [...actualModels].sort(),
    mixed_model_runs: mixedModelRuns,
    case_stability_percentage: caseSummary.case_stability_percentage,
    cases_with_multiple_answers: caseSummary.cases_with_multiple_answers,
    stable_cases: caseSummary.stable_cases,
    run_summaries: runSummaries,
    per_case: caseSummary.cases,
    interpretation: {
      pass_rate: 'Per-run pass rate is passed / (passed + failed). Provider errors are excluded from this denominator and surfaced separately.',
      confidence_interval: ci
        ? 'Exploratory 95% confidence interval for the mean of completed run-level pass rates. With fewer than five completed repeats this interval is highly uncertain; it is not a guarantee of accuracy on unseen test cases.'
        : 'A 95% interval is unavailable until at least two completed runs have answered at least one case. Repeat runs estimate run-to-run variability; they do not replace a sufficiently broad, representative test dataset.',
      model_routing: mixedModelRuns
        ? 'Some completed runs used more than one actual model. Quota fallback can change the model answering a case, so inspect actual model names before treating the campaign as a single-model benchmark.'
        : 'Actual models are derived from recorded provider metadata. Requested model alone is not proof that it answered every case.',
      cost: costStatus === 'estimated'
        ? 'Total estimated cost is summed from stored terminal case estimates and reflects the rates configured when the runs executed. If an error case has no stored estimate, the total remains unavailable rather than assuming it cost zero.'
        : costStatus === 'partial'
          ? 'A known cost subtotal is available, but at least one terminal case (including possible execution errors) had no stored estimate; total cost is therefore unavailable.'
          : 'A complete cost estimate is unavailable because no answered cases or no usable stored case costs were available.'
    }
  };
}
