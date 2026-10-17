const state = {
  datasets: [],
  runs: [],
  runsPage: 1,
  runsPageSize: 10,
  runsPageCursors: [null],
  runsHasMore: false,
  runsNextCursor: null,
  selectedRun: null,
  selectedCampaignId: null,
  selectedCampaign: null,
  selectedCompareRuns: [],
  selectedDatasetId: null,
  editingDatasetId: null,
  editingDatasetVersion: null
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const pretty = (value) => JSON.stringify(value ?? null, null, 2);
const formatDate = (value) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const number = (value) => Number(value ?? 0).toLocaleString();
const runPassRate = (run) => { const answered = Number(run.passed_cases ?? 0) + Number(run.failed_cases ?? 0); return answered ? Number((Number(run.passed_cases ?? 0) / answered * 100).toFixed(1)) : null; };
const statusLabel = (status) => ({ queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[status] ?? status ?? 'Unknown');
const formatLatency = (value) => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : `${number(Math.round(Number(value)))} ms`;
const formatUsd = (value) => `$${Number(value ?? 0).toFixed(8)}`;
const costSourceLabel = (sources = []) => {
  const sourceLabels = {
    'model-specific': 'Model-specific rates',
    'provider-default': 'Provider-wide fallback rates (may differ from this model)',
    mock: 'Mock provider; no API charge',
    'stored-estimate': 'Previously stored estimate; rate source not recorded',
    'unknown-rate-source': 'Rate source not recorded'
  };
  const labels = new Set((Array.isArray(sources) ? sources : []).map((source) => sourceLabels[source] ?? String(source)));
  return [...labels].join(' · ');
};
function renderCostCell(model) {
  const explanation = model.pricing_explanation || 'Pricing was not recorded for this result. Configure rates and run a new evaluation to estimate cost.';
  const status = model.pricing_status || (model.estimated_cost_usd != null ? 'estimated' : 'unavailable');
  if (status === 'estimated') {
    const source = costSourceLabel(model.pricing_sources) || 'Rate source not recorded';
    return `<td><strong title="${escapeHtml(explanation)}">Est. ${escapeHtml(formatUsd(model.estimated_cost_usd))}</strong><small title="${escapeHtml(explanation)}">${escapeHtml(source)}</small></td>`;
  }
  if (status === 'not_applicable') {
    return `<td><strong title="${escapeHtml(explanation)}">$0.00000000</strong><small title="${escapeHtml(explanation)}">No API charge (Mock)</small></td>`;
  }
  if (status === 'partial') {
    const subtotal = model.known_estimated_cost_usd == null ? '' : ` Known subtotal: ${formatUsd(model.known_estimated_cost_usd)}.`;
    return `<td><strong title="${escapeHtml(explanation)}">Partial estimate</strong><small title="${escapeHtml(explanation)}">Full total unavailable.${escapeHtml(subtotal)}</small></td>`;
  }
  if (status === 'no_usage') {
    return `<td><strong title="${escapeHtml(explanation)}">Not estimated</strong><small title="${escapeHtml(explanation)}">No model usage recorded</small></td>`;
  }
  return `<td><strong title="${escapeHtml(explanation)}">Unavailable</strong><small title="${escapeHtml(explanation)}">Pricing not configured</small></td>`;
}
function caseCostDisplay(result, metadata) {
  const estimate = objectValue(metadata.costEstimate);
  if (estimate.pricingStatus === 'estimated') {
    const source = estimate.rateSources?.length ? costSourceLabel(estimate.rateSources) : (estimate.calls?.length ? costSourceLabel([...new Set(estimate.calls.map((call) => call.rateSource).filter(Boolean))]) : 'Configured rates');
    return { value: `Est. ${formatUsd(estimate.estimatedCostUsd)}`, explanation: `${estimate.explanation || 'Estimated from configured rates.'}${source ? ` Rate source: ${source}.` : ''}` };
  }
  if (estimate.pricingStatus === 'not_applicable') {
    return { value: 'No API charge ($0.00000000)', explanation: estimate.explanation || 'The Mock provider makes no model API calls.' };
  }
  if (estimate.pricingStatus === 'partial') {
    const subtotal = estimate.knownEstimatedCostUsd == null ? '' : ` Known subtotal: ${formatUsd(estimate.knownEstimatedCostUsd)}.`;
    return { value: `Partial estimate${subtotal ? ` · ${formatUsd(estimate.knownEstimatedCostUsd)}` : ''}`, explanation: `${estimate.explanation || 'Some model calls do not have configured prices.'} The full estimate is unavailable because at least one call is unpriced.` };
  }
  if (estimate.pricingStatus === 'unavailable') {
    return { value: 'Unavailable', explanation: estimate.explanation || 'No complete model-specific or provider-wide rates were configured.' };
  }
  if (result.status === 'error' || !result.actual_output) {
    return { value: 'Unavailable', explanation: 'No model response/usage was recorded for this case, so token-based cost cannot be estimated.' };
  }
  if (result.estimated_cost_usd !== null && result.estimated_cost_usd !== undefined) {
    return { value: `Est. ${formatUsd(result.estimated_cost_usd)}`, explanation: 'A cost amount was stored, but this historical result does not contain the rate-source snapshot.' };
  }
  return { value: 'Not configured', explanation: 'Cost was not recorded when this run executed. Set complete model-specific rates in MODEL_COST_RATES_JSON, or complete provider-wide rates, then run a new evaluation. Historical results are not recalculated automatically.' };
}

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } }
  return {};
}

function getResultMetadata(result) {
  const actual = objectValue(result?.actual_output);
  return objectValue(actual.providerMetadata);
}

function getResultRouting(result, run = state.selectedRun) {
  const metadata = getResultMetadata(result);
  const actualModel = metadata.actualModel || metadata.modelVersion || metadata.model
    || (run?.provider === 'mock' && result?.actual_output ? run.model : null);
  const requestedModel = metadata.requestedModel || run?.model || 'Not recorded';
  const traceFallback = (Array.isArray(result?.trace) ? result.trace : []).some((event) => event?.type === 'model.completed' && event.fallbackUsed === true);
  const fallbackUsed = metadata.fallbackUsed === true || metadata.fallbackUsed === 'true' || traceFallback;
  return {
    requestedModel: String(requestedModel),
    actualModel: actualModel ? String(actualModel) : null,
    fallbackUsed,
    fallbackReason: metadata.fallbackReason || (Array.isArray(result?.trace) ? result.trace.find((event) => event?.fallbackReason)?.fallbackReason : null) || null
  };
}

function buildClientModelReport(run) {
  const groups = new Map();
  const unassigned = { model: 'No model response', case_count: 0, passed_cases: 0, failed_cases: 0, error_cases: 0, pending_cases: 0, answered_cases: 0, fallback_cases: 0, _latencies: [], total_input_tokens: 0, total_output_tokens: 0 };
  let fallbackCases = 0;
  for (const result of run.results ?? []) {
    const routing = getResultRouting(result, run);
    const target = routing.actualModel ? (groups.get(routing.actualModel) || {
      model: routing.actualModel, requested_models: [], case_count: 0, passed_cases: 0, failed_cases: 0, error_cases: 0,
      pending_cases: 0, answered_cases: 0, fallback_cases: 0, _latencies: [], total_input_tokens: 0, total_output_tokens: 0, _costs: [], fallback_reasons: []
    }) : unassigned;
    if (routing.actualModel && !groups.has(routing.actualModel)) groups.set(routing.actualModel, target);
    target.case_count += 1;
    if (target.requested_models && !target.requested_models.includes(routing.requestedModel)) target.requested_models.push(routing.requestedModel);
    if (result.status === 'passed') target.passed_cases += 1;
    else if (result.status === 'failed') target.failed_cases += 1;
    else if (result.status === 'error') target.error_cases += 1;
    else target.pending_cases += 1;
    if (['passed', 'failed'].includes(result.status)) target.answered_cases += 1;
    if (routing.fallbackUsed) { target.fallback_cases += 1; fallbackCases += 1; }
    if (result.latency_ms !== null && result.latency_ms !== undefined) target._latencies.push(Number(result.latency_ms));
    target.total_input_tokens += Number(result.input_tokens ?? 0);
    target.total_output_tokens += Number(result.output_tokens ?? 0);
    if (target._costs && result.estimated_cost_usd !== null && result.estimated_cost_usd !== undefined) target._costs.push(Number(result.estimated_cost_usd));
    if (target.fallback_reasons && routing.fallbackReason && !target.fallback_reasons.includes(routing.fallbackReason)) target.fallback_reasons.push(routing.fallbackReason);
  }
  const finalize = (group) => ({
    ...group,
    average_latency_ms: group._latencies.length ? Math.round(group._latencies.reduce((sum, value) => sum + value, 0) / group._latencies.length) : null,
    total_tokens: Number(group.total_input_tokens ?? 0) + Number(group.total_output_tokens ?? 0),
    estimated_cost_usd: group._costs?.length ? group._costs.reduce((sum, value) => sum + value, 0) : null,
    pass_rate_percentage: group.answered_cases ? Number((group.passed_cases / group.answered_cases * 100).toFixed(1)) : null,
    fallback_rate_percentage: group.case_count ? Number((group.fallback_cases / group.case_count * 100).toFixed(1)) : 0
  });
  const models = [...groups.values()].map(finalize).sort((a, b) => b.case_count - a.case_count);
  const noModelResponse = finalize(unassigned);
  return {
    requested_model: run.model,
    actual_models: models.map((model) => model.model),
    model_count: models.length,
    mixed_model_run: models.length > 1,
    total_cases: (run.results ?? []).length,
    cases_with_model_response: models.reduce((sum, model) => sum + model.case_count, 0),
    cases_without_model_response: noModelResponse.case_count,
    provider_error_cases: noModelResponse.error_cases,
    pending_cases: noModelResponse.pending_cases,
    fallback_cases: fallbackCases,
    fallback_rate_percentage: models.reduce((sum, model) => sum + model.case_count, 0) ? Number((fallbackCases / models.reduce((sum, model) => sum + model.case_count, 0) * 100).toFixed(1)) : 0,
    models,
    unassigned_cases: noModelResponse
  };
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) }
  });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith('/api/auth/')) {
      document.querySelector('.app-shell').hidden = true;
      document.querySelector('#account-gate').hidden = false;
      document.querySelector('#account-error').textContent = 'Your session expired. Sign in again to continue.';
    }
    throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  }
  return body.pagination ? { data: body.data, pagination: body.pagination } : body.data;
}

function showToast(message, kind = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  $('#toast-region').append(toast);
  window.setTimeout(() => toast.remove(), 4500);
}

function setMessage(selector, message, type = '') {
  const element = $(selector);
  element.textContent = message;
  element.className = `form-message${type ? ` ${type}` : ''}`;
}

async function refreshHealth() {
  const indicator = $('.pulse-dot');
  try {
    const data = await api('/api/health');
    indicator?.classList.add('ok');
    indicator?.classList.remove('fail');
    $('#engine-status').textContent = data.checks ? 'API, database, and queue online' : 'Service online';
  } catch (error) {
    indicator?.classList.remove('ok');
    indicator?.classList.add('fail');
    $('#engine-status').textContent = 'Service unavailable';
  }
}

async function refreshAll({ quiet = false, resetRuns = false } = {}) {
  try {
    if (resetRuns) { state.runsPage = 1; state.runsPageCursors = [null]; }
    const cursor = state.runsPageCursors[state.runsPage - 1] ?? null;
    const runsUrl = new URL('/api/evaluations', window.location.origin);
    runsUrl.searchParams.set('limit', String(state.runsPageSize));
    if (cursor) runsUrl.searchParams.set('cursor', cursor);
    const [datasets, runPage] = await Promise.all([api('/api/datasets'), api(`${runsUrl.pathname}${runsUrl.search}`)]);
    const previousLatestRunId = state.runs[0]?.id ?? null;
    state.datasets = datasets;
    state.runs = runPage.data;
    state.runsHasMore = runPage.pagination.has_more;
    state.runsNextCursor = runPage.pagination.next_cursor;
    if (state.runsPage === 1 && state.runs[0]?.id && state.runs[0].id !== previousLatestRunId) {
      state.runsPageCursors = [null];
    }
    renderDatasets();
    renderRuns();
    renderMetrics();
    updateDatasetSelect();
    await refreshHealth();
    // Keep the inspector in sync even when a run has just transitioned
    // from queued/running to a terminal state such as completed or failed.
    // Previously, the detail panel only refreshed while the list status was
    // queued/running, leaving stale details after the run completed.
    if (state.selectedRun) {
      await openRunDetails(state.selectedRun.id, { quiet: true });
    } else if (state.selectedCampaignId) {
      await openCampaignDetails(state.selectedCampaignId, { quiet: true });
    }
    return true;
  } catch (error) {
    if (!quiet) showToast(error.message, 'error');
    $('#engine-status').textContent = 'Could not load workspace';
    return false;
  }
}

function updateDatasetSelect() {
  const select = $('#dataset-select');
  const current = state.selectedDatasetId || select.value;
  if (!state.datasets.length) {
    select.innerHTML = '<option value="">No datasets found</option>';
    return;
  }
  select.innerHTML = state.datasets.map((dataset) =>
    `<option value="${escapeHtml(dataset.id)}">${escapeHtml(dataset.name)} · ${number(dataset.test_case_count)} cases</option>`
  ).join('');
  if (state.datasets.some((dataset) => dataset.id === current)) select.value = current;
  state.selectedDatasetId = select.value;
}

function renderMetrics() {
  $('#metric-runs').textContent = number(state.runs.length);
  const latestCompleted = state.runs.find((run) => run.status === 'completed' && Number(run.completed_cases) > 0);
  $('#metric-pass-rate').innerHTML = latestCompleted && runPassRate(latestCompleted) !== null ? `${runPassRate(latestCompleted)}<small>%</small>` : '—<small>%</small>';
  $('#metric-pass-context').textContent = latestCompleted ? `${latestCompleted.passed_cases}/${Number(latestCompleted.passed_cases ?? 0) + Number(latestCompleted.failed_cases ?? 0)} answered cases · latest completed run` : 'Waiting for completed results';
  const totalCases = state.runs.reduce((sum, run) => sum + Number(run.completed_cases ?? 0), 0);
  $('#metric-cases').textContent = number(totalCases);
  const latencies = state.runs.filter((run) => run.average_latency_ms !== null && run.average_latency_ms !== undefined).map((run) => Number(run.average_latency_ms));
  const averageLatency = latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null;
  $('#metric-latency').innerHTML = averageLatency === null ? '—<small>ms</small>' : `${number(averageLatency)}<small>ms</small>`;
}

async function changeRunsPage(direction) {
  if (direction < 0 && state.runsPage <= 1) return;
  if (direction > 0 && (!state.runsHasMore || !state.runsNextCursor)) return;
  const previousPage = state.runsPage;
  const previousCursors = [...state.runsPageCursors];
  if (direction < 0) {
    state.runsPage -= 1;
    state.runsPageCursors.pop();
  } else {
    state.runsPageCursors.push(state.runsNextCursor);
    state.runsPage += 1;
  }
  const loaded = await refreshAll({ quiet: true });
  if (!loaded) {
    state.runsPage = previousPage;
    state.runsPageCursors = previousCursors;
    await refreshAll({ quiet: true });
  }
}

function renderRunsPagination() {
  const footer = $('.table-footer');
  if (!footer) return;

  let container = $('#runs-pagination');
  if (!container) {
    container = document.createElement('nav');
    container.id = 'runs-pagination';
    container.className = 'runs-pagination';
    container.setAttribute('aria-label', 'Recent evaluation run pages');
    footer.insertAdjacentElement('afterend', container);
  }

  if (!state.runs.length && state.runsPage === 1 || state.runsPage === 1 && !state.runsHasMore) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  container.hidden = false;
  container.innerHTML = `<div class="runs-pagination-controls">
    <button type="button" class="run-page-button run-page-step" data-run-direction="-1" ${state.runsPage <= 1 ? 'disabled' : ''}>← Previous</button>
    <span class="run-page-label" aria-live="polite">Page ${number(state.runsPage)}</span>
    <button type="button" class="run-page-button run-page-step" data-run-direction="1" ${state.runsHasMore ? '' : 'disabled'}>Next →</button>
  </div>`;
  container.querySelectorAll('button[data-run-direction]').forEach((button) => {
    button.addEventListener('click', () => changeRunsPage(Number(button.dataset.runDirection)));
  });
}

function renderRuns() {
  const tbody = $('#runs-table-body');
  const totalRunCount = state.runs.length;
  $('#runs-count').textContent = totalRunCount
    ? `Page ${number(state.runsPage)} · ${number(totalRunCount)} runs${state.runsHasMore ? ' · more available' : ''}`
    : 'Showing 0 runs';
  if (!state.runs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No evaluation runs yet. Start your first run above.</td></tr>';
  } else {
    tbody.innerHTML = state.runs.map((run) => {
      const rate = runPassRate(run);
      const metric = run.status === 'running' || run.status === 'queued'
        ? `${number(run.completed_cases)}/${number(run.total_cases)}`
        : rate === null ? '—' : `${rate}%`;
      const canCompare = ['completed', 'failed'].includes(run.status);
      const isChecked = state.selectedCompareRuns.includes(run.id);
      const actualModels = Array.isArray(run.actual_model_names) ? run.actual_model_names.filter(Boolean) : [];
      const fallbackCount = Number(run.fallback_cases ?? 0);
      const respondedCount = Number(run.model_response_cases ?? 0);
      const routingSummary = actualModels.length
        ? `<span class="run-model-note">Actual: ${escapeHtml(actualModels.join(', '))}${fallbackCount ? ` · fallback ${fallbackCount}/${respondedCount || fallbackCount}` : ''}</span>`
        : (run.status === 'queued' || run.status === 'running') ? '<span class="run-model-note muted">Awaiting model responses</span>' : '';
      const repetitionLabel = run.campaign_id
        ? `<span class="run-model-note campaign-status-note">Reliability campaign · repeat ${number(run.repetition_index)} of ${number(run.campaign_repeat_count)}</span>`
        : '';
      const campaignAction = run.campaign_id && Number(run.repetition_index) === 1
        ? `<button class="mini-action inspect-campaign" data-campaign-id="${escapeHtml(run.campaign_id)}" title="Inspect repeated-run reliability" aria-label="Inspect repeated-run reliability">◉</button>`
        : '';
      return `<tr>
        <td><div class="run-name" title="${escapeHtml(run.id)}">${escapeHtml(run.dataset_name ?? 'Evaluation run')}</div><span class="run-sub">${escapeHtml(run.provider)} / requested: ${escapeHtml(run.model)}</span>${routingSummary}${repetitionLabel}</td>
        <td><span class="status-pill ${escapeHtml(run.status)}">${escapeHtml(statusLabel(run.status))}</span></td>
        <td class="rate-cell">${escapeHtml(metric)}${run.status === 'completed' ? `<span class="rate-track"><span class="rate-fill" style="display:block;width:${rate}%;"></span></span>` : ''}</td>
        <td class="date-cell">${escapeHtml(formatDate(run.created_at))}</td>
        <td><div class="row-actions"><button class="mini-action inspect-run" data-run-id="${escapeHtml(run.id)}" title="Inspect run" aria-label="Inspect run">↗</button>${campaignAction}${canCompare ? `<input class="compare-checkbox" type="checkbox" data-compare-id="${escapeHtml(run.id)}" aria-label="Select run to compare" ${isChecked ? 'checked' : ''}>` : ''}</div></td>
      </tr>`;
    }).join('');
  }
  renderCompareBar();
  renderRunsPagination();
}

function renderDatasets() {
  const grid = $('#dataset-grid');
  $('#dataset-count').textContent = `${state.datasets.length} dataset${state.datasets.length === 1 ? '' : 's'}`;
  if (!state.datasets.length) {
    grid.innerHTML = '<div class="empty-state">No datasets yet. Import a JSON dataset below to begin.</div>';
    return;
  }
  grid.innerHTML = state.datasets.map((dataset) => `<article class="dataset-card">
    <div class="dataset-icon">▤</div>
    <div class="dataset-title">${escapeHtml(dataset.name)}</div>
    <p class="dataset-description">${escapeHtml(dataset.description || 'No description provided.')}</p>
    <div class="dataset-meta"><span>${number(dataset.test_case_count)} TESTS</span><span>v${escapeHtml(dataset.latest_version ?? 1)}</span></div>
    <div class="dataset-actions">
      <button class="dataset-run" data-dataset-id="${escapeHtml(dataset.id)}">Run evaluation →</button>
      <button class="dataset-edit" data-edit-dataset-id="${escapeHtml(dataset.id)}">Edit dataset</button>
      <button class="dataset-calibrate" data-calibrate-dataset-id="${escapeHtml(dataset.id)}">Calibrate goldens</button>
    </div>
    <div class="dataset-calibration" data-calibration-dataset-id="${escapeHtml(dataset.id)}" hidden></div>
  </article>`).join('');
}

function renderCompareBar() {
  const bar = $('#compare-bar');
  const count = state.selectedCompareRuns.length;
  bar.hidden = count === 0;
  $('#compare-label').textContent = count === 0 ? 'Select two completed runs' : count === 1 ? 'Select one more run' : `${count} runs selected`;
  $('#compare-button').disabled = count !== 2;
  $('#compare-result').hidden = true;
}

function fallbackReasonLabel(reason) {
  return ({ 'provider-unavailable': 'temporarily unavailable', 'quota/rate-limit': 'rate-limited / quota', timeout: 'timed out' })[reason] ?? (reason || 'unknown');
}

function renderFallbackAttempts(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return '<small>No structured attempt data was recorded; see the original text below.</small>';
  const rows = attempts.map((attempt) => `<tr>
    <td>${escapeHtml(attempt.model ?? '—')}</td>
    <td>${attempt.outcome === 'skipped_cooldown' ? 'Skipped (cooldown)' : 'Failed'}</td>
    <td>${escapeHtml(fallbackReasonLabel(attempt.reason))}${attempt.http_status ? ` · HTTP ${escapeHtml(attempt.http_status)}` : ''}</td>
    <td>${escapeHtml(attempt.cooldown_until ?? '—')}</td>
    <td>${attempt.message ? escapeHtml(attempt.message) : '—'}</td>
  </tr>`).join('');
  return `<div class="table-wrap"><table class="fallback-attempts-table"><thead><tr><th>Model</th><th>Outcome</th><th>Reason</th><th>Cooldown until</th><th>Provider response</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderFallbackSummary(summary) {
  const box = $('#fallback-summary');
  if (!box) return;
  if (!summary) { box.hidden = true; box.innerHTML = ''; return; }
  const cooldown = summary.first_cooldown_until
    ? `<div><span>Cooldown window</span><strong>${escapeHtml(summary.first_cooldown_until)}${summary.last_cooldown_until && summary.last_cooldown_until !== summary.first_cooldown_until ? ` → ${escapeHtml(summary.last_cooldown_until)}` : ''}</strong></div>` : '';
  const perCase = (summary.cases ?? []).map((item) => `<details class="fallback-case"><summary>${escapeHtml(item.test_case_name ?? item.test_case_id ?? 'Test case')} → ${escapeHtml(item.actual_model ?? 'unknown model')}</summary>${renderFallbackAttempts(item.attempts)}${item.raw_reason ? `<pre>${escapeHtml(item.raw_reason)}</pre>` : ''}</details>`).join('');
  box.hidden = false;
  box.innerHTML = `<p class="fallback-headline"><strong>${escapeHtml(summary.headline)}</strong></p>
    <details class="fallback-details"><summary>Fallback details (${number(summary.fallback_cases)} case${summary.fallback_cases === 1 ? '' : 's'})</summary>
      <div class="routing-details">
        <div><span>Requested model</span><strong>${escapeHtml((summary.requested_models ?? []).join(', ') || '—')}</strong></div>
        <div><span>Actual model</span><strong>${escapeHtml((summary.actual_models ?? []).join(', ') || '—')}</strong></div>
        <div><span>Failure reason</span><strong>${escapeHtml((summary.reasons ?? []).map(fallbackReasonLabel).join(', ') || '—')}${(summary.http_statuses ?? []).length ? ` · HTTP ${escapeHtml(summary.http_statuses.join('/'))}` : ''}</strong></div>
        ${cooldown}
      </div>${perCase}
    </details>`;
}

function renderModelReport(run) {
  const report = run.model_report ?? buildClientModelReport(run);
  const actualModels = Array.isArray(report.actual_models) ? report.actual_models : [];
  const modelRows = Array.isArray(report.models) ? report.models : [];
  const fallbackCases = Number(report.fallback_cases ?? 0);
  const responseCases = Number(report.cases_with_model_response ?? 0);
  const noResponseCases = Number(report.cases_without_model_response ?? 0);
  const titleActualModels = actualModels.length ? actualModels.join(', ') : 'No model responses yet';
  const statusText = report.mixed_model_run ? 'Mixed-model run' : fallbackCases ? 'Fallback active' : modelRows.length ? 'Single model observed' : 'Awaiting responses';

  $('#model-report-status').textContent = statusText;
  $('#model-report-caption').textContent = `Requested model: ${report.requested_model || run.model || 'Not recorded'} · Actual model(s): ${titleActualModels}`;
  const totalCostLabel = report.total_cost_status === 'not_applicable'
    ? 'No API charge'
    : report.total_cost_status === 'partial'
      ? `Partial · ${formatUsd(report.total_known_estimated_cost_usd ?? 0)}`
      : report.total_estimated_cost_usd == null
        ? (report.total_cost_status === 'no_usage' ? 'No usage' : 'Unavailable')
        : `Est. ${formatUsd(report.total_estimated_cost_usd)}`;
  const cards = [
    ['Requested model', report.requested_model || run.model || 'Not recorded'],
    ['Actual models', String(actualModels.length)],
    ['Fallback cases', `${fallbackCases} / ${responseCases}`],
    ['No model response', String(noResponseCases)],
    ['Total estimated cost', totalCostLabel]
  ];
  $('#model-report-summary').innerHTML = cards.map(([label, value]) => `<div class="model-report-stat"><span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`).join('');

  const rows = modelRows.map((model) => {
    const requested = Array.isArray(model.requested_models) && model.requested_models.length
      ? `<small>Requested: ${escapeHtml(model.requested_models.join(', '))}</small>` : '';
    const passRate = model.pass_rate_percentage == null ? '—' : `${Number(model.pass_rate_percentage).toFixed(1)}%`;
    const statusCounts = `${number(model.passed_cases)} / ${number(model.failed_cases)} / ${number(model.error_cases)}`;
    const fallback = `${number(model.fallback_cases)}${model.case_count ? ` (${Number(model.fallback_rate_percentage ?? 0).toFixed(1)}%)` : ''}`;
    const reason = Array.isArray(model.fallback_reasons) && model.fallback_reasons.length
      ? '<small class="fallback-reason">Served via fallback — see fallback details below.</small>' : '';
    const operations = Array.isArray(model.call_operations) && model.call_operations.length
      ? `<small>Calls: ${escapeHtml(model.call_operations.map((operation) => operation === 'llm_judge' ? 'LLM judge' : operation).join(', '))}</small>` : '';
    return `<tr>
      <td><strong class="model-name-cell">${escapeHtml(model.model)}</strong>${requested}${operations}${reason}</td>
      <td>${number(model.case_count)}</td>
      <td>${number(model.model_call_count)}</td>
      <td class="rate-cell">${escapeHtml(passRate)}</td>
      <td>${escapeHtml(statusCounts)}</td>
      <td class="date-cell">${escapeHtml(formatLatency(model.average_latency_ms))}</td>
      <td>${number(model.total_input_tokens)} / ${number(model.total_output_tokens)}<small>${number(model.total_tokens)} total</small></td>
      ${renderCostCell(model)}
      <td>${escapeHtml(fallback)}</td>
    </tr>`;
  });
  const unassigned = report.unassigned_cases;
  if (unassigned && Number(unassigned.case_count ?? 0) > 0) {
    rows.push(`<tr class="unassigned-model-row">
      <td><strong class="model-name-cell">No model response</strong><small>No model response; inspect the failure classification below</small></td>
      <td>${number(unassigned.case_count)}</td><td>${number(unassigned.model_call_count)}</td><td>—</td>
      <td>${number(unassigned.passed_cases)} / ${number(unassigned.failed_cases)} / ${number(unassigned.error_cases)}</td>
      <td class="date-cell">${escapeHtml(formatLatency(unassigned.average_latency_ms))}</td>
      <td>${number(unassigned.total_input_tokens)} / ${number(unassigned.total_output_tokens)}<small>${number(unassigned.total_tokens)} total</small></td>
      ${renderCostCell(unassigned)}<td>0</td>
    </tr>`);
  }
  $('#model-report-table-body').innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="9" class="empty-cell">No model responses have been recorded for this run yet.</td></tr>';

  const notices = [];
  if (report.mixed_model_run) notices.push('This run contains responses from more than one actual model. Treat its overall pass rate as a mixed-model result, not a single-model benchmark.');
  if (fallbackCases && !report.fallback_summary) notices.push(`${fallbackCases} case(s) used fallback routing. Requested and actual model names are shown separately above and for each test case.`);
  if (noResponseCases) notices.push(`${noResponseCases} case(s) have no attributable model response. Provider errors are not counted as model-quality failures in the per-model pass rates.`);
  if (report.total_cost_explanation) notices.push(report.total_cost_explanation);
  if (!notices.length && modelRows.length) notices.push('All observed responses are attributed to the model metadata stored for each case.');
  $('#model-report-note').textContent = notices.join(' ');
  renderFallbackSummary(report.fallback_summary ?? null);
}

function campaignCostLabel(report) {
  if (report.total_estimated_cost_usd !== null && report.total_estimated_cost_usd !== undefined) {
    return formatUsd(report.total_estimated_cost_usd);
  }
  if (report.cost_estimate_status === 'partial') return `Partial · ${formatUsd(report.known_cost_subtotal_usd ?? 0)}`;
  return 'Unavailable';
}

async function openCampaignDetails(campaignId, { quiet = false } = {}) {
  try {
    const campaign = await api(`/api/evaluation-campaigns/${encodeURIComponent(campaignId)}`);
    state.selectedCampaignId = campaignId;
    state.selectedCampaign = campaign;
    state.selectedRun = null;
    $('#run-detail-panel').hidden = true;
    $('#campaign-detail-panel').hidden = false;
    $('#campaign-detail-title').textContent = `${campaign.dataset_name} · Reliability campaign`;
    $('#cancel-campaign-button').hidden = !['queued', 'running'].includes(campaign.status);

    const report = campaign.reliability ?? {};
    const interval = report.pass_rate_confidence_interval_95;
    const intervalLabel = interval ? `${interval.low}%–${interval.high}%` : 'Need 2+ analyzed repeats';
    const passRateLabel = report.average_pass_rate_percentage == null ? '—' : `${report.average_pass_rate_percentage}%`;
    const sdLabel = report.pass_rate_stddev_percentage_points == null ? '—' : `${report.pass_rate_stddev_percentage_points} pp`;
    const rangeLabel = report.minimum_pass_rate_percentage == null ? '—' : `${report.minimum_pass_rate_percentage}%–${report.maximum_pass_rate_percentage}%`;
    const stabilityLabel = report.case_stability_percentage == null ? 'Need 2+ answers per case' : `${report.case_stability_percentage}%`;
    const latencyLabel = report.average_case_latency_ms == null ? '—' : formatLatency(report.average_case_latency_ms);
    const completedLabel = `${number(report.completed_runs)} / ${number(report.planned_runs)} completed`;
    const cards = [
      ['Campaign status', statusLabel(campaign.status)],
      ['Completed repeats', completedLabel],
      ['Mean pass rate', passRateLabel],
      ['Run-to-run SD', sdLabel],
      ['Pass-rate range', rangeLabel],
      ['95% CI of mean', intervalLabel],
      ['Case stability', stabilityLabel],
      ['Average case latency', latencyLabel],
      ['Total estimated cost', campaignCostLabel(report)]
    ];
    $('#campaign-detail-summary').innerHTML = cards.map(([label, value]) => `<div class="detail-stat"><span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`).join('');

    const notes = [report.interpretation?.pass_rate, report.interpretation?.confidence_interval, report.interpretation?.model_routing, report.interpretation?.cost]
      .filter(Boolean);
    if (campaign.error_message) notes.unshift(`Campaign error: ${campaign.error_message}`);
    if (campaign.status === 'queued' || campaign.status === 'running') notes.unshift(`Progress: ${number(report.completed_runs)} of ${number(report.planned_runs)} repetitions have finished. Analysis updates as the campaign progresses.`);
    $('#campaign-interpretation').textContent = notes.join(' ');

    const runs = Array.isArray(report.run_summaries) ? report.run_summaries : [];
    $('#campaign-run-count').textContent = `${runs.length} repetition${runs.length === 1 ? '' : 's'}`;
    $('#campaign-runs-body').innerHTML = runs.length ? runs.map((run) => {
      const rate = run.pass_rate_percentage == null ? '—' : `${run.pass_rate_percentage}%`;
      const cost = run.estimated_cost_usd == null ? 'Unavailable' : formatUsd(run.estimated_cost_usd);
      const models = Array.isArray(run.actual_model_names) && run.actual_model_names.length ? run.actual_model_names.join(', ') : 'Not observed yet';
      return `<tr>
        <td><strong>Repeat ${number(run.repetition_index)}</strong><small>${escapeHtml(String(run.id).slice(0, 8))}</small></td>
        <td><span class="status-pill ${escapeHtml(run.status)}">${escapeHtml(statusLabel(run.status))}</span></td>
        <td>${escapeHtml(rate)}<small>${number(run.answered_cases)} answered</small></td>
        <td>${number(run.passed_cases)} / ${number(run.failed_cases)} / ${number(run.error_cases)}</td>
        <td>${escapeHtml(formatLatency(run.average_latency_ms))}</td>
        <td>${escapeHtml(cost)}</td>
        <td>${escapeHtml(models)}${run.fallback_cases ? `<small>Fallback cases: ${number(run.fallback_cases)}</small>` : ''}</td>
        <td><button class="text-link inspect-campaign-run" data-run-id="${escapeHtml(run.id)}">Inspect ↗</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="8" class="empty-cell">No repetitions have been created.</td></tr>';

    const cases = Array.isArray(report.per_case) ? report.per_case : [];
    $('#campaign-cases-body').innerHTML = cases.length ? cases.map((item) => {
      const rate = item.pass_rate_percentage == null ? '—' : `${item.pass_rate_percentage}%`;
      const consistency = item.status_consistency_percentage == null ? 'Not enough answers' : `${item.status_consistency_percentage}%`;
      const pct = item.status_consistency_percentage == null ? 0 : Number(item.status_consistency_percentage);
      const models = Array.isArray(item.actual_models) && item.actual_models.length ? item.actual_models.join(', ') : 'Not observed';
      return `<tr>
        <td><strong class="run-name">${escapeHtml(item.test_case_name)}</strong><small>${escapeHtml(String(item.test_case_id).slice(0, 8))}</small></td>
        <td>${escapeHtml(rate)}<small>${number(item.answered_runs)} answered repeats</small></td>
        <td>${number(item.passed_runs)} / ${number(item.failed_runs)} / ${number(item.error_runs)}</td>
        <td class="consistency-cell"><strong>${escapeHtml(consistency)}</strong>${item.status_consistency_percentage == null ? '' : `<span class="consistency-track"><span style="width:${pct}%;"></span></span>`}<small>${item.stable_across_repeats ? 'Stable pass/fail result' : 'May vary across repetitions'}</small></td>
        <td>${escapeHtml(models)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="empty-cell">Per-case consistency will appear after completed repetitions.</td></tr>';
    if (!quiet) $('#campaign-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (!quiet) showToast(error.message, 'error');
  }
}

async function openRunDetails(runId, { quiet = false } = {}) {
  try {
    const run = await api(`/api/evaluations/${encodeURIComponent(runId)}`);
    state.selectedRun = run;
    state.selectedCampaignId = null;
    state.selectedCampaign = null;
    $('#campaign-detail-panel').hidden = true;
    $('#run-detail-panel').hidden = false;
    $('#detail-title').textContent = `${run.dataset_name} · Run details`;
    $('#cancel-run-button').hidden = !['queued', 'running'].includes(run.status);
    const report = run.model_report ?? buildClientModelReport(run);
    const quality = run.quality_report ?? {};
    const failures = quality.failures ?? {};
    const qualityInterval = quality.model_quality?.confidence_interval_95;
    const qualityIntervalLabel = qualityInterval ? `${qualityInterval.low_percentage}%–${qualityInterval.high_percentage}%` : 'Not enough graded cases';
    const answered = Number(quality.model_quality?.sample_size ?? (Number(run.passed_cases ?? 0) + Number(run.failed_cases ?? 0)));
    const rate = runPassRate(run);
    const stats = [
      ['Status', statusLabel(run.status)],
      ['Pass rate', rate === null ? '—' : `${rate}%`],
      ['Graded sample', `${answered} / ${number(run.total_cases)}`],
      ['95% pass-rate CI', qualityIntervalLabel],
      ['Provider errors', number(failures.provider_errors)],
      ['Evaluator errors', number(failures.evaluator_errors)],
      ['Model failures', number(failures.model_failures)],
      ['Unclassified legacy errors', number(failures.unclassified_legacy_errors)],
      ['Avg. latency', run.average_latency_ms == null ? '—' : `${Math.round(Number(run.average_latency_ms))} ms`],
      ['Token usage', number(Number(run.total_input_tokens ?? 0) + Number(run.total_output_tokens ?? 0))]
    ];
    $('#detail-summary').innerHTML = stats.map(([label, value]) => `<div class="detail-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
    renderModelReport({ ...run, model_report: report });
    const results = run.results ?? [];
    $('#results-table-body').innerHTML = results.length ? results.map((result, index) => {
      const routing = getResultRouting(result, run);
      const modelLabel = routing.actualModel || (result.status === 'error' ? 'No response' : 'Not reported');
      const modelSubline = routing.fallbackUsed
        ? `<small>Requested: ${escapeHtml(routing.requestedModel)}</small><span class="fallback-pill">Fallback</span>`
        : `<small>${routing.actualModel ? 'Actual model' : `Requested: ${escapeHtml(routing.requestedModel)}`}</small>`;
      return `<tr>
        <td><strong class="run-name">${escapeHtml(result.test_case_name)}</strong></td>
        <td><div class="case-model"><strong title="${escapeHtml(modelLabel)}">${escapeHtml(modelLabel)}</strong>${modelSubline}</div></td>
        <td><span class="status-pill ${escapeHtml(result.status)}">${escapeHtml(result.status)}</span></td>
        <td class="rate-cell">${result.score == null ? '—' : `${Math.round(Number(result.score) * 100)}%`}</td>
        <td class="date-cell">${result.latency_ms == null ? '—' : `${number(result.latency_ms)} ms`}</td>
        <td><button class="text-link inspect-result" data-result-index="${index}">Inspect ↗</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-cell">No cases have been processed yet.</td></tr>';
    $('#result-inspection').hidden = true;
    if (!quiet) $('#run-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (!quiet) showToast(error.message, 'error');
  }
}

function inspectResult(index) {
  const result = state.selectedRun?.results?.[index];
  if (!result) return;
  const run = state.selectedRun;
  const graders = Array.isArray(result.graders) ? result.graders : [];
  const actual = result.actual_output ?? (result.error_message ? { error: result.error_message } : null);
  const routing = getResultRouting(result, run);
  const metadata = getResultMetadata(result);
  const actualModel = routing.actualModel || (result.status === 'error' ? 'No model response' : 'Not reported by provider');
  const fallbackLabel = routing.fallbackUsed ? 'Yes' : 'No';
  const costDisplay = caseCostDisplay(result, metadata);
  const inspection = $('#result-inspection');
  inspection.hidden = false;
  inspection.innerHTML = `<div class="inspection-heading"><h3>${escapeHtml(result.test_case_name)}</h3><span class="status-pill ${escapeHtml(result.status)}">${escapeHtml(result.status)}</span></div>
    <div class="inspection-grid">
      <div class="inspection-block routing-inspection-block"><h4>Model routing</h4><div class="routing-details">
        <div><span>Requested model</span><strong>${escapeHtml(routing.requestedModel)}</strong></div>
        <div><span>Actual model</span><strong>${escapeHtml(actualModel)}</strong></div>
        <div><span>Fallback used</span><strong>${escapeHtml(fallbackLabel)}</strong></div>
        <div><span>Latency</span><strong>${escapeHtml(formatLatency(result.latency_ms))}</strong></div>
        <div><span>Input / output tokens</span><strong>${number(result.input_tokens)} / ${number(result.output_tokens)}</strong></div>
        <div><span>Estimated cost</span><strong>${escapeHtml(costDisplay.value)}</strong><small class="cost-explanation">${escapeHtml(costDisplay.explanation)}</small></div>
      </div>${routing.fallbackReason ? `<details class="routing-reason fallback-case"><summary><strong>Fallback used:</strong> ${escapeHtml(routing.requestedModel)} → ${escapeHtml(actualModel)} (expand for attempts and original text)</summary>${renderFallbackAttempts(metadata.fallbackAttempts)}<pre>${escapeHtml(routing.fallbackReason)}</pre></details>` : ''}${result.failure_category || result.error_message ? `<p class="routing-reason error-reason"><strong>Failure classification:</strong> ${escapeHtml(result.failure_category ?? 'unclassified legacy error')}${result.error_stage ? ` · ${escapeHtml(result.error_stage)}` : ''}${result.error_message ? ` — ${escapeHtml(result.error_message)}` : ''}</p>` : ''}</div>
      <div class="inspection-block"><h4>Test input</h4><pre>${escapeHtml(pretty(result.test_input))}</pre></div>
      <div class="inspection-block"><h4>Model output</h4><pre>${escapeHtml(pretty(actual))}</pre></div>
      <div class="inspection-block"><h4>Grader results (${graders.length})</h4><div class="grader-list">${graders.length ? graders.map((grader) => `<div class="grader-item"><span class="grader-mark ${grader.passed ? '' : 'fail'}">${grader.passed ? '✓' : '×'}</span><div><strong>${escapeHtml(grader.name)} · ${Math.round(Number(grader.score ?? 0) * 100)}%</strong><small>${escapeHtml(grader.details)}</small></div></div>`).join('') : `<div class="grader-item"><span class="grader-mark fail">!</span><div><strong>No grader output</strong><small>${escapeHtml(result.error_message ?? 'This case may still be pending or failed before grading.')}</small></div></div>`}</div></div>
      <div class="inspection-block"><h4>Provider metadata</h4><pre>${escapeHtml(pretty(metadata))}</pre></div>
      <div class="inspection-block"><h4>Execution trace</h4><pre>${escapeHtml(pretty(result.trace ?? []))}</pre></div>
    </div>`;
  inspection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetDatasetEditor({ clearJson = false } = {}) {
  state.editingDatasetId = null;
  state.editingDatasetVersion = null;
  $('#import-dataset-title').textContent = 'Import a dataset';
  $('#dataset-form-description').textContent = 'Create a versioned dataset by pasting test cases. Use the example to see supported grading rules.';
  $('#import-submit').textContent = '＋ Create dataset';
  $('#cancel-dataset-edit-button').hidden = true;
  if (clearJson) $('#dataset-json').value = '';
}

async function editDataset(datasetId) {
  try {
    const dataset = await api(`/api/datasets/${encodeURIComponent(datasetId)}`);
    // The editor accepts the dataset schema, not database-only fields such as
    // test case IDs and timestamps. Existing versions remain immutable.
    const testCases = (dataset.test_cases ?? []).map(({ id, created_at, position_index, ...testCase }) => testCase);
    const editable = {
      name: dataset.name,
      description: dataset.description ?? '',
      test_cases: testCases
    };
    state.editingDatasetId = dataset.id;
    state.editingDatasetVersion = Number(dataset.latest_version ?? 1);
    $('#dataset-json').value = JSON.stringify(editable, null, 2);
    $('#import-dataset-title').textContent = `Edit dataset · v${state.editingDatasetVersion}`;
    $('#dataset-form-description').textContent = `Editing ${dataset.name}. Saving creates version ${state.editingDatasetVersion + 1}; prior versions and their evaluation history are preserved.`;
    $('#import-submit').textContent = `Save as version ${state.editingDatasetVersion + 1}`;
    $('#cancel-dataset-edit-button').hidden = false;
    setMessage('#import-form-message', `Loaded ${dataset.name} v${state.editingDatasetVersion} for editing.`);
    $('#import-dataset').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#dataset-json').focus({ preventScroll: true });
  } catch (error) {
    showToast(`Could not load dataset: ${error.message}`, 'error');
  }
}

function loadExampleJson() {
  resetDatasetEditor();
  const example = {
    name: 'My AI agent tests',
    description: 'Smoke tests for a customer-support agent.',
    test_cases: [{
      name: 'Mentions the refund window',
      input: { message: 'What is the refund deadline?', mock_response: { content: 'Eligible items can be returned within 30 days.' } },
      required_keywords: ['30 days'],
      forbidden_keywords: ['guaranteed'],
      grading_rules: { exactMatch: false }
    }]
  };
  $('#dataset-json').value = JSON.stringify(example, null, 2);
}

$('#run-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#run-submit');
  submit.disabled = true;
  setMessage('#run-form-message', 'Queueing evaluation…');
  try {
    const payload = {
      dataset_id: $('#dataset-select').value,
      provider: $('#provider-select').value,
      model: $('#model-input').value.trim() || undefined,
      system_prompt: $('#system-prompt').value
    };
    const repeatCount = Number($('#repeat-count').value || 1);
    if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 10) {
      throw new Error('Repeated runs must be an integer between 1 and 10.');
    }
    if (repeatCount === 1) {
      const run = await api('/api/evaluations', { method: 'POST', body: JSON.stringify(payload) });
      setMessage('#run-form-message', `Evaluation queued: ${run.id}`, 'success');
      showToast('Evaluation run queued successfully.');
      await refreshAll({ quiet: true, resetRuns: true });
      await openRunDetails(run.id);
    } else {
      const campaign = await api('/api/evaluation-campaigns', {
        method: 'POST', body: JSON.stringify({ ...payload, repeat_count: repeatCount })
      });
      setMessage('#run-form-message', `Reliability campaign queued: ${campaign.id} (${repeatCount} repeats)`, 'success');
      showToast(`Reliability campaign queued with ${repeatCount} repetitions.`);
      await refreshAll({ quiet: true, resetRuns: true });
      await openCampaignDetails(campaign.id);
    }
  } catch (error) {
    setMessage('#run-form-message', error.message, 'error');
    showToast(error.message, 'error');
  } finally {
    submit.disabled = false;
  }
});

$('#dataset-select').addEventListener('change', (event) => { state.selectedDatasetId = event.target.value; });

$('#provider-select').addEventListener('change', (event) => {
  const provider = event.target.value;
  const defaults = { mock: 'mock-v1', gemini: 'gemini-3.8-flash', openai: 'gpt-4o-mini' };
  const knownDefaultModels = Object.values(defaults);
  const modelInput = $('#model-input');
  if (!modelInput.value.trim() || knownDefaultModels.includes(modelInput.value.trim())) {
    modelInput.value = defaults[provider];
  }
  modelInput.placeholder = defaults[provider];

  const notes = {
    mock: '<span class="note-icon">ⓘ</span><span>Mock mode uses saved fixtures for a repeatable run. No API key is required.</span>',
    gemini: '<span class="note-icon">ⓘ</span><span>Live evaluations call Google Gemini. Add <code>GEMINI_API_KEY</code> to <code>.env</code>. On HTTP 429/quota errors, EvalForge automatically tries the ordered models in <code>GEMINI_FALLBACK_MODELS</code>. Inspect each result to see which model actually responded.</span>',
    openai: '<span class="note-icon">ⓘ</span><span>Live evaluations call the configured OpenAI model and may incur API charges. Configure <code>OPENAI_API_KEY</code> in <code>.env</code> and restart the services.</span>'
  };
  $('#provider-note').innerHTML = notes[provider];
});

$('#import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#import-submit');
  button.disabled = true;
  setMessage('#import-form-message', state.editingDatasetId ? 'Validating changes and saving a new dataset version…' : 'Validating and saving dataset…');
  try {
    let body;
    try { body = JSON.parse($('#dataset-json').value); }
    catch { throw new Error('Dataset JSON is not valid. Check commas, quotation marks, and brackets.'); }
    const wasEditing = Boolean(state.editingDatasetId);
    const endpoint = wasEditing ? `/api/datasets/${encodeURIComponent(state.editingDatasetId)}` : '/api/datasets';
    const dataset = await api(endpoint, { method: wasEditing ? 'PUT' : 'POST', body: JSON.stringify(body) });
    if (wasEditing) {
      setMessage('#import-form-message', `Saved ${dataset.name} as version ${dataset.latest_version} with ${dataset.test_cases.length} test cases. Previous versions and existing evaluation history were preserved.`, 'success');
      showToast(`Saved ${dataset.name} v${dataset.latest_version}.`);
      resetDatasetEditor();
    } else {
      setMessage('#import-form-message', `Created ${dataset.name} with ${dataset.test_cases.length} test cases.`, 'success');
      showToast('Dataset created successfully.');
    }
    state.selectedDatasetId = dataset.id;
    await refreshAll({ quiet: true });
    $('#dataset-select').value = dataset.id;
    $('#datasets').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setMessage('#import-form-message', error.message, 'error');
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#cancel-dataset-edit-button').addEventListener('click', () => {
  resetDatasetEditor({ clearJson: true });
  setMessage('#import-form-message', 'Dataset edit cancelled. No new version was saved.');
});

$('#load-example-button').addEventListener('click', loadExampleJson);
$('#refresh-button').addEventListener('click', () => refreshAll({ resetRuns: true }));
$('#runs-refresh').addEventListener('click', () => refreshAll({ resetRuns: true }));
$('#new-run-button').addEventListener('click', () => $('#create-run-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }));
$('#scroll-datasets').addEventListener('click', () => $('#datasets').scrollIntoView({ behavior: 'smooth', block: 'start' }));
$('#close-detail-button').addEventListener('click', () => { $('#run-detail-panel').hidden = true; state.selectedRun = null; });
$('#close-campaign-button').addEventListener('click', () => {
  $('#campaign-detail-panel').hidden = true;
  state.selectedCampaign = null;
  state.selectedCampaignId = null;
});

$('#runs-table-body').addEventListener('click', async (event) => {
  const campaignButton = event.target.closest('.inspect-campaign');
  if (campaignButton) { await openCampaignDetails(campaignButton.dataset.campaignId); return; }
  const button = event.target.closest('.inspect-run');
  if (button) await openRunDetails(button.dataset.runId);
});

$('#campaign-runs-body').addEventListener('click', async (event) => {
  const button = event.target.closest('.inspect-campaign-run');
  if (button) await openRunDetails(button.dataset.runId);
});

$('#cancel-campaign-button').addEventListener('click', async () => {
  if (!state.selectedCampaignId) return;
  const button = $('#cancel-campaign-button');
  button.disabled = true;
  try {
    await api(`/api/evaluation-campaigns/${encodeURIComponent(state.selectedCampaignId)}/cancel`, { method: 'POST', body: '{}' });
    showToast('Campaign cancellation requested. The active model request may finish before stopping.');
    await openCampaignDetails(state.selectedCampaignId, { quiet: true });
    await refreshAll({ quiet: true });
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; }
});
$('#runs-table-body').addEventListener('change', (event) => {
  const checkbox = event.target.closest('.compare-checkbox');
  if (!checkbox) return;
  const id = checkbox.dataset.compareId;
  if (checkbox.checked) {
    if (state.selectedCompareRuns.length >= 2) {
      checkbox.checked = false;
      showToast('Select no more than two runs to compare.', 'error');
      return;
    }
    state.selectedCompareRuns.push(id);
  } else {
    state.selectedCompareRuns = state.selectedCompareRuns.filter((value) => value !== id);
  }
  renderCompareBar();
});

$('#results-table-body').addEventListener('click', (event) => {
  const button = event.target.closest('.inspect-result');
  if (button) inspectResult(Number(button.dataset.resultIndex));
});
$('#dataset-grid').addEventListener('click', async (event) => {
  const calibrateButton = event.target.closest('.dataset-calibrate');
  if (calibrateButton) {
    const datasetId = calibrateButton.dataset.calibrateDatasetId;
    const resultBox = $(`[data-calibration-dataset-id="${CSS.escape(datasetId)}"]`);
    calibrateButton.disabled = true;
    try {
      const report = await api(`/api/datasets/${encodeURIComponent(datasetId)}/calibration`);
      const summary = report.summary ?? {};
      const matrix = report.confusion_matrix ?? {};
      const failures = (report.examples ?? []).filter((item) => ['false_positive', 'false_negative', 'evaluator_error'].includes(item.outcome));
      resultBox.hidden = false;
      const accuracy = summary.accuracy == null ? 'Not calibrated' : `${(Number(summary.accuracy) * 100).toFixed(1)}%`;
      const pct = (value) => (value == null ? 'undefined (no cases in denominator)' : `${(Number(value) * 100).toFixed(1)}%`);
      const detailMetrics = report.status === 'no_calibration_data' ? '' : `<div class="dataset-meta"><span>Precision: ${escapeHtml(pct(summary.precision))}</span><span>Recall: ${escapeHtml(pct(summary.recall))}</span><span>Specificity: ${escapeHtml(pct(summary.specificity))}</span><span>F1: ${escapeHtml(pct(summary.f1_score))}</span></div><div class="dataset-meta"><span>TP ${number(matrix.true_positive)} · TN ${number(matrix.true_negative)} · FP ${number(matrix.false_positive)} · FN ${number(matrix.false_negative)}</span></div>`;
      resultBox.innerHTML = `<div class="dataset-meta"><strong>Calibration · ${escapeHtml(report.dataset?.name ?? 'Dataset')} v${escapeHtml(report.dataset?.version_number ?? '—')}</strong><span>${number(summary.evaluated_examples)} / ${number(summary.golden_examples)} evaluated</span></div><div class="dataset-meta"><span>Accuracy: ${escapeHtml(accuracy)}</span><span>FP: ${number(matrix.false_positive)} · FN: ${number(matrix.false_negative)} · Evaluator errors: ${number(matrix.evaluator_error)}</span></div>${detailMetrics}<p class="dataset-description">${escapeHtml(summary.interpretation ?? '')}</p>${failures.length ? `<div class="grader-list">${failures.map((item) => `<div class="grader-item"><span class="grader-mark fail">!</span><div><strong>${escapeHtml(item.outcome)} · ${escapeHtml(item.test_case_name)}</strong><small>${escapeHtml(item.error ?? item.rationale ?? 'Compare actual grader output with the gold label.')}</small></div></div>`).join('')}</div>` : ''}`;
      calibrateButton.textContent = 'Refresh calibration';
    } catch (error) { showToast(error.message, 'error'); }
    finally { calibrateButton.disabled = false; }
    return;
  }
  const editButton = event.target.closest('.dataset-edit');
  if (editButton) {
    await editDataset(editButton.dataset.editDatasetId);
    return;
  }
  const button = event.target.closest('.dataset-run');
  if (!button) return;
  state.selectedDatasetId = button.dataset.datasetId;
  $('#dataset-select').value = state.selectedDatasetId;
  $('#create-run-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#provider-select').focus({ preventScroll: true });
});

$('#cancel-run-button').addEventListener('click', async () => {
  if (!state.selectedRun) return;
  try {
    await api(`/api/evaluations/${encodeURIComponent(state.selectedRun.id)}/cancel`, { method: 'POST', body: '{}' });
    showToast('Cancellation requested. The worker will stop between test cases.');
    await refreshAll({ quiet: true });
  } catch (error) { showToast(error.message, 'error'); }
});

$('#compare-button').addEventListener('click', async () => {
  if (state.selectedCompareRuns.length !== 2) return;
  const button = $('#compare-button');
  button.disabled = true;
  try {
    const result = await api('/api/evaluations/compare', {
      method: 'POST', body: JSON.stringify({ baseline_run_id: state.selectedCompareRuns[0], candidate_run_id: state.selectedCompareRuns[1] })
    });
    const delta = result.pass_rate_delta_percentage_points == null ? null : Number(result.pass_rate_delta_percentage_points);
    const deltaText = delta === null ? 'Unavailable — no completed pass/fail outcomes' : `${delta > 0 ? '+' : ''}${delta.toFixed(2)} percentage points`;
    const deltaColor = delta === null ? 'var(--muted)' : delta > 0 ? 'var(--green)' : delta < 0 ? 'var(--red)' : 'var(--muted)';
    const cases = result.cases.filter((item) => item.changed || item.baseline_status === 'not_present' || item.candidate_status === 'not_present');
    const describeModels = (runSummary) => {
      const report = runSummary.model_report;
      if (!report) return `Requested: ${escapeHtml(runSummary.model)}`;
      const actual = Array.isArray(report.actual_models) && report.actual_models.length ? report.actual_models.join(', ') : 'no model response recorded';
      const fallbackText = Number(report.fallback_cases ?? 0) ? ` · fallback ${number(report.fallback_cases)}/${number(report.cases_with_model_response)}` : '';
      const mixed = report.mixed_model_run ? ' · mixed-model run' : '';
      const interval = runSummary.pass_rate_confidence_interval_95;
      const intervalText = interval ? ` · 95% CI ${interval.low_percentage}%–${interval.high_percentage}% (n=${number(runSummary.pass_rate_sample_size)})` : ' · CI unavailable';
      const rate = runSummary.pass_rate == null ? 'Not available' : `${runSummary.pass_rate}% pass rate`;
      return `Requested: ${escapeHtml(runSummary.model)} · actual: ${escapeHtml(actual)} · ${escapeHtml(rate)}${escapeHtml(intervalText)}${escapeHtml(fallbackText)}${escapeHtml(mixed)}`;
    };
    const paired = result.paired_analysis ?? {};
    const pairedCi = paired.confidence_interval_95;
    const pairedCiText = pairedCi ? `${pairedCi.low_percentage_points} to ${pairedCi.high_percentage_points} pp` : 'unavailable (requires at least two matched graded cases)';
    $('#compare-result').hidden = false;
    $('#compare-result').innerHTML = `<div><strong>Baseline:</strong> ${escapeHtml(result.baseline.provider)} · ${describeModels(result.baseline)}</div><div><strong>Candidate:</strong> ${escapeHtml(result.candidate.provider)} · ${describeModels(result.candidate)}</div><div><strong>Overall pass-rate change:</strong> <span style="color:${deltaColor}">${escapeHtml(deltaText)}</span></div><div><strong>Paired analysis:</strong> ${number(paired.matched_graded_cases)} matched graded cases · ${number(paired.improvements)} improvements · ${number(paired.regressions)} regressions · conservative 95% interval for paired pass-rate change (n=${number(paired.matched_graded_cases)}): ${escapeHtml(pairedCiText)}</div>${paired.excluded_breakdown ? `<div><small>Excluded from paired estimate: ${number(paired.excluded_breakdown.only_in_baseline)} only in baseline · ${number(paired.excluded_breakdown.only_in_candidate)} only in candidate · ${number(paired.excluded_breakdown.in_both_but_not_graded_in_both)} pending/errored in at least one run.</small></div>` : ''}${result.data_quality?.comparability_warning ? `<div class="routing-reason error-reason"><strong>Comparability warning:</strong> ${escapeHtml(result.data_quality.comparability_warning)}</div>` : ''}<div><small>${escapeHtml(paired.assumptions ?? 'Errors and unmatched cases are excluded from the paired estimate.')}</small></div><div><strong>Failure classes (baseline → candidate):</strong> provider ${number(result.baseline.quality_report?.failures?.provider_errors)} → ${number(result.candidate.quality_report?.failures?.provider_errors)}, evaluator ${number(result.baseline.quality_report?.failures?.evaluator_errors)} → ${number(result.candidate.quality_report?.failures?.evaluator_errors)}, model ${number(result.baseline.quality_report?.failures?.model_failures)} → ${number(result.candidate.quality_report?.failures?.model_failures)}</div><div><strong>Regressions:</strong> ${result.regressions} &nbsp; <strong>Improvements:</strong> ${result.improvements}</div>${cases.length ? `<div><strong>Changed or unmatched cases:</strong> ${cases.map((item) => escapeHtml(item.test_case_name)).join(', ')}</div>` : '<div>No test-case status changes or unmatched cases.</div>'}`;
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; }
});

$('#view-all-runs').addEventListener('click', (event) => {
  event.preventDefault();
  $('#runs-table-body').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

let accountRegistrationEnabled = false;
let accountRegisterMode = false;
function setAccountMode(register) {
  accountRegisterMode = register;
  $('#account-title').textContent = register ? 'Create your workspace account' : 'Sign in to your workspace';
  $('#account-submit').textContent = register ? 'Create account' : 'Sign in';
  $('#account-password').autocomplete = register ? 'new-password' : 'current-password';
  $('#account-bootstrap-wrap').hidden = !(register && $('#account-bootstrap-wrap').dataset.required === 'true');
  $('#account-error').textContent = '';
}
async function initializeAccount() {
  try {
    const info = await api('/api/auth/me');
    accountRegistrationEnabled = info.registration_enabled;
    if (info.user) {
      $('.app-shell').hidden = false;
      $('#account-gate').hidden = true;
      $('#account-email-label').textContent = info.user.email;
      await refreshAll();
      return;
    }
    $('.app-shell').hidden = true;
    $('#account-gate').hidden = false;
    $('#account-bootstrap-wrap').dataset.required = String(info.bootstrap_required);
    $('#account-bootstrap-wrap').hidden = true;
    $('#account-mode').hidden = !info.registration_enabled;
    setAccountMode(false);
    if (!info.registration_enabled) $('#account-description').textContent = 'Registration is disabled. Sign in with an account created by the instance administrator.';
  } catch (error) {
    $('#account-gate').hidden = false;
    $('#account-error').textContent = error.message;
  }
}
$('#account-mode').addEventListener('click', () => {
  setAccountMode(!accountRegisterMode);
  $('#account-bootstrap-wrap').hidden = !(accountRegisterMode && $('#account-bootstrap-wrap').dataset.required === 'true');
});
$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#account-submit');
  submit.disabled = true;
  $('#account-error').textContent = '';
  try {
    const payload = { email: $('#account-email').value, password: $('#account-password').value };
    if (accountRegisterMode && $('#account-bootstrap-wrap').dataset.required === 'true') payload.bootstrap_secret = $('#account-bootstrap').value;
    await api(`/api/auth/${accountRegisterMode ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(payload) });
    await initializeAccount();
  } catch (error) { $('#account-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#signout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); }
  finally { window.location.reload(); }
});
initializeAccount();
window.setInterval(async () => {
  const hasActiveRun = state.runs.some((run) => ['queued', 'running'].includes(run.status))
    || ['queued', 'running'].includes(state.selectedCampaign?.status);
  if (hasActiveRun) await refreshAll({ quiet: true });
}, 3500);
