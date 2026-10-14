-- Preserve the order in which test cases are authored when a dataset is saved.
ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS position_index INTEGER;

WITH ranked_cases AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY dataset_version_id
           ORDER BY created_at, name, id
         ) - 1 AS position
  FROM test_cases
)
UPDATE test_cases AS target
SET position_index = ranked_cases.position
FROM ranked_cases
WHERE target.id = ranked_cases.id
  AND target.position_index IS NULL;

ALTER TABLE test_cases
  ALTER COLUMN position_index SET DEFAULT 0,
  ALTER COLUMN position_index SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_cases_version_position
  ON test_cases(dataset_version_id, position_index, created_at, name);
