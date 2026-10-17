-- EvalForge v1.1 Phase 2: labeled grader-calibration examples and classified failures.
-- Golden examples live on test_cases, which already belong to immutable dataset_versions.
ALTER TABLE test_cases
  ADD COLUMN IF NOT EXISTS golden_examples JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE evaluation_results
  ADD COLUMN IF NOT EXISTS failure_category TEXT,
  ADD COLUMN IF NOT EXISTS error_stage TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evaluation_results_failure_category_check'
  ) THEN
    ALTER TABLE evaluation_results
      ADD CONSTRAINT evaluation_results_failure_category_check
      CHECK (failure_category IS NULL OR failure_category IN ('provider_error', 'evaluator_error', 'model_failure'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'evaluation_results_error_stage_check'
  ) THEN
    ALTER TABLE evaluation_results
      ADD CONSTRAINT evaluation_results_error_stage_check
      CHECK (error_stage IS NULL OR error_stage IN ('provider_initialization', 'generation', 'model_response', 'grading', 'llm_judge', 'result_persistence'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_test_cases_golden_examples
  ON test_cases USING GIN (golden_examples);
CREATE INDEX IF NOT EXISTS idx_evaluation_results_failure_category
  ON evaluation_results(run_id, failure_category)
  WHERE failure_category IS NOT NULL;
