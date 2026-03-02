CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
DO $$
BEGIN
	CREATE ROLE "app_user" NOLOGIN;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	CREATE ROLE "internal_vm_user" NOLOGIN BYPASSRLS;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	CREATE ROLE "auth_bootstrap_user" NOLOGIN BYPASSRLS;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE "agent_access" (
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'viewer',
	CONSTRAINT "agent_access_agent_id_user_id_pk" PRIMARY KEY("agent_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"user_id" uuid,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb,
	"sources" jsonb DEFAULT '[]'::jsonb,
	"segments" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "agent_chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"created_by" uuid,
	"shared" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "agent_chat_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true,
	"installed" boolean DEFAULT false,
	"install_path" text,
	"installed_at" timestamp,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '',
	"icon" text DEFAULT '🔬',
	"system_prompt" text DEFAULT '',
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"domain" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '',
	"when_to_use" text DEFAULT '',
	"instructions" text DEFAULT '',
	"tool_type" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text DEFAULT 'member',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_access" ADD CONSTRAINT "agent_access_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access" ADD CONSTRAINT "agent_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chat_messages" ADD CONSTRAINT "agent_chat_messages_session_id_agent_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chat_messages" ADD CONSTRAINT "agent_chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chat_sessions" ADD CONSTRAINT "agent_chat_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chat_sessions" ADD CONSTRAINT "agent_chat_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_chat_messages_session_idx" ON "agent_chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_chat_sessions_agent_idx" ON "agent_chat_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agents_org_idx" ON "agents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "skills_org_idx" ON "skills" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("org_id");--> statement-breakpoint
CREATE POLICY "agent_access_org_scope" ON "agent_access" AS PERMISSIVE FOR ALL TO "app_user" USING (exists (
        select 1
        from agents a
        where a.id = "agent_access"."agent_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      )) WITH CHECK (exists (
        select 1
        from agents a
        where a.id = "agent_access"."agent_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      ));--> statement-breakpoint
CREATE POLICY "agent_chat_messages_org_scope" ON "agent_chat_messages" AS PERMISSIVE FOR ALL TO "app_user" USING (exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = "agent_chat_messages"."session_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      )) WITH CHECK (exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = "agent_chat_messages"."session_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      ));--> statement-breakpoint
CREATE POLICY "agent_chat_sessions_org_scope" ON "agent_chat_sessions" AS PERMISSIVE FOR ALL TO "app_user" USING (exists (
        select 1
        from agents a
        where a.id = "agent_chat_sessions"."agent_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      )) WITH CHECK (exists (
        select 1
        from agents a
        where a.id = "agent_chat_sessions"."agent_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      ));--> statement-breakpoint
CREATE POLICY "agent_skills_org_scope" ON "agent_skills" AS PERMISSIVE FOR ALL TO "app_user" USING (exists (
        select 1
        from agents a
        where a.id = "agent_skills"."agent_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      )) WITH CHECK (exists (
        select 1
        from agents a
        where a.id = "agent_skills"."agent_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      ));--> statement-breakpoint
CREATE POLICY "agents_org_isolation" ON "agents" AS PERMISSIVE FOR ALL TO "app_user" USING ("agents"."org_id" = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK ("agents"."org_id" = nullif(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organizations_org_isolation" ON "organizations" AS PERMISSIVE FOR ALL TO "app_user" USING ("organizations"."id" = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK ("organizations"."id" = nullif(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skills_select_scope" ON "skills" AS PERMISSIVE FOR SELECT TO "app_user" USING ("skills"."org_id" IS NULL OR "skills"."org_id" = nullif(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skills_insert_scope" ON "skills" AS PERMISSIVE FOR INSERT TO "app_user" WITH CHECK ("skills"."org_id" = nullif(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skills_update_scope" ON "skills" AS PERMISSIVE FOR UPDATE TO "app_user" USING ("skills"."org_id" = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK ("skills"."org_id" = nullif(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "skills_delete_scope" ON "skills" AS PERMISSIVE FOR DELETE TO "app_user" USING ("skills"."org_id" = nullif(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "users_org_isolation" ON "users" AS PERMISSIVE FOR ALL TO "app_user" USING ("users"."org_id" = nullif(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK ("users"."org_id" = nullif(current_setting('app.current_org_id', true), '')::uuid);
