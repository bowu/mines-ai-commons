ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS needs_upgrade boolean NOT NULL DEFAULT false;
