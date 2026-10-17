import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { buildModelReport } from '../services/model-reporting.service.js';
import { buildReliabilityReport } from '../services/reliability-analysis.service.js';
import { buildEvaluationQualityReport, buildPairedComparison } from '../services/evaluation-quality.service.js';

export async function createEvaluationRun({ datasetId, datasetVersionId, provider, model, systemPrompt, ownerId }) {
  const client = await pool.connect();
  const runId = randomUUID();
  try {
    await client.query('BEGIN');
    let versionId = datasetVersionId;
    if (datasetId) {
      const versionResult = await client.query(
        'SELECT v.id FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.dataset_id = $1 AND d.owner_id = $2 ORDER BY v.version_number DESC LIMIT 1', [datasetId, ownerId]
      );
      versionId = versionResult.rows[0]?.id;
      if (!versionId) {
        const error = new Error('Dataset was not found or has no versions');
        error.statusCode = 404;
        throw error;
      }
    } else {
      const versionResult = await client.query('SELECT v.id FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.id = $1 AND d.owner_id = $2', [versionId, ownerId]);
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
       (id, dataset_version_id, provider, model, system_prompt, status, total_cases, owner_id)
       VALUES ($1,$2,$3,$4,$5,'queued',$6,$7)`,
      [runId, versionId, provider, model, systemPrompt, casesResult.rowCount, ownerId]
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
    return getEvaluationById(runId, ownerId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createEvaluationCampaign({ datasetId, datasetVersionId, provider, model, systemPrompt, repeatCount, ownerId }) {
  const client = await pool.connect();
  const campaignId = randomUUID();
  try {
    await client.query('BEGIN');
    let versionId = datasetVersionId;
    if (datasetId) {
      const versionResult = await client.query(
        'SELECT v.id FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.dataset_id = $1 AND d.owner_id = $2 ORDER BY v.version_number DESC LIMIT 1', [datasetId, ownerId]
      );
      versionId = versionResult.rows[0]?.id;
      if (!versionId) {
        const error = new Error('Dataset was not found or has no versions');
        error.statusCode = 404;
        throw error;
      }
    } else {
      const versionResult = await client.query('SELECT v.id FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.id = $1 AND d.owner_id = $2', [versionId, ownerId]);
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
       (id, dataset_version_id, provider, model, system_prompt, repeat_count, status, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)`,
      [campaignId, versionId, provider, model, systemPrompt, repeatCount, ownerId]
    );

    for (let repetitionIndex = 1; repetitionIndex <= repeatCount; repetitionIndex += 1) {
      const runId = randomUUID();
      await client.query(
        `INSERT INTO evaluation_runs
         (id, dataset_version_id, provider, model, system_prompt, status, total_cases, campaign_id, repetition_index, owner_id)
         VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9)`,
        [runId, versionId, provider, model, systemPrompt, casesResult.rowCount, campaignId, repetitionIndex, ownerId]
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
    return getEvaluationCampaignById(campaignId, ownerId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getEvaluationCampaignState(campaignId, ownerId = null) {
  const { rows } = await pool.query('SELECT * FROM evaluation_campaigns WHERE id = $1 AND ($2::uuid IS NULL OR owner_id = $2)', [campaignId, ownerId]);
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

export async function cancelEvaluationCampaign(campaignId, ownerId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE evaluation_campaigns SET status='cancelled', completed_at=NOW()
       WHERE id=$1 AND ($2::uuid IS NULL OR owner_id = $2) AND status IN ('queued','running')`, [campaignId, ownerId]
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

export async function getEvaluationCampaignById(campaignId, ownerId = null) {
  const { rows: campaignRows } = await pool.query(
    `SELECT c.*, v.version_number, d.id AS dataset_id, d.name AS dataset_name
     FROM evaluation_campaigns c
     JOIN dataset_versions v ON v.id = c.dataset_version_id
     JOIN datasets d ON d.id = v.dataset_id
     WHERE c.id = $1 AND ($2::uuid IS NULL OR c.owner_id = $2)`, [campaignId, ownerId]
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
         COUNT(*) FILTER (WHERE status = 'error' AND failure_category = 'provider_error' AND model_name IS NULL)::int AS provider_error_cases
       FROM (
         SELECT er.status, er.failure_category,
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
            er.latency_ms, er.estimated_cost_usd, er.failure_category, er.error_stage
     FROM evaluation_results er
     JOIN evaluation_runs r ON r.id = er.run_id
     JOIN test_cases tc ON tc.id = er.test_case_id
     WHERE r.campaign_id = $1 ORDER BY r.repetition_index, tc.created_at, tc.name`, [campaignId]
  );
  return { ...campaign, runs, reliability: buildReliabilityReport({ campaign, runs, results }) };
}

export async function listEvaluations(limit = 50, ownerId = null) {
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
         COUNT(*) FILTER (WHERE status = 'error' AND failure_category = 'provider_error' AND model_name IS NULL)::int AS provider_error_cases
       FROM (
         SELECT er.status, er.failure_category,
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
     WHERE ($2::uuid IS NULL OR r.owner_id = $2)
     ORDER BY r.created_at DESC LIMIT $1`, [limit, ownerId]
  );
  return rows;
}

export async function getEvaluationById(runId, ownerId = null) {
  const { rows } = await pool.query(
    `SELECT r.*, c.repeat_count AS campaign_repeat_count, v.version_number, d.id AS dataset_id, d.name AS dataset_name
     FROM evaluation_runs r
     JOIN dataset_versions v ON v.id = r.dataset_version_id
     JOIN datasets d ON d.id = v.dataset_id
     LEFT JOIN evaluation_campaigns c ON c.id = r.campaign_id
     WHERE r.id = $1 AND ($2::uuid IS NULL OR r.owner_id = $2)`, [runId, ownerId]
  );
  return rows[0] ?? null;
}

export async function getEvaluationWithResults(runId, ownerId = null) {
  const run = await getEvaluationById(runId, ownerId);
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
    model_report: buildModelReport(run, rows),
    quality_report: buildEvaluationQualityReport(rows)
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

export async function saveEvaluationResult({ runId, testCaseId, status, actualOutput, toolCalls, graders, score, latencyMs, inputTokens, outputTokens, estimatedCostUsd, errorMessage, trace, failureCategory = null, errorStage = null }) {
  await pool.query(
    `UPDATE evaluation_results SET status=$3, actual_output=$4, tool_calls=$5, graders=$6,
       score=$7, latency_ms=$8, input_tokens=$9, output_tokens=$10, estimated_cost_usd=$11,
       error_message=$12, failure_category=$13, error_stage=$14, trace=$15, completed_at=NOW()
     WHERE run_id=$1 AND test_case_id=$2`,
    [runId, testCaseId, status,
      actualOutput === undefined || actualOutput === null ? null : JSON.stringify(actualOutput),
      JSON.stringify(toolCalls ?? []), JSON.stringify(graders ?? []), score ?? null, latencyMs ?? null,
      inputTokens ?? null, outputTokens ?? null, estimatedCostUsd ?? null, errorMessage ?? null,
      failureCategory ?? null, errorStage ?? null, JSON.stringify(trace ?? [])]
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

export async function updateRunStatus(runId, status, errorMessage = null, ownerId = null) {
  const times = status === 'running'
    ? ', started_at = COALESCE(started_at, NOW())'
    : ['completed', 'failed', 'cancelled'].includes(status) ? ', completed_at = NOW()' : '';
  const result = await pool.query(
    `UPDATE evaluation_runs SET status = $2, error_message = $3 ${times}
     WHERE id = $1 AND ($4::uuid IS NULL OR owner_id = $4) AND (status = $2 OR (status IN ('queued','running') AND $2 IN ('running','completed','failed','cancelled')))`,
    [runId, status, errorMessage, ownerId]
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

export async function compareEvaluationRuns(baselineId, candidateId, ownerId = null) {
  const [baseline, candidate] = await Promise.all([
    getEvaluationWithResults(baselineId, ownerId), getEvaluationWithResults(candidateId, ownerId)
  ]);
  if (!baseline || !candidate) {
    const error = new Error('One or both evaluation runs were not found');
    error.statusCode = 404;
    throw error;
  }

  const comparison = buildPairedComparison(baseline.results, candidate.results, {
    baselineDatasetVersionId: baseline.dataset_version_id,
    candidateDatasetVersionId: candidate.dataset_version_id
  });
  const baseRate = comparison.baseline_pass_rate;
  const candidateRate = comparison.candidate_pass_rate;
  return {
    schema_version: comparison.schema_version,
    baseline: {
      id: baseline.id,
      model: baseline.model,
      provider: baseline.provider,
      pass_rate: baseRate.rate === null ? null : Number(baseRate.rate.toFixed(2)),
      pass_rate_sample_size: baseRate.answered,
      pass_rate_confidence_interval_95: baseRate.interval,
      model_report: baseline.model_report,
      quality_report: baseline.quality_report
    },
    candidate: {
      id: candidate.id,
      model: candidate.model,
      provider: candidate.provider,
      pass_rate: candidateRate.rate === null ? null : Number(candidateRate.rate.toFixed(2)),
      pass_rate_sample_size: candidateRate.answered,
      pass_rate_confidence_interval_95: candidateRate.interval,
      model_report: candidate.model_report,
      quality_report: candidate.quality_report
    },
    pass_rate_delta_percentage_points: comparison.pass_rate_delta_percentage_points,
    regressions: comparison.paired_analysis.regressions,
    improvements: comparison.paired_analysis.improvements,
    paired_analysis: comparison.paired_analysis,
    data_quality: comparison.data_quality,
    cases: comparison.cases
  };
}
