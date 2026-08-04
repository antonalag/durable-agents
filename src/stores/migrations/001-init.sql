CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  config TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  total_cost DOUBLE PRECISION DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_steps INTEGER DEFAULT 0,
  recovery_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  node_name TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  input_state_hash TEXT,
  cost_input_tokens INTEGER DEFAULT 0,
  cost_output_tokens INTEGER DEFAULT 0,
  cost_usd DOUBLE PRECISION DEFAULT 0,
  attempt INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS outcomes (
  outcome_id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  result BYTEA NOT NULL,
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcomes_opkey ON outcomes(operation_key);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, last_heartbeat);
