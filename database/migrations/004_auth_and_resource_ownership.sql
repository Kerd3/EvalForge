-- EvalForge v1.1 phase 1: users, server-side sessions, and resource ownership.
-- owner_id remains nullable during the upgrade so existing v1.0.0 databases
-- can be migrated without inventing an owner. The first registered account
-- claims existing unowned rows under a transaction-scoped advisory lock.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

ALTER TABLE datasets ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE evaluation_campaigns ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_datasets_owner_updated ON datasets(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_owner_created ON evaluation_runs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluation_campaigns_owner_created ON evaluation_campaigns(owner_id, created_at DESC);
