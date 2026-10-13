CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS datasets (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dataset_versions (
  id UUID PRIMARY KEY,
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dataset_id, version_number),
  UNIQUE (id, dataset_id)
);

CREATE TABLE IF NOT EXISTS test_cases (
  id UUID PRIMARY KEY,
  dataset_version_id UUID NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  input JSONB NOT NULL,
  expected_output JSONB,
  required_keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  forbidden_keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  required_tools TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  forbidden_tools TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  tools JSONB NOT NULL DEFAULT '[]'::JSONB,
  grading_rules JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_test_cases_version ON test_cases(dataset_version_id);

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id UUID PRIMARY KEY,
  dataset_version_id UUID NOT NULL REFERENCES dataset_versions(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  total_cases INTEGER NOT NULL DEFAULT 0,
  completed_cases INTEGER NOT NULL DEFAULT 0,
  passed_cases INTEGER NOT NULL DEFAULT 0,
  failed_cases INTEGER NOT NULL DEFAULT 0,
  error_cases INTEGER NOT NULL DEFAULT 0,
  average_latency_ms NUMERIC,
  total_input_tokens BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_created ON evaluation_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_status ON evaluation_runs(status);

CREATE TABLE IF NOT EXISTS evaluation_results (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  test_case_id UUID NOT NULL REFERENCES test_cases(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending','passed','failed','error')),
  actual_output JSONB,
  tool_calls JSONB NOT NULL DEFAULT '[]'::JSONB,
  graders JSONB NOT NULL DEFAULT '[]'::JSONB,
  score NUMERIC,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd NUMERIC,
  error_message TEXT,
  trace JSONB NOT NULL DEFAULT '[]'::JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (run_id, test_case_id)
);
CREATE INDEX IF NOT EXISTS idx_evaluation_results_run ON evaluation_results(run_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  run_id UUID REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_run ON audit_events(run_id, created_at);
