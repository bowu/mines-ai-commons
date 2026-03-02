CREATE TABLE "agent_chat_turn_checkpoints" (
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "last_seq" integer DEFAULT 0 NOT NULL,
  "assistant_content" text DEFAULT '' NOT NULL,
  "tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_chat_turn_checkpoints_session_turn_pk" PRIMARY KEY ("session_id","turn_id")
);
--> statement-breakpoint
ALTER TABLE "agent_chat_turn_checkpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_chat_turn_checkpoints" ADD CONSTRAINT "agent_chat_turn_checkpoints_session_id_agent_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_chat_turn_checkpoints_updated_idx" ON "agent_chat_turn_checkpoints" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX "agent_chat_turn_checkpoints_status_idx" ON "agent_chat_turn_checkpoints" USING btree ("status","updated_at");
--> statement-breakpoint
CREATE POLICY "agent_chat_turn_checkpoints_org_scope" ON "agent_chat_turn_checkpoints" AS PERMISSIVE FOR ALL TO "app_user" USING (exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = "agent_chat_turn_checkpoints"."session_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      )) WITH CHECK (exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = "agent_chat_turn_checkpoints"."session_id"
          and a.org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      ));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "agent_chat_turn_checkpoints"
TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "agent_chat_turn_checkpoints"
TO "internal_vm_user";
