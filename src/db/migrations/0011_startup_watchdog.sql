ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS startup_started_at timestamptz;
