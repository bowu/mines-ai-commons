GRANT USAGE ON SCHEMA "public" TO "app_user";
GRANT USAGE ON SCHEMA "public" TO "internal_vm_user";
GRANT USAGE ON SCHEMA "public" TO "auth_bootstrap_user";
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "organizations",
  "users",
  "agents",
  "skills",
  "agent_skills",
  "agent_chat_sessions",
  "agent_chat_messages",
  "agent_access"
TO "app_user";
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "agents",
  "skills",
  "agent_skills",
  "agent_chat_sessions",
  "agent_chat_messages",
  "agent_access"
TO "internal_vm_user";
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "organizations",
  "users"
TO "auth_bootstrap_user";
