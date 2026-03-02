CREATE UNIQUE INDEX IF NOT EXISTS "organizations_domain_lower"
ON "organizations" (LOWER("domain"));
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower"
ON "users" (LOWER("email"));
