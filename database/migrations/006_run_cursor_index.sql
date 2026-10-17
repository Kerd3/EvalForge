CREATE INDEX IF NOT EXISTS idx_evaluation_runs_owner_created_id
  ON evaluation_runs(owner_id, created_at DESC, id DESC);
