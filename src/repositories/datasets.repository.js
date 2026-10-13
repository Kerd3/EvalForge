import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';

export async function createDataset(data) {
  const client = await pool.connect();
  const datasetId = randomUUID();
  const versionId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO datasets(id, name, description) VALUES ($1, $2, $3)',
      [datasetId, data.name, data.description ?? '']
    );
    await client.query(
      'INSERT INTO dataset_versions(id, dataset_id, version_number) VALUES ($1, $2, 1)',
      [versionId, datasetId]
    );
    for (let index = 0; index < data.test_cases.length; index += 1) {
      const testCase = data.test_cases[index];
      await client.query(
        `INSERT INTO test_cases
          (id, dataset_version_id, name, input, expected_output, required_keywords,
           forbidden_keywords, required_tools, forbidden_tools, tools, grading_rules)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          randomUUID(), versionId, testCase.name ?? `Test case ${index + 1}`,
          JSON.stringify(testCase.input),
          testCase.expected_output === undefined ? null : JSON.stringify(testCase.expected_output),
          testCase.required_keywords ?? [], testCase.forbidden_keywords ?? [],
          testCase.required_tools ?? [], testCase.forbidden_tools ?? [],
          JSON.stringify(testCase.tools ?? []), JSON.stringify(testCase.grading_rules ?? {})
        ]
      );
    }
    await client.query('COMMIT');
    return getDatasetById(datasetId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listDatasets() {
  const { rows } = await pool.query(
    `SELECT d.id, d.name, d.description, d.created_at, d.updated_at,
            v.id AS latest_version_id, v.version_number AS latest_version,
            COUNT(tc.id)::int AS test_case_count
     FROM datasets d
     LEFT JOIN LATERAL (
       SELECT id, version_number FROM dataset_versions
       WHERE dataset_id = d.id ORDER BY version_number DESC LIMIT 1
     ) v ON TRUE
     LEFT JOIN test_cases tc ON tc.dataset_version_id = v.id
     GROUP BY d.id, v.id, v.version_number
     ORDER BY d.created_at DESC`
  );
  return rows;
}

export async function getDatasetById(datasetId) {
  const { rows: datasetRows } = await pool.query(
    `SELECT d.id, d.name, d.description, d.created_at, d.updated_at,
            v.id AS latest_version_id, v.version_number AS latest_version
     FROM datasets d
     LEFT JOIN LATERAL (
       SELECT id, version_number FROM dataset_versions
       WHERE dataset_id = d.id ORDER BY version_number DESC LIMIT 1
     ) v ON TRUE
     WHERE d.id = $1`, [datasetId]
  );
  if (!datasetRows[0]) return null;
  const dataset = datasetRows[0];
  const { rows: versions } = await pool.query(
    `SELECT v.id, v.version_number, v.created_at, COUNT(tc.id)::int AS test_case_count
     FROM dataset_versions v LEFT JOIN test_cases tc ON tc.dataset_version_id = v.id
     WHERE v.dataset_id = $1 GROUP BY v.id ORDER BY v.version_number DESC`, [datasetId]
  );
  const { rows: cases } = dataset.latest_version_id
    ? await pool.query(
      `SELECT id, name, input, expected_output, required_keywords, forbidden_keywords,
              required_tools, forbidden_tools, tools, grading_rules
       FROM test_cases WHERE dataset_version_id = $1 ORDER BY created_at, name`, [dataset.latest_version_id]
    )
    : { rows: [] };
  return { ...dataset, versions, test_cases: cases };
}

export async function getLatestVersionId(datasetId) {
  const { rows } = await pool.query(
    'SELECT id FROM dataset_versions WHERE dataset_id = $1 ORDER BY version_number DESC LIMIT 1',
    [datasetId]
  );
  return rows[0]?.id ?? null;
}
