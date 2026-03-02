ALTER TABLE "agent_chat_sessions"
  ADD COLUMN "model" text NOT NULL DEFAULT 'sonnet-4.6';

ALTER TABLE "agent_chat_sessions"
  ADD CONSTRAINT "agent_chat_sessions_model_check"
  CHECK ("model" IN ('gemini-3.1-pro', 'sonnet-4.6', 'opus-4.6', 'gpt-5.2'));
