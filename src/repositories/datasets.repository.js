import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';

async function insertTestCases(client, versionId, testCases) {
  for (let index = 0; index < testCases.length; index += 1) {
    const testCase = testCases[index];
    await client.query(
      `INSERT INTO test_cases
        (id, dataset_version_id, position_index, name, input, expected_output, required_keywords,
         forbidden_keywords, required_tools, forbidden_tools, tools, grading_rules, golden_examples)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        randomUUID(), versionId, index, testCase.name ?? `Test case ${index + 1}`,
        JSON.stringify(testCase.input),
        testCase.expected_output === undefined ? null : JSON.stringify(testCase.expected_output),
        testCase.required_keywords ?? [], testCase.forbidden_keywords ?? [],
        testCase.required_tools ?? [], testCase.forbidden_tools ?? [],
        JSON.stringify(testCase.tools ?? []), JSON.stringify(testCase.grading_rules ?? {}),
        JSON.stringify(testCase.golden_examples ?? [])
      ]
    );
  }
}

export async function createDataset(data, ownerId) {
  const client = await pool.connect();
  const datasetId = randomUUID();
  const versionId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO datasets(id, name, description, owner_id) VALUES ($1, $2, $3, $4)',
      [datasetId, data.name, data.description ?? '', ownerId]
    );
    await client.query(
      'INSERT INTO dataset_versions(id, dataset_id, version_number) VALUES ($1, $2, 1)',
      [versionId, datasetId]
    );
    await insertTestCases(client, versionId, data.test_cases);
    await client.query('COMMIT');
    return getDatasetById(datasetId, ownerId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Save edits as an immutable new dataset version. A row lock serializes
 * concurrent saves so two edits cannot choose the same version number.
 */
export async function createDatasetVersion(datasetId, data, ownerId) {
  const client = await pool.connect();
  const versionId = randomUUID();
  try {
    await client.query('BEGIN');
    const datasetResult = await client.query('SELECT id FROM datasets WHERE id = $1 AND owner_id = $2 FOR UPDATE', [datasetId, ownerId]);
    if (!datasetResult.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const currentVersion = await client.query(
      'SELECT COALESCE(MAX(version_number), 0)::int AS latest_version FROM dataset_versions WHERE dataset_id = $1',
      [datasetId]
    );
    const nextVersion = Number(currentVersion.rows[0]?.latest_version ?? 0) + 1;

    await client.query(
      'INSERT INTO dataset_versions(id, dataset_id, version_number) VALUES ($1, $2, $3)',
      [versionId, datasetId, nextVersion]
    );
    await insertTestCases(client, versionId, data.test_cases);
    await client.query(
      'UPDATE datasets SET name = $2, description = $3, updated_at = NOW() WHERE id = $1',
      [datasetId, data.name, data.description ?? '']
    );
    await client.query('COMMIT');
    return getDatasetById(datasetId, ownerId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listDatasets(ownerId) {
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
     WHERE d.owner_id = $1
     GROUP BY d.id, v.id, v.version_number
     ORDER BY d.updated_at DESC, d.created_at DESC`, [ownerId]
  );
  return rows;
}

export async function getDatasetById(datasetId, ownerId, requestedVersionId = null) {
  const { rows: datasetRows } = await pool.query(
    `SELECT d.id, d.name, d.description, d.created_at, d.updated_at,
            v.id AS latest_version_id, v.version_number AS latest_version
     FROM datasets d
     LEFT JOIN LATERAL (
       SELECT id, version_number FROM dataset_versions
       WHERE dataset_id = d.id AND ($3::uuid IS NULL OR id = $3)
       ORDER BY version_number DESC LIMIT 1
     ) v ON TRUE
      WHERE d.id = $1 AND d.owner_id = $2 AND ($3::uuid IS NULL OR v.id IS NOT NULL)`, [datasetId, ownerId, requestedVersionId]
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
              required_tools, forbidden_tools, tools, grading_rules, golden_examples, created_at
       FROM test_cases WHERE dataset_version_id = $1
       ORDER BY position_index ASC, created_at, name`, [dataset.latest_version_id]
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
