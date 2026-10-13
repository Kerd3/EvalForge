function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

function metadataFor(result) {
  const output = asObject(result.actual_output);
  return asObject(output.providerMetadata);
}

function resolveActualModel(run, result, metadata) {
  const actualModel = metadata.actualModel || metadata.modelVersion || metadata.model;
  if (actualModel) return String(actualModel);
  if (run.provider === 'mock' && result.actual_output) return String(run.model || 'mock');
  return null;
}

function resultFallbackUsed(result, metadata) {
  if (metadata.fallbackUsed === true || metadata.fallbackUsed === 'true') return true;
  return (Array.isArray(result.trace) ? result.trace : []).some((event) =>
    event?.type === 'model.completed' && event.fallbackUsed === true
  );
}

function emptyModelGroup(model) {
  return {
    model,
    requested_models: new Set(),
    case_count: 0,
    model_call_count: 0,
    passed_cases: 0,
    failed_cases: 0,
    error_cases: 0,
    pending_cases: 0,
    answered_cases: 0,
    fallback_cases: 0,
    average_latency_ms: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    estimated_cost_usd: null,
    known_estimated_cost_usd: null,
    fallback_reasons: new Set(),
    _latencies: [],
    _costs: [],
    _unpricedCostCalls: 0,
    _costSources: new Set(),
    _pricingExplanations: new Set(),
    _callOperations: new Set()
  };
}

function addStatusAndRouting(group, result, requestedModel, fallbackUsed, metadata, hasCallBreakdown) {
  group.case_count += 1;
  group.requested_models.add(String(requestedModel || 'Not recorded'));
  if (result.status === 'passed') group.passed_cases += 1;
  else if (result.status === 'failed') group.failed_cases += 1;
  else if (result.status === 'error') group.error_cases += 1;
  else group.pending_cases += 1;
  if (['passed', 'failed'].includes(result.status)) group.answered_cases += 1;
  if (fallbackUsed) group.fallback_cases += 1;
  if (Number.isFinite(Number(result.latency_ms)) && result.latency_ms !== null) group._latencies.push(Number(result.latency_ms));
  if (metadata.fallbackReason) group.fallback_reasons.add(String(metadata.fallbackReason));

  // New rows carry per-LLM-call token/cost snapshots. Legacy rows do not, so
  // use the original result-level totals for those historical results.
  if (!hasCallBreakdown) {
    group.total_input_tokens += Number(result.input_tokens ?? 0);
    group.total_output_tokens += Number(result.output_tokens ?? 0);
    if (['passed', 'failed'].includes(result.status)) {
      group.model_call_count += 1;
      group._callOperations.add('generation');
      if (result.estimated_cost_usd !== null && result.estimated_cost_usd !== undefined && Number.isFinite(Number(result.estimated_cost_usd))) {
        group._costs.push(Number(result.estimated_cost_usd));
        group._costSources.add(metadata.costEstimate?.rateSource || 'stored-estimate');
      } else if (metadata.mode === 'mock' || metadata.deterministic === true) {
        group._costs.push(0);
        group._costSources.add('mock');
        group._pricingExplanations.add('The Mock provider uses local fixtures and makes no model API calls; no API usage charge is incurred.');
      } else {
        group._unpricedCostCalls += 1;
        group._pricingExplanations.add(metadata.costEstimate?.explanation || 'Cost was not recorded for this historical result. Historical runs are not recalculated automatically; run a new evaluation after configuring rates.');
      }
    }
  }
}

function addModelCallUsage(groups, call, fallbackModel) {
  const model = String(call.model || fallbackModel || 'Model not reported');
  if (!groups.has(model)) groups.set(model, emptyModelGroup(model));
  const group = groups.get(model);
  group.model_call_count += 1;
  if (call.operation) group._callOperations.add(String(call.operation));
  group.total_input_tokens += Number(call.inputTokens ?? 0);
  group.total_output_tokens += Number(call.outputTokens ?? 0);
  if (call.pricingStatus === 'estimated' || call.pricingStatus === 'not_applicable') {
    if (call.estimatedCostUsd !== null && call.estimatedCostUsd !== undefined && Number.isFinite(Number(call.estimatedCostUsd))) {
      group._costs.push(Number(call.estimatedCostUsd));
      group._costSources.add(String(call.rateSource || (call.pricingStatus === 'not_applicable' ? 'mock' : 'unknown-rate-source')));
    } else {
      group._unpricedCostCalls += 1;
    }
  } else {
    group._unpricedCostCalls += 1;
  }
  if (call.explanation) group._pricingExplanations.add(String(call.explanation));
}

function finalizeGroup(group) {
  const {
    _latencies, _costs, requested_models, fallback_reasons,
    _unpricedCostCalls, _costSources, _pricingExplanations, _callOperations, ...rest
  } = group;
  const totalTokens = rest.total_input_tokens + rest.total_output_tokens;
  const estimatedSum = _costs.length ? Number(_costs.reduce((sum, value) => sum + value, 0).toFixed(10)) : null;
  let pricingStatus;
  let estimatedCostUsd = null;
  let pricingExplanation = [..._pricingExplanations].join(' ');

  if (rest.model === 'No model response' && rest.case_count > 0) {
    pricingStatus = 'no_usage';
    pricingExplanation = 'No model response was received, so no token-based cost estimate can be calculated for these cases.';
  } else if (_unpricedCostCalls > 0) {
    pricingStatus = _costs.length ? 'partial' : 'unavailable';
    estimatedCostUsd = null;
    const partialMessage = _costs.length
      ? `A known subtotal of $${estimatedSum.toFixed(8)} is available, but the full model cost is withheld because one or more calls lack configured pricing.`
      : 'No complete cost estimate is available because one or more model calls do not have pricing configured.';
    pricingExplanation = [pricingExplanation, partialMessage].filter(Boolean).join(' ');
  } else if (_costs.length > 0) {
    estimatedCostUsd = estimatedSum;
    pricingStatus = _costSources.size === 1 && _costSources.has('mock') ? 'not_applicable' : 'estimated';
    if (pricingStatus === 'not_applicable') {
      pricingExplanation = 'The Mock provider uses local fixtures and makes no model API calls; no API usage charge is incurred.';
    } else if (!pricingExplanation) {
      if (_costSources.has('provider-default')) {
        pricingExplanation = 'Estimated using configured provider-wide rates. This may not match the exact model price.';
      } else if (_costSources.has('stored-estimate')) {
        pricingExplanation = 'Uses a previously stored result-level estimate; historical records may not preserve per-model rate provenance.';
      } else if (_costSources.has('unknown-rate-source')) {
        pricingExplanation = 'A cost amount is stored, but its pricing source was not recorded.';
      } else {
        pricingExplanation = 'Estimated from configured model-specific rates recorded with each model call.';
      }
    }
  } else {
    pricingStatus = 'unavailable';
    pricingExplanation = pricingExplanation || 'No pricing rates or model usage cost snapshot is available for this run.';
  }

  return {
    ...rest,
    requested_models: [...requested_models].sort(),
    average_latency_ms: _latencies.length
      ? Math.round(_latencies.reduce((sum, value) => sum + value, 0) / _latencies.length)
      : null,
    total_tokens: totalTokens,
    estimated_cost_usd: estimatedCostUsd,
    known_estimated_cost_usd: pricingStatus === 'partial' ? estimatedSum : null,
    pricing_status: pricingStatus,
    pricing_sources: [..._costSources].sort(),
    call_operations: [..._callOperations].sort(),
    pricing_explanation: pricingExplanation,
    pass_rate_percentage: rest.answered_cases
      ? Number((rest.passed_cases / rest.answered_cases * 100).toFixed(1))
      : null,
    fallback_rate_percentage: rest.case_count
      ? Number((rest.fallback_cases / rest.case_count * 100).toFixed(1))
      : 0,
    fallback_reasons: [...fallback_reasons]
  };
}

/**
 * Summarize actual model routing and model-specific costs. New result records
 * retain pricing snapshots per model call; old records are reported as
 * unavailable rather than silently recalculated with today's rates.
 */
export function buildModelReport(run, results = []) {
  const groups = new Map();
  const unassigned = emptyModelGroup('No model response');
  const distinctRequestedModels = new Set([String(run.model || 'Not recorded')]);
  let fallbackCases = 0;
  const fallbackReasons = new Set();

  for (const result of results) {
    const metadata = metadataFor(result);
    const requestedModel = metadata.requestedModel || run.model || 'Not recorded';
    distinctRequestedModels.add(String(requestedModel));
    const fallbackUsed = resultFallbackUsed(result, metadata);
    if (fallbackUsed) fallbackCases += 1;
    if (metadata.fallbackReason) fallbackReasons.add(String(metadata.fallbackReason));

    const actualModel = resolveActualModel(run, result, metadata);
    const costEstimate = asObject(metadata.costEstimate);
    const calls = Array.isArray(costEstimate.calls) ? costEstimate.calls : null;
    const hasCallBreakdown = Boolean(calls && calls.length > 0);
    if (!actualModel) {
      addStatusAndRouting(unassigned, result, requestedModel, fallbackUsed, metadata, hasCallBreakdown);
    } else {
      if (!groups.has(actualModel)) groups.set(actualModel, emptyModelGroup(actualModel));
      addStatusAndRouting(groups.get(actualModel), result, requestedModel, fallbackUsed, metadata, hasCallBreakdown);
    }

    if (hasCallBreakdown) {
      for (const call of calls) addModelCallUsage(groups, call, actualModel);
    }
  }

  const models = [...groups.values()]
    .map(finalizeGroup)
    .sort((a, b) => b.case_count - a.case_count || b.model_call_count - a.model_call_count || a.model.localeCompare(b.model));
  const unassignedCases = finalizeGroup(unassigned);
  const answeredCases = results.filter((result) => ['passed', 'failed'].includes(result.status) && resolveActualModel(run, result, metadataFor(result))).length;
  const observedActualModels = models.filter((model) => model.case_count > 0).map((model) => model.model);
  const completedResponses = models.reduce((sum, model) => sum + model.answered_cases, 0);
  const modelsWithUsage = models.filter((model) => model.model_call_count > 0);
  const incompletePricingModels = modelsWithUsage.filter((model) => ['partial', 'unavailable'].includes(model.pricing_status));
  const knownCostSubtotal = modelsWithUsage.reduce((sum, model) => sum + Number(model.estimated_cost_usd ?? model.known_estimated_cost_usd ?? 0), 0);
  let totalCostStatus = 'no_usage';
  let totalEstimatedCostUsd = null;
  let totalKnownEstimatedCostUsd = null;
  let totalCostExplanation = 'No model usage was recorded for this run.';
  if (modelsWithUsage.length > 0) {
    if (incompletePricingModels.length > 0) {
      const hasKnownCost = modelsWithUsage.some((model) => model.estimated_cost_usd !== null || model.known_estimated_cost_usd !== null);
      totalCostStatus = hasKnownCost ? 'partial' : 'unavailable';
      totalKnownEstimatedCostUsd = Number(knownCostSubtotal.toFixed(10));
      totalCostExplanation = `A complete run total is unavailable because pricing is incomplete for: ${incompletePricingModels.map((model) => model.model).join(', ')}. ${incompletePricingModels.map((model) => model.pricing_explanation).filter(Boolean).join(' ')}`;
    } else {
      totalCostStatus = modelsWithUsage.every((model) => model.pricing_status === 'not_applicable') ? 'not_applicable' : 'estimated';
      totalEstimatedCostUsd = Number(modelsWithUsage.reduce((sum, model) => sum + Number(model.estimated_cost_usd ?? 0), 0).toFixed(10));
      totalCostExplanation = totalCostStatus === 'not_applicable'
        ? 'The Mock provider makes no model API calls; no API usage charge is incurred.'
        : 'Total estimated cost sums the recorded per-call estimates using the rate source shown for each actual model. Provider errors without usage counts are excluded.';
    }
  }

  return {
    provider: run.provider,
    requested_model: run.model || null,
    requested_models: [...distinctRequestedModels].sort(),
    actual_models: observedActualModels,
    model_count: observedActualModels.length,
    mixed_model_run: observedActualModels.length > 1,
    total_cases: results.length,
    cases_with_model_response: answeredCases,
    cases_without_model_response: unassignedCases.case_count,
    provider_error_cases: unassignedCases.error_cases,
    pending_cases: unassignedCases.pending_cases,
    fallback_cases: fallbackCases,
    fallback_rate_percentage: answeredCases ? Number((fallbackCases / answeredCases * 100).toFixed(1)) : 0,
    fallback_reasons: [...fallbackReasons],
    models,
    unassigned_cases: unassignedCases,
    completed_model_responses: completedResponses,
    total_estimated_cost_usd: totalEstimatedCostUsd,
    total_known_estimated_cost_usd: totalKnownEstimatedCostUsd,
    total_cost_status: totalCostStatus,
    total_cost_explanation: totalCostExplanation
  };
}
