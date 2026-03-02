CREATE TABLE "agent_session_goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "created_by" uuid,
  "goal" text NOT NULL,
  "guidance" text DEFAULT '' NOT NULL,
  "output_folder" text NOT NULL,
  "deadline_at" timestamp with time zone,
  "status" text DEFAULT 'active' NOT NULL,
  "status_reason" text,
  "report_path" text,
  "artifact_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "progress_summary" text,
  "next_suggested_run_at" timestamp with time zone DEFAULT now() NOT NULL,
  "run_count" integer DEFAULT 0 NOT NULL,
  "last_run_started_at" timestamp with time zone,
  "last_run_ended_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agent_session_goal_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "goal_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "run_type" text NOT NULL,
  "trigger" text,
  "status" text DEFAULT 'running' NOT NULL,
  "error_message" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "agent_session_goals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_session_goal_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_session_goals" ADD CONSTRAINT "agent_session_goals_session_id_agent_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_goals" ADD CONSTRAINT "agent_session_goals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_goal_runs" ADD CONSTRAINT "agent_session_goal_runs_goal_id_agent_session_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."agent_session_goals"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_goal_runs" ADD CONSTRAINT "agent_session_goal_runs_session_id_agent_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_session_goals_session_idx" ON "agent_session_goals" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "agent_session_goals_status_idx" ON "agent_session_goals" USING btree ("status","next_suggested_run_at");
--> statement-breakpoint
CREATE INDEX "agent_session_goal_runs_goal_idx" ON "agent_session_goal_runs" USING btree ("goal_id");
--> statement-breakpoint
CREATE INDEX "agent_session_goal_runs_session_idx" ON "agent_session_goal_runs" USING btree ("session_id");
--> statement-breakpoint
CREATE POLICY "agent_session_goals_org_scope" ON "agent_session_goals" AS PERMISSIVE FOR ALL TO "app_user" USING (exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = "agent_session_goals"."session_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      )) WITH CHECK (exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = "agent_session_goals"."session_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      ));
--> statement-breakpoint
CREATE POLICY "agent_session_goal_runs_org_scope" ON "agent_session_goal_runs" AS PERMISSIVE FOR ALL TO "app_user" USING (exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = "agent_session_goal_runs"."session_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      )) WITH CHECK (exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = "agent_session_goal_runs"."session_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      ));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "agent_session_goals",
  "agent_session_goal_runs"
TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "agent_session_goals",
  "agent_session_goal_runs"
TO "internal_vm_user";
