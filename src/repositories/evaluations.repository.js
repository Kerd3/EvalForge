import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { buildModelReport } from '../services/model-reporting.service.js';
import { buildReliabilityReport } from '../services/reliability-analysis.service.js';

export async function createEvaluationRun({ datasetId, datasetVersionId, provider, model, systemPrompt }) {
  const client = await pool.connect();
  const runId = randomUUID();
  try {
    await client.query('BEGIN');
    let versionId = datasetVersionId;
    if (datasetId) {
      const versionResult = await client.query(
        'SELECT id FROM dataset_versions WHERE dataset_id = $1 ORDER BY version_number DESC LIMIT 1', [datasetId]
      );
      versionId = versionResult.rows[0]?.id;
      if (!versionId) {
        const error = new Error('Dataset was not found or has no versions');
        error.statusCode = 404;
        throw error;
      }
    } else {
      const versionResult = await client.query('SELECT id FROM dataset_versions WHERE id = $1', [versionId]);
      if (!versionResult.rows[0]) {
        const error = new Error('Dataset version not found');
        error.statusCode = 404;
        throw error;
      }
    }
    const casesResult = await client.query(
      'SELECT id FROM test_cases WHERE dataset_version_id = $1 ORDER BY position_index ASC, created_at, name', [versionId]
    );
    if (casesResult.rowCount === 0) {
      const error = new Error('Dataset version contains no test cases');
      error.statusCode = 400;
      throw error;
    }
    await client.query(
      `INSERT INTO evaluation_runs
       (id, dataset_version_id, provider, model, system_prompt, status, total_cases)
       VALUES ($1,$2,$3,$4,$5,'queued',$6)`,
      [runId, versionId, provider, model, systemPrompt, casesResult.rowCount]
    );
    for (const row of casesResult.rows) {
      await client.query(
        `INSERT INTO evaluation_results(id, run_id, test_case_id, status)
         VALUES ($1,$2,$3,'pending') ON CONFLICT (run_id, test_case_id) DO NOTHING`,
        [randomUUID(), runId, row.id]
      );
    }
    await client.query(
      'INSERT INTO audit_events(id, run_id, event_type, details) VALUES ($1,$2,$3,$4)',
      [randomUUID(), runId, 'evaluation.queued', JSON.stringify({ provider, model, totalCases: casesResult.rowCount })]
    );
    await client.query('COMMIT');
    return getEvaluationById(runId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createEvaluationCampaign({ datasetId, datasetVersionId, provider, model, systemPrompt, repeatCount }) {
  const client = await pool.connect();
  const campaignId = randomUUID();
  try {
    await client.query('BEGIN');
    let versionId = datasetVersionId;
    if (datasetId) {
      const versionResult = await client.query(
        'SELECT id FROM dataset_versions WHERE dataset_id = $1 ORDER BY version_number DESC LIMIT 1', [datasetId]
      );
      versionId = versionResult.rows[0]?.id;
      if (!versionId) {
        const error = new Error('Dataset was not found or has no versions');
        error.statusCode = 404;
        throw error;
      }
    } else {
      const versionResult = await client.query('SELECT id FROM dataset_versions WHERE id = $1', [versionId]);
      if (!versionResult.rows[0]) {
        const error = new Error('Dataset version not found');
        error.statusCode = 404;
        throw error;
      }
    }

    const casesResult = await client.query(
      'SELECT id FROM test_cases WHERE dataset_version_id = $1 ORDER BY position_index ASC, created_at, name', [versionId]
    );
    if (casesResult.rowCount === 0) {
      const error = new Error('Dataset version contains no test cases');
      error.statusCode = 400;
      throw error;
    }

    await client.query(
      `INSERT INTO evaluation_campaigns
       (id, dataset_version_id, provider, model, system_prompt, repeat_count, status)
       VALUES ($1,$2,$3,$4,$5,$6,'queued')`,
      [campaignId, versionId, provider, model, systemPrompt, repeatCount]
    );

    for (let repetitionIndex = 1; repetitionIndex <= repeatCount; repetitionIndex += 1) {
      const runId = randomUUID();
      await client.query(
        `INSERT INTO evaluation_runs
         (id, dataset_version_id, provider, model, system_prompt, status, total_cases, campaign_id, repetition_index)
         VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8)`,
        [runId, versionId, provider, model, systemPrompt, casesResult.rowCount, campaignId, repetitionIndex]
      );
      for (const row of casesResult.rows) {
        await client.query(
          `INSERT INTO evaluation_results(id, run_id, test_case_id, status)
           VALUES ($1,$2,$3,'pending') ON CONFLICT (run_id, test_case_id) DO NOTHING`,
          [randomUUID(), runId, row.id]
        );
      }
      await client.query(
        'INSERT INTO audit_events(id, run_id, event_type, details) VALUES ($1,$2,$3,$4)',
        [randomUUID(), runId, 'evaluation.queued', JSON.stringify({ provider, model, totalCases: casesResult.rowCount, campaignId, repetitionIndex })]
      );
    }

    await client.query('COMMIT');
    return getEvaluationCampaignById(campaignId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getEvaluationCampaignState(campaignId) {
  const { rows } = await pool.query('SELECT * FROM evaluation_campaigns WHERE id = $1', [campaignId]);
  return rows[0] ?? null;
}

export async function getEvaluationCampaignRunIds(campaignId) {
  const { rows } = await pool.query(
    'SELECT id FROM evaluation_runs WHERE campaign_id = $1 ORDER BY repetition_index ASC', [campaignId]
  );
  return rows.map((row) => row.id);
}

export async function updateEvaluationCampaignStatus(campaignId, status, errorMessage = null) {
  const times = status === 'running'
    ? ', started_at = COALESCE(started_at, NOW())'
    : ['completed', 'failed', 'cancelled'].includes(status) ? ', completed_at = NOW()' : '';
  // Keep terminal states terminal if a duplicate/retried queue job races with
  // cancellation or completion. Idempotent updates to the same state are safe.
  await pool.query(
    `UPDATE evaluation_campaigns SET status = $2, error_message = $3 ${times}
     WHERE id = $1 AND (status = $2 OR (status IN ('queued','running') AND $2 IN ('running','completed','failed','cancelled')))`,
    [campaignId, status, errorMessage]
  );
}

export async function failEvaluationCampaign(campaignId, message) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE evaluation_campaigns SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1 AND status IN ('queued','running')`,
      [campaignId, message]
    );
    const runs = await client.query(
      `UPDATE evaluation_runs SET status='failed', error_message=$2, completed_at=NOW()
       WHERE campaign_id=$1 AND status IN ('queued','running') RETURNING id`, [campaignId, message]
    );
    for (const run of runs.rows) {
      await client.query(
        'INSERT INTO audit_events(id, run_id, event_type, details) VALUES ($1,$2,$3,$4)',
        [randomUUID(), run.id, 'evaluation.failed', JSON.stringify({ message, campaignId })]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelEvaluationCampaign(campaignId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE evaluation_campaigns SET status='cancelled', completed_at=NOW()
       WHERE id=$1 AND status IN ('queued','running')`, [campaignId]
    );
    const runs = await client.query(
      `UPDATE evaluation_runs SET status='cancelled', completed_at=NOW()
       WHERE campaign_id=$1 AND status IN ('queued','running') RETURNING id`, [campaignId]
    );
    for (const run of runs.rows) {
      await client.query(
        'INSERT INTO audit_events(id, run_id, event_type, details) VALUES ($1,$2,$3,$4)',
        [randomUUID(), run.id, 'evaluation.cancelled', JSON.stringify({ campaignId })]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getEvaluationCampaignById(campaignId) {
  const { rows: campaignRows } = await pool.query(
    `SELECT c.*, v.version_number, d.id AS dataset_id, d.name AS dataset_name
     FROM evaluation_campaigns c
     JOIN dataset_versions v ON v.id = c.dataset_version_id
     JOIN datasets d ON d.id = v.dataset_id
     WHERE c.id = $1`, [campaignId]
  );
  const campaign = campaignRows[0];
  if (!campaign) return null;

  const { rows: runs } = await pool.query(
    `SELECT r.*, c.repeat_count AS campaign_repeat_count, v.version_number, d.id AS dataset_id, d.name AS dataset_name,
       model_summary.actual_model_names, model_summary.fallback_cases,
       model_summary.model_response_cases, model_summary.provider_error_cases
     FROM evaluation_runs r
     JOIN dataset_versions v ON v.id = r.dataset_version_id
     JOIN datasets d ON d.id = v.dataset_id
     LEFT JOIN evaluation_campaigns c ON c.id = r.campaign_id
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(array_agg(DISTINCT model_name ORDER BY model_name) FILTER (WHERE model_name IS NOT NULL), ARRAY[]::TEXT[]) AS actual_model_names,
         COUNT(*) FILTER (WHERE model_name IS NOT NULL)::int AS model_response_cases,
         COUNT(*) FILTER (WHERE fallback_used)::int AS fallback_cases,
         COUNT(*) FILTER (WHERE status = 'error' AND model_name IS NULL)::int AS provider_error_cases
       FROM (
         SELECT er.status,
           CASE WHEN r.provider = 'mock' AND er.actual_output IS NOT NULL THEN r.model
             ELSE COALESCE(er.actual_output #>> '{providerMetadata,actualModel}', er.actual_output #>> '{providerMetadata,modelVersion}', er.actual_output #>> '{providerMetadata,model}')
           END AS model_name,
           (er.actual_output #>> '{providerMetadata,fallbackUsed}') = 'true' AS fallback_used
         FROM evaluation_results er WHERE er.run_id = r.id
       ) detected_models
     ) model_summary ON TRUE
     WHERE r.campaign_id = $1 ORDER BY r.repetition_index ASC`, [campaignId]
  );
  const { rows: results } = await pool.query(
    `SELECT er.run_id, r.repetition_index, r.provider, r.model, r.status AS run_status,
            er.test_case_id, tc.name AS test_case_name, er.status, er.actual_output,
            er.latency_ms, er.estimated_cost_usd
     FROM evaluation_results er
     JOIN evaluation_runs r ON r.id = er.run_id
     JOIN test_cases tc ON tc.id = er.test_case_id
     WHERE r.campaign_id = $1 ORDER BY r.repetition_index, tc.created_at, tc.name`, [campaignId]
  );
  return { ...campaign, runs, reliability: buildReliabilityReport({ campaign, runs, results }) };
}

export async function listEvaluations(limit = 50) {
  const { rows } = await pool.query(
    `SELECT r.*, c.repeat_count AS campaign_repeat_count, v.version_number, d.id AS dataset_id, d.name AS dataset_name,
       model_summary.actual_model_names,
       model_summary.model_response_cases,
       model_summary.fallback_cases,
       model_summary.provider_error_cases
     FROM evaluation_runs r
     JOIN dataset_versions v ON v.id = r.dataset_version_id
     JOIN datasets d ON d.id = v.dataset_id
     LEFT JOIN evaluation_campaigns c ON c.id = r.campaign_id
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(array_agg(DISTINCT model_name ORDER BY model_name) FILTER (WHERE model_name IS NOT NULL), ARRAY[]::TEXT[]) AS actual_model_names,
         COUNT(*) FILTER (WHERE model_name IS NOT NULL)::int AS model_response_cases,
         COUNT(*) FILTER (WHERE fallback_used)::int AS fallback_cases,
         COUNT(*) FILTER (WHERE status = 'error' AND model_name IS NULL)::int AS provider_error_cases
       FROM (
         SELECT er.status,
           CASE
             WHEN r.provider = 'mock' AND er.actual_output IS NOT NULL THEN r.model
             ELSE COALESCE(
               er.actual_output #>> '{providerMetadata,actualModel}',
               er.actual_output #>> '{providerMetadata,modelVersion}',
               er.actual_output #>> '{providerMetadata,model}'
             )
           END AS model_name,
           (er.actual_output #>> '{providerMetadata,fallbackUsed}') = 'true' AS fallback_used
         FROM evaluation_results er WHERE er.run_id = r.id
       ) detected_models
     ) model_summary ON TRUE
     ORDER BY r.created_at DESC LIMIT $1`, [limit]
  );
  return rows;
}

export async function getEvaluationById(runId) {
  const { rows } = await pool.query(
    `SELECT r.*, c.repeat_count AS campaign_repeat_count, v.version_number, d.id AS dataset_id, d.name AS dataset_name
     FROM evaluation_runs r
     JOIN dataset_versions v ON v.id = r.dataset_version_id
     JOIN datasets d ON d.id = v.dataset_id
     LEFT JOIN evaluation_campaigns c ON c.id = r.campaign_id
     WHERE r.id = $1`, [runId]
  );
  return rows[0] ?? null;
}

export async function getEvaluationWithResults(runId) {
  const run = await getEvaluationById(runId);
  if (!run) return null;
  const { rows } = await pool.query(
    `SELECT er.*, tc.name AS test_case_name, tc.input AS test_input,
            tc.expected_output, tc.required_keywords, tc.forbidden_keywords,
            tc.required_tools, tc.forbidden_tools
     FROM evaluation_results er
     JOIN test_cases tc ON tc.id = er.test_case_id
     WHERE er.run_id = $1 ORDER BY tc.created_at, tc.name`, [runId]
  );
  const { rows: events } = await pool.query(
    'SELECT event_type, details, created_at FROM audit_events WHERE run_id = $1 ORDER BY created_at', [runId]
  );
  return {
    ...run,
    results: rows,
    audit_events: events,
    model_report: buildModelReport(run, rows)
  };
}

export async function getEvaluationContext(runId) {
  const run = await getEvaluationById(runId);
  if (!run) return null;
  const { rows: cases } = await pool.query(
    `SELECT tc.* FROM test_cases tc
     JOIN evaluation_runs r ON r.dataset_version_id = tc.dataset_version_id
     WHERE r.id = $1 ORDER BY tc.created_at, tc.name`, [runId]
  );
  return { run, cases };
}

export async function getResult(runId, testCaseId) {
  const { rows } = await pool.query(
    'SELECT * FROM evaluation_results WHERE run_id = $1 AND test_case_id = $2', [runId, testCaseId]
  );
  return rows[0] ?? null;
}

export async function markResultStarted(runId, testCaseId) {
  await pool.query(
    `UPDATE evaluation_results SET started_at = NOW()
     WHERE run_id = $1 AND test_case_id = $2 AND status = 'pending'`, [runId, testCaseId]
  );
}

export async function saveEvaluationResult({ runId, testCaseId, status, actualOutput, toolCalls, graders, score, latencyMs, inputTokens, outputTokens, estimatedCostUsd, errorMessage, trace }) {
  await pool.query(
    `UPDATE evaluation_results SET status=$3, actual_output=$4, tool_calls=$5, graders=$6,
       score=$7, latency_ms=$8, input_tokens=$9, output_tokens=$10, estimated_cost_usd=$11,
       error_message=$12, trace=$13, completed_at=NOW()
     WHERE run_id=$1 AND test_case_id=$2`,
    [runId, testCaseId, status,
      actualOutput === undefined || actualOutput === null ? null : JSON.stringify(actualOutput),
      JSON.stringify(toolCalls ?? []), JSON.stringify(graders ?? []), score ?? null, latencyMs ?? null,
      inputTokens ?? null, outputTokens ?? null, estimatedCostUsd ?? null, errorMessage ?? null,
      JSON.stringify(trace ?? [])]
  );
  await refreshRunSummary(runId);
}

export async function refreshRunSummary(runId) {
  await pool.query(
    `UPDATE evaluation_runs r SET
       completed_cases = counts.completed_cases,
       passed_cases = counts.passed_cases,
       failed_cases = counts.failed_cases,
       error_cases = counts.error_cases,
       average_latency_ms = counts.average_latency_ms,
       total_input_tokens = counts.total_input_tokens,
       total_output_tokens = counts.total_output_tokens,
       estimated_cost_usd = counts.estimated_cost_usd
     FROM (
       SELECT run_id,
         COUNT(*) FILTER (WHERE status IN ('passed','failed','error'))::int AS completed_cases,
         COUNT(*) FILTER (WHERE status = 'passed')::int AS passed_cases,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_cases,
         COUNT(*) FILTER (WHERE status = 'error')::int AS error_cases,
         AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL) AS average_latency_ms,
         COALESCE(SUM(input_tokens),0)::bigint AS total_input_tokens,
         COALESCE(SUM(output_tokens),0)::bigint AS total_output_tokens,
         CASE
           WHEN COUNT(*) FILTER (WHERE status IN ('passed','failed') AND estimated_cost_usd IS NULL) > 0 THEN NULL
           WHEN COUNT(*) FILTER (WHERE status IN ('passed','failed')) = 0 THEN NULL
           ELSE SUM(estimated_cost_usd) FILTER (WHERE status IN ('passed','failed'))
         END AS estimated_cost_usd
       FROM evaluation_results WHERE run_id = $1 GROUP BY run_id
     ) counts WHERE r.id = counts.run_id`, [runId]
  );
}

export async function updateRunStatus(runId, status, errorMessage = null) {
  const times = status === 'running'
    ? ', started_at = COALESCE(started_at, NOW())'
    : ['completed', 'failed', 'cancelled'].includes(status) ? ', completed_at = NOW()' : '';
  const result = await pool.query(
    `UPDATE evaluation_runs SET status = $2, error_message = $3 ${times}
     WHERE id = $1 AND (status = $2 OR (status IN ('queued','running') AND $2 IN ('running','completed','failed','cancelled')))`,
    [runId, status, errorMessage]
  );
  if (result.rowCount > 0) {
    await addAuditEvent(runId, `evaluation.${status}`, errorMessage ? { message: errorMessage } : {});
  }
  return result.rowCount > 0;
}

export async function addAuditEvent(runId, eventType, details = {}) {
  await pool.query(
    'INSERT INTO audit_events(id, run_id, event_type, details) VALUES ($1,$2,$3,$4)',
    [randomUUID(), runId, eventType, JSON.stringify(details)]
  );
}

export async function compareEvaluationRuns(baselineId, candidateId) {
  const [baseline, candidate] = await Promise.all([
    getEvaluationWithResults(baselineId), getEvaluationWithResults(candidateId)
  ]);
  if (!baseline || !candidate) {
    const error = new Error('One or both evaluation runs were not found');
    error.statusCode = 404;
    throw error;
  }
  const baseByCase = new Map(baseline.results.map((row) => [row.test_case_id, row]));
  const compared = candidate.results.map((candidateResult) => {
    const base = baseByCase.get(candidateResult.test_case_id);
    return {
      test_case_id: candidateResult.test_case_id,
      test_case_name: candidateResult.test_case_name,
      baseline_status: base?.status ?? 'not_present',
      candidate_status: candidateResult.status,
      changed: Boolean(base && base.status !== candidateResult.status),
      regression: base?.status === 'passed' && candidateResult.status !== 'passed',
      improvement: base && base.status !== 'passed' && candidateResult.status === 'passed'
    };
  });
  const basePassRate = baseline.total_cases ? (Number(baseline.passed_cases) / Number(baseline.total_cases)) * 100 : 0;
  const candidatePassRate = candidate.total_cases ? (Number(candidate.passed_cases) / Number(candidate.total_cases)) * 100 : 0;
  return {
    baseline: {
      id: baseline.id, model: baseline.model, provider: baseline.provider,
      pass_rate: Number(basePassRate.toFixed(2)), model_report: baseline.model_report
    },
    candidate: {
      id: candidate.id, model: candidate.model, provider: candidate.provider,
      pass_rate: Number(candidatePassRate.toFixed(2)), model_report: candidate.model_report
    },
    pass_rate_delta_percentage_points: Number((candidatePassRate - basePassRate).toFixed(2)),
    regressions: compared.filter((item) => item.regression).length,
    improvements: compared.filter((item) => item.improvement).length,
    cases: compared
  };
}
