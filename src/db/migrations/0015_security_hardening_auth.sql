CREATE TABLE IF NOT EXISTS "magic_link_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now()
);

ALTER TABLE "magic_link_tokens"
  ALTER COLUMN "expires_at" TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "consumed_at" TYPE timestamp with time zone USING "consumed_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "created_at" TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';

CREATE UNIQUE INDEX IF NOT EXISTS "magic_link_tokens_token_hash_unique"
  ON "magic_link_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "magic_link_tokens_email_idx"
  ON "magic_link_tokens" ("email");
CREATE INDEX IF NOT EXISTS "magic_link_tokens_expires_idx"
  ON "magic_link_tokens" ("expires_at");

CREATE TABLE IF NOT EXISTS "user_sessions" (
  "sid" text PRIMARY KEY NOT NULL,
  "sess" jsonb NOT NULL,
  "expire" timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_sessions_expire_idx"
  ON "user_sessions" ("expire");
