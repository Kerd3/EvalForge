import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/pool.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() }
}));

import { pool } from '../../src/db/pool.js';
import { createDataset, listDatasets, getDatasetById } from '../../src/repositories/datasets.repository.js';
import { createEvaluationRun, listEvaluations, getEvaluationById, getEvaluationCampaignById } from '../../src/repositories/evaluations.repository.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

afterEach(() => vi.clearAllMocks());

describe('repository ownership predicates', () => {
  it('persists the owner ID when creating a dataset', async () => {
    const client = {
      release: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    };
    pool.connect.mockResolvedValue(client);
    pool.query.mockResolvedValue({ rows: [] });

    await createDataset({ name: 'Private dataset', description: '', test_cases: [{ input: 'hello' }] }, USER_A);
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO datasets'));
    expect(insert).toBeDefined();
    expect(String(insert[0])).toContain('owner_id');
    expect(insert[1][3]).toBe(USER_A);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('persists the owner ID when queuing an evaluation run', async () => {
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql) => {
        const statement = String(sql);
        if (statement.includes('SELECT v.id FROM dataset_versions v JOIN datasets d')) {
          return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], rowCount: 1 };
        }
        if (statement.includes('SELECT id FROM test_cases WHERE dataset_version_id')) {
          return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    pool.connect.mockResolvedValue(client);
    pool.query.mockResolvedValue({ rows: [] });

    await createEvaluationRun({ datasetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', provider: 'mock', model: 'mock-v1', systemPrompt: '', ownerId: USER_B });
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO evaluation_runs'));
    expect(insert).toBeDefined();
    expect(String(insert[0])).toContain('owner_id');
    expect(insert[1][6]).toBe(USER_B);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('filters dataset lists by the authenticated owner', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await listDatasets(USER_A);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE d.owner_id = $1'), [USER_A]);
  });

  it('filters dataset detail queries by both ID and owner', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await getDatasetById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', USER_B);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE d.id = $1 AND d.owner_id = $2'),
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', USER_B, null]
    );
  });

  it('filters evaluation history by owner', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await listEvaluations(10, USER_A);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE ($2::uuid IS NULL OR r.owner_id = $2)'), [10, USER_A]);
  });

  it('filters evaluation details by run ID and owner', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await getEvaluationById('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', USER_B);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE r.id = $1 AND ($2::uuid IS NULL OR r.owner_id = $2)'),
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', USER_B]
    );
  });

  it('filters campaign lookups by owner before loading repetition details', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await getEvaluationCampaignById('cccccccc-cccc-4ccc-8ccc-cccccccccccc', USER_A);
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE c.id = $1 AND ($2::uuid IS NULL OR c.owner_id = $2)'),
      ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', USER_A]
    );
  });
});
