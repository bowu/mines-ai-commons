import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const appUser = pgRole("app_user").existing();
export const vmInternalUser = pgRole("internal_vm_user").existing();
export const authBootstrapUser = pgRole("auth_bootstrap_user").existing();

const orgContext = sql`nullif(current_setting('app.current_org_id', true), '')::uuid`;

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    domain: text("domain").notNull(),
    settings: jsonb("settings").default(sql`'{}'::jsonb`),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow(),
  },
  (table) => [
    unique("organizations_slug_unique").on(table.slug),
    pgPolicy("organizations_org_isolation", {
      for: "all",
      to: appUser,
      using: sql`${table.id} = ${orgContext}`,
      withCheck: sql`${table.id} = ${orgContext}`,
    }),
  ],
).enableRLS();

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role").default("member"),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow(),
  },
  (table) => [
    index("users_org_idx").on(table.org_id),
    pgPolicy("users_org_isolation", {
      for: "all",
      to: appUser,
      using: sql`${table.org_id} = ${orgContext}`,
      withCheck: sql`${table.org_id} = ${orgContext}`,
    }),
  ],
).enableRLS();

export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    token_hash: text("token_hash").notNull(),
    expires_at: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    consumed_at: timestamp("consumed_at", { mode: "date", withTimezone: true }),
    created_at: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow(),
  },
  (table) => [
    unique("magic_link_tokens_token_hash_unique").on(table.token_hash),
    index("magic_link_tokens_email_idx").on(table.email),
    index("magic_link_tokens_expires_idx").on(table.expires_at),
  ],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    sid: text("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire", { mode: "date" }).notNull(),
  },
  (table) => [index("user_sessions_expire_idx").on(table.expire)],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").default(""),
    icon: text("icon").default("🔬"),
    system_prompt: text("system_prompt").default(""),
    machine_type: text("machine_type").default("e2-medium"),
    observed_runtime_version: text("observed_runtime_version"),
    needs_upgrade: boolean("needs_upgrade").default(false).notNull(),
    upgrade_risk_detected: boolean("upgrade_risk_detected")
      .default(false)
      .notNull(),
    upgrade_risk_message: text("upgrade_risk_message"),
    desired_vm_state: text("desired_vm_state").default("stopped").notNull(),
    observed_vm_state: text("observed_vm_state").default("stopped").notNull(),
    vm_name: text("vm_name"),
    vm_ip: text("vm_ip"),
    vm_zone: text("vm_zone"),
    data_disk_name: text("data_disk_name"),
    vm_token_generation: integer("vm_token_generation").default(0),
    last_activity_at: timestamp("last_activity_at", {
      mode: "date",
    }).defaultNow(),
    last_user_message_at: timestamp("last_user_message_at", {
      mode: "date",
    }).defaultNow(),
    active_stream_lease_until: timestamp("active_stream_lease_until", {
      mode: "date",
    }),
    last_reconciled_at: timestamp("last_reconciled_at", { mode: "date" }),
    next_reconcile_at: timestamp("next_reconcile_at", {
      mode: "date",
    }).defaultNow(),
    reconcile_attempt_count: integer("reconcile_attempt_count")
      .default(0)
      .notNull(),
    startup_started_at: timestamp("startup_started_at", { mode: "date" }),
    deleted_at: timestamp("deleted_at", { mode: "date" }),
    last_provision_error: text("last_provision_error"),
    last_provision_error_at: timestamp("last_provision_error_at", {
      mode: "date",
    }),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow(),
    updated_at: timestamp("updated_at", { mode: "date" }).defaultNow(),
  },
  (table) => [
    index("agents_org_idx").on(table.org_id),
    index("agents_reconcile_idx")
      .on(table.next_reconcile_at)
      .where(sql`${table.deleted_at} IS NULL`),
    index("agents_deleted_gc_idx")
      .on(table.deleted_at)
      .where(sql`${table.deleted_at} IS NOT NULL`),
    pgPolicy("agents_org_isolation", {
      for: "all",
      to: appUser,
      using: sql`${table.org_id} = ${orgContext}`,
      withCheck: sql`${table.org_id} = ${orgContext}`,
    }),
  ],
).enableRLS();

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    org_id: uuid("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description").default(""),
    when_to_use: text("when_to_use").default(""),
    instructions: text("instructions").default(""),
    tool_type: text("tool_type"),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow(),
    updated_at: timestamp("updated_at", { mode: "date" }).defaultNow(),
  },
  (table) => [
    index("skills_org_idx").on(table.org_id),
    pgPolicy("skills_select_scope", {
      for: "select",
      to: appUser,
      using: sql`${table.org_id} IS NULL OR ${table.org_id} = ${orgContext}`,
    }),
    pgPolicy("skills_insert_scope", {
      for: "insert",
      to: appUser,
      withCheck: sql`${table.org_id} = ${orgContext}`,
    }),
    pgPolicy("skills_update_scope", {
      for: "update",
      to: appUser,
      using: sql`${table.org_id} = ${orgContext}`,
      withCheck: sql`${table.org_id} = ${orgContext}`,
    }),
    pgPolicy("skills_delete_scope", {
      for: "delete",
      to: appUser,
      using: sql`${table.org_id} = ${orgContext}`,
    }),
  ],
).enableRLS();

export const agentSkills = pgTable(
  "agent_skills",
  {
    agent_id: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skill_id: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").default(true),
    installed: boolean("installed").default(false),
    install_path: text("install_path"),
    installed_at: timestamp("installed_at", { mode: "date" }),
  },
  (table) => [
    primaryKey({ columns: [table.agent_id, table.skill_id] }),
    pgPolicy("agent_skills_org_scope", {
      for: "all",
      to: appUser,
      using: sql`exists (
        select 1
        from agents a
        where a.id = ${table.agent_id}
          and a.org_id = ${orgContext}
      )`,
      withCheck: sql`exists (
        select 1
        from agents a
        where a.id = ${table.agent_id}
          and a.org_id = ${orgContext}
      )`,
    }),
  ],
).enableRLS();

export const agentChatSessions = pgTable(
  "agent_chat_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agent_id: uuid("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    created_by: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    model: text("model").notNull().default("gemini-3.1-pro"),
    shared: boolean("shared").default(false),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow(),
    updated_at: timestamp("updated_at", { mode: "date" }).defaultNow(),
  },
  (table) => [
    index("agent_chat_sessions_agent_idx").on(table.agent_id),
    pgPolicy("agent_chat_sessions_org_scope", {
      for: "all",
      to: appUser,
      using: sql`exists (
        select 1
        from agents a
        where a.id = ${table.agent_id}
          and a.org_id = ${orgContext}
      )`,
      withCheck: sql`exists (
        select 1
        from agents a
        where a.id = ${table.agent_id}
          and a.org_id = ${orgContext}
      )`,
    }),
  ],
).enableRLS();

export const agentChatMessages = pgTable(
  "agent_chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    session_id: uuid("session_id").references(() => agentChatSessions.id, {
      onDelete: "cascade",
    }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    tool_calls: jsonb("tool_calls").default(sql`'[]'::jsonb`),
    sources: jsonb("sources").default(sql`'[]'::jsonb`),
    segments: jsonb("segments"),
    created_at: timestamp("created_at", { mode: "date" }).defaultNow(),
  },
  (table) => [
    index("agent_chat_messages_session_idx").on(table.session_id),
    pgPolicy("agent_chat_messages_org_scope", {
      for: "all",
      to: appUser,
      using: sql`exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = ${table.session_id}
          and a.org_id = ${orgContext}
      )`,
      withCheck: sql`exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = ${table.session_id}
          and a.org_id = ${orgContext}
      )`,
    }),
  ],
).enableRLS();

export const agentChatTurnCheckpoints = pgTable(
  "agent_chat_turn_checkpoints",
  {
    session_id: uuid("session_id")
      .notNull()
      .references(() => agentChatSessions.id, { onDelete: "cascade" }),
    turn_id: uuid("turn_id").notNull(),
    status: text("status").default("running").notNull(),
    last_seq: integer("last_seq").default(0).notNull(),
    assistant_content: text("assistant_content").default("").notNull(),
    tool_calls: jsonb("tool_calls").default(sql`'[]'::jsonb`).notNull(),
    segments: jsonb("segments").default(sql`'[]'::jsonb`).notNull(),
    last_event_at: timestamp("last_event_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    created_at: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.turn_id] }),
    index("agent_chat_turn_checkpoints_updated_idx").on(table.updated_at),
    index("agent_chat_turn_checkpoints_status_idx").on(
      table.status,
      table.updated_at,
    ),
    pgPolicy("agent_chat_turn_checkpoints_org_scope", {
      for: "all",
      to: appUser,
      using: sql`exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = ${table.session_id}
          and a.org_id = ${orgContext}
      )`,
      withCheck: sql`exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = ${table.session_id}
          and a.org_id = ${orgContext}
      )`,
    }),
  ],
).enableRLS();

export const agentSessionGoals = pgTable(
  "agent_session_goals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    session_id: uuid("session_id")
      .notNull()
      .references(() => agentChatSessions.id, { onDelete: "cascade" }),
    created_by: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    goal: text("goal").notNull(),
    guidance: text("guidance").default("").notNull(),
    output_folder: text("output_folder").notNull(),
    deadline_at: timestamp("deadline_at", {
      mode: "date",
      withTimezone: true,
    }),
    status: text("status").default("active").notNull(),
    status_reason: text("status_reason"),
    report_path: text("report_path"),
    artifact_paths: jsonb("artifact_paths").default(sql`'[]'::jsonb`).notNull(),
    progress_summary: text("progress_summary"),
    next_suggested_run_at: timestamp("next_suggested_run_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    run_count: integer("run_count").default(0).notNull(),
    last_run_started_at: timestamp("last_run_started_at", {
      mode: "date",
      withTimezone: true,
    }),
    last_run_ended_at: timestamp("last_run_ended_at", {
      mode: "date",
      withTimezone: true,
    }),
    completed_at: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    created_at: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow(),
    updated_at: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow(),
  },
  (table) => [
    index("agent_session_goals_session_idx").on(table.session_id),
    index("agent_session_goals_status_idx").on(
      table.status,
      table.next_suggested_run_at,
    ),
    pgPolicy("agent_session_goals_org_scope", {
      for: "all",
      to: appUser,
      using: sql`exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = ${table.session_id}
          and a.org_id = ${orgContext}
      )`,
      withCheck: sql`exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = ${table.session_id}
          and a.org_id = ${orgContext}
      )`,
    }),
  ],
).enableRLS();

export const agentSessionGoalRuns = pgTable(
  "agent_session_goal_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    goal_id: uuid("goal_id")
      .notNull()
      .references(() => agentSessionGoals.id, { onDelete: "cascade" }),
    session_id: uuid("session_id")
      .notNull()
      .references(() => agentChatSessions.id, { onDelete: "cascade" }),
    run_type: text("run_type").notNull(),
    trigger: text("trigger"),
    status: text("status").default("running").notNull(),
    error_message: text("error_message"),
    started_at: timestamp("started_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    ended_at: timestamp("ended_at", {
      mode: "date",
      withTimezone: true,
    }),
    created_at: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    }).defaultNow(),
  },
  (table) => [
    index("agent_session_goal_runs_goal_idx").on(table.goal_id),
    index("agent_session_goal_runs_session_idx").on(table.session_id),
    pgPolicy("agent_session_goal_runs_org_scope", {
      for: "all",
      to: appUser,
      using: sql`exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = ${table.session_id}
          and a.org_id = ${orgContext}
      )`,
      withCheck: sql`exists (
        select 1
        from agent_chat_sessions s
        join agents a on a.id = s.agent_id
        where s.id = ${table.session_id}
          and a.org_id = ${orgContext}
      )`,
    }),
  ],
).enableRLS();

export const agentAccess = pgTable(
  "agent_access",
  {
    agent_id: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").default("viewer"),
  },
  (table) => [
    primaryKey({ columns: [table.agent_id, table.user_id] }),
    pgPolicy("agent_access_org_scope", {
      for: "all",
      to: appUser,
      using: sql`exists (
        select 1
        from agents a
        where a.id = ${table.agent_id}
          and a.org_id = ${orgContext}
      )`,
      withCheck: sql`exists (
        select 1
        from agents a
        where a.id = ${table.agent_id}
          and a.org_id = ${orgContext}
      )`,
    }),
  ],
).enableRLS();

export const schema = {
  organizations,
  users,
  agents,
  skills,
  agentSkills,
  agentChatSessions,
  agentChatMessages,
  agentSessionGoals,
  agentSessionGoalRuns,
  agentAccess,
};
