ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "last_user_message_at" timestamp DEFAULT now();
