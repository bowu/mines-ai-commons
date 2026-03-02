ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS upgrade_risk_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS upgrade_risk_message text;
