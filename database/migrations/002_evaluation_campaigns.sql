CREATE TABLE IF NOT EXISTS evaluation_campaigns (
  id UUID PRIMARY KEY,
  dataset_version_id UUID NOT NULL REFERENCES dataset_versions(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  repeat_count INTEGER NOT NULL CHECK (repeat_count BETWEEN 2 AND 10),
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_evaluation_campaigns_created ON evaluation_campaigns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluation_campaigns_status ON evaluation_campaigns(status);

ALTER TABLE evaluation_runs
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES evaluation_campaigns(id) ON DELETE SET NULL;
ALTER TABLE evaluation_runs
  ADD COLUMN IF NOT EXISTS repetition_index INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_runs_campaign_repetition
  ON evaluation_runs(campaign_id, repetition_index)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_campaign
  ON evaluation_runs(campaign_id, repetition_index)
  WHERE campaign_id IS NOT NULL;
