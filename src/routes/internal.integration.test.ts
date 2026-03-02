import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCoreTables,
  closeTestPool,
  getDefaultUserId,
  getTestPool,
} from "../test/db-helper.js";

const defaultIntegrationDatabaseUrl =
  process.env.INTEGRATION_DATABASE_URL ||
  "postgresql://mines_ai:mines_ai_password@localhost:5435/mines_ai_integration";

async function createFreshApp(
  envOverrides: Record<string, string | undefined>,
) {
  const envKeys = [
    "NODE_ENV",
    "AUTH_PROVIDER",
    "DATABASE_URL",
    "APP_DATABASE_URL",
    "SESSION_SECRET",
    "PUBLIC_URL",
    "SANDBOX_MODE",
    "VM_BOOTSTRAP_SECRET",
    "VM_TOKEN_SECRET",
    "GEMINI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "DEV_GCE_ALLOW_PROVIDER_KEYS",
    "LITELLM_PROXY_URL",
    "LITELLM_PROXY_API_KEY",
    "LITELLM_MODEL_GEMINI",
    "LITELLM_MODEL_SONNET",
    "LITELLM_MODEL_OPUS",
    "LITELLM_MODEL_GPT",
    "DEPLOY_DRAIN_FLAG_FILE",
  ];
  const previous: Record<string, string | undefined> = {};
  for (const key of envKeys) {
    previous[key] = process.env[key];
  }

  process.env.DATABASE_URL = defaultIntegrationDatabaseUrl;
  process.env.APP_DATABASE_URL = defaultIntegrationDatabaseUrl;
  process.env.AUTH_PROVIDER = "none";
  process.env.PUBLIC_URL = "http://localhost:5173";
  process.env.SANDBOX_MODE = "local";
  process.env.VM_TOKEN_SECRET = "vm-token-secret";

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();
  const { createApp } = await import("../app.js");
  const { closePools } = await import("../db/index.js");

  return {
    app: createApp(),
    async cleanup() {
      await closePools();
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
    },
  };
}

describe("internal routes integration", () => {
  beforeEach(async () => {
    await clearCoreTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("rate-limits bootstrap credentials per agent with Retry-After", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
    });

    try {
      const createAgent = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Internal Route Test Agent" });
      expect(createAgent.status).toBe(201);
      const agentId = createAgent.body.agent.id as string;

      await getTestPool().query(
        "UPDATE agents SET desired_vm_state = 'running', observed_vm_state = 'starting' WHERE id = $1",
        [agentId],
      );

      for (let i = 0; i < 24; i++) {
        const response = await request(runtime.app)
          .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
          .set("x-sandbox-bootstrap-secret", "bootstrap-secret");
        expect(response.status).toBe(200);
        expect(typeof response.body.vmToken).toBe("string");
      }

      const limited = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");

      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();
      expect(limited.body.error).toBe("Rate limit exceeded");
    } finally {
      await runtime.cleanup();
    }
  });

  it("allows local VM bootstrap and internal goal APIs when lifecycle is stopped", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
    });

    try {
      const createAgent = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Local Lifecycle Bypass Agent" });
      expect(createAgent.status).toBe(201);
      const agentId = createAgent.body.agent.id as string;

      const issued = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");
      expect(issued.status).toBe(200);
      const token = issued.body.vmToken as string;
      expect(token).toBeTruthy();

      const activeGoals = await request(runtime.app)
        .get(`/api/internal/agents/${agentId}/goals/active`)
        .set("Authorization", `Bearer ${token}`);
      expect(activeGoals.status).toBe(200);
      expect(Array.isArray(activeGoals.body.goals)).toBe(true);

      const heartbeat = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/stream-heartbeat`)
        .set("Authorization", `Bearer ${token}`);
      expect(heartbeat.status).toBe(204);

      const row = await getTestPool().query<{
        desired_vm_state: string;
        active_stream_lease_until: Date | null;
      }>(
        `SELECT desired_vm_state, active_stream_lease_until
         FROM agents
         WHERE id = $1`,
        [agentId],
      );
      expect(row.rows[0]?.desired_vm_state).toBe("stopped");
      const lease = row.rows[0]?.active_stream_lease_until;
      expect(lease).toBeTruthy();
      expect((lease as Date).getTime()).toBeGreaterThan(Date.now());
    } finally {
      await runtime.cleanup();
    }
  });

  it("suppresses active-goal listing while deploy drain mode is active", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "internal-drain-"));
    const drainFlagPath = path.join(tmpDir, ".deploy-draining");
    writeFileSync(drainFlagPath, "1", "utf8");

    const runtime = await createFreshApp({
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
      DEPLOY_DRAIN_FLAG_FILE: drainFlagPath,
    });

    try {
      const createAgent = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Drain List Active Goals Agent" });
      expect(createAgent.status).toBe(201);
      const agentId = createAgent.body.agent.id as string;

      await getTestPool().query(
        `UPDATE agents
         SET desired_vm_state = 'running',
             observed_vm_state = 'running'
         WHERE id = $1`,
        [agentId],
      );

      const issued = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");
      expect(issued.status).toBe(200);
      const token = issued.body.vmToken as string;
      expect(token).toBeTruthy();

      const userId = await getDefaultUserId();
      const sessionId = randomUUID();
      await getTestPool().query(
        `INSERT INTO agent_chat_sessions (id, agent_id, created_by)
         VALUES ($1, $2, $3)`,
        [sessionId, agentId, userId],
      );
      await getTestPool().query(
        `INSERT INTO agent_session_goals (
           session_id, created_by, goal, guidance, output_folder, status
         ) VALUES ($1, $2, $3, $4, $5, 'active')`,
        [sessionId, userId, "Publish report", "Keep it concise", "out"],
      );

      const activeGoals = await request(runtime.app)
        .get(`/api/internal/agents/${agentId}/goals/active`)
        .set("Authorization", `Bearer ${token}`);

      expect(activeGoals.status).toBe(200);
      expect(activeGoals.body.goals).toEqual([]);
    } finally {
      await runtime.cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("marks agent running on vm-ready callback with a valid VM token", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
    });

    try {
      const createAgent = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "VM Ready Agent" });
      expect(createAgent.status).toBe(201);
      const agentId = createAgent.body.agent.id as string;

      await getTestPool().query(
        `UPDATE agents
         SET desired_vm_state = 'running',
             observed_vm_state = 'starting',
             last_provision_error = 'old error',
             reconcile_attempt_count = 3
         WHERE id = $1`,
        [agentId],
      );

      const issued = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");
      expect(issued.status).toBe(200);
      const token = issued.body.vmToken as string;
      expect(token).toBeTruthy();

      const callback = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/vm-ready`)
        .set("Authorization", `Bearer ${token}`);
      expect(callback.status).toBe(204);

      const row = await getTestPool().query<{
        observed_vm_state: string;
        last_provision_error: string | null;
        reconcile_attempt_count: number;
      }>(
        `SELECT observed_vm_state, last_provision_error, reconcile_attempt_count
         FROM agents
         WHERE id = $1`,
        [agentId],
      );

      expect(row.rows[0]?.observed_vm_state).toBe("running");
      expect(row.rows[0]?.last_provision_error).toBeNull();
      expect(row.rows[0]?.reconcile_attempt_count).toBe(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("ignores vm-ready callback when desired_vm_state is not running", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
    });

    try {
      const createAgent = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Ignored VM Ready Agent" });
      expect(createAgent.status).toBe(201);
      const agentId = createAgent.body.agent.id as string;

      await getTestPool().query(
        `UPDATE agents
         SET desired_vm_state = 'running',
             observed_vm_state = 'starting'
         WHERE id = $1`,
        [agentId],
      );

      const issued = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");
      expect(issued.status).toBe(200);
      const token = issued.body.vmToken as string;

      await getTestPool().query(
        `UPDATE agents
         SET desired_vm_state = 'stopped'
         WHERE id = $1`,
        [agentId],
      );

      const callback = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/vm-ready`)
        .set("Authorization", `Bearer ${token}`);
      expect(callback.status).toBe(202);
      expect(callback.body.status).toBe("ignored");

      const row = await getTestPool().query<{ observed_vm_state: string }>(
        "SELECT observed_vm_state FROM agents WHERE id = $1",
        [agentId],
      );
      expect(row.rows[0]?.observed_vm_state).toBe("starting");
    } finally {
      await runtime.cleanup();
    }
  });

  it("returns LiteLLM runtime env in bootstrap payload", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
      GEMINI_API_KEY: undefined,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      AWS_SESSION_TOKEN: undefined,
      AWS_REGION: undefined,
      LITELLM_PROXY_URL: "https://proxy.example.com/v1",
      LITELLM_PROXY_API_KEY: "proxy-key",
      LITELLM_MODEL_GEMINI: "gemini-proxy",
      LITELLM_MODEL_SONNET: "sonnet-proxy",
      LITELLM_MODEL_OPUS: "opus-proxy",
      LITELLM_MODEL_GPT: "gpt-proxy",
    });

    try {
      const createAgent = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Bootstrap Env Agent" });
      expect(createAgent.status).toBe(201);
      const agentId = createAgent.body.agent.id as string;

      await getTestPool().query(
        "UPDATE agents SET desired_vm_state = 'running', observed_vm_state = 'starting' WHERE id = $1",
        [agentId],
      );

      const response = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");

      expect(response.status).toBe(200);
      expect(response.body.runtimeEnv).toMatchObject({
        LITELLM_PROXY_URL: "https://proxy.example.com/v1",
        LITELLM_MODEL_GEMINI: "gemini-proxy",
        LITELLM_MODEL_SONNET: "sonnet-proxy",
        LITELLM_MODEL_OPUS: "opus-proxy",
        LITELLM_MODEL_GPT: "gpt-proxy",
        LITELLM_PROXY_API_KEY: "proxy-key",
      });
      expect(response.body.providerEnv).toEqual(response.body.runtimeEnv);
    } finally {
      await runtime.cleanup();
    }
  });

  it("refreshes stream lease with internal heartbeat", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
    });

    try {
      const createAgent = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Heartbeat Agent" });
      expect(createAgent.status).toBe(201);
      const agentId = createAgent.body.agent.id as string;

      await getTestPool().query(
        `UPDATE agents
         SET desired_vm_state = 'running',
             observed_vm_state = 'running'
         WHERE id = $1`,
        [agentId],
      );

      const issued = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");
      expect(issued.status).toBe(200);
      const token = issued.body.vmToken as string;

      const heartbeat = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/stream-heartbeat`)
        .set("Authorization", `Bearer ${token}`);
      expect(heartbeat.status).toBe(204);

      const row = await getTestPool().query<{
        active_stream_lease_until: Date | null;
      }>("SELECT active_stream_lease_until FROM agents WHERE id = $1", [
        agentId,
      ]);
      const lease = row.rows[0]?.active_stream_lease_until;
      expect(lease).toBeTruthy();
      expect((lease as Date).getTime()).toBeGreaterThan(Date.now());
    } finally {
      await runtime.cleanup();
    }
  });

  it("supports internal goal lifecycle endpoints for VM session manager", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
    });

    try {
      const createAgent = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Goal Lifecycle Agent" });
      expect(createAgent.status).toBe(201);
      const agentId = createAgent.body.agent.id as string;

      await getTestPool().query(
        `UPDATE agents
         SET desired_vm_state = 'running',
             observed_vm_state = 'running'
         WHERE id = $1`,
        [agentId],
      );

      const issued = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");
      expect(issued.status).toBe(200);
      const token = issued.body.vmToken as string;

      const userId = await getDefaultUserId();
      const sessionId = randomUUID();
      const goalId = randomUUID();

      await getTestPool().query(
        `INSERT INTO agent_chat_sessions (id, agent_id, created_by)
         VALUES ($1, $2, $3)`,
        [sessionId, agentId, userId],
      );
      await getTestPool().query(
        `INSERT INTO agent_chat_messages (session_id, user_id, role, content)
         VALUES
           ($1, $2, 'user', 'Please make progress.'),
           ($1, NULL, 'assistant', 'Starting now.')`,
        [sessionId, userId],
      );
      await getTestPool().query(
        `INSERT INTO agent_session_goals (
           id, session_id, created_by, goal, guidance, output_folder,
           status, next_suggested_run_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW() - INTERVAL '1 minute')`,
        [
          goalId,
          sessionId,
          userId,
          "Finish a reproducible research brief",
          "Keep methods and citations explicit.",
          "research/output",
        ],
      );

      const activeGoals = await request(runtime.app)
        .get(`/api/internal/agents/${agentId}/goals/active`)
        .set("Authorization", `Bearer ${token}`);
      expect(activeGoals.status).toBe(200);
      expect(activeGoals.body.goals).toHaveLength(1);
      expect(activeGoals.body.goals[0].id).toBe(goalId);

      const sessionGoal = await request(runtime.app)
        .get(`/api/internal/agents/${agentId}/sessions/${sessionId}/goal`)
        .set("Authorization", `Bearer ${token}`);
      expect(sessionGoal.status).toBe(200);
      expect(sessionGoal.body.goal.id).toBe(goalId);

      const bootstrap = await request(runtime.app)
        .get(`/api/internal/agents/${agentId}/sessions/${sessionId}/bootstrap`)
        .set("Authorization", `Bearer ${token}`);
      expect(bootstrap.status).toBe(200);
      expect(typeof bootstrap.body.systemPrompt).toBe("string");
      expect(Array.isArray(bootstrap.body.chatHistory)).toBe(true);
      expect(bootstrap.body.chatHistory).toHaveLength(2);

      const publishLiveEvent = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/sessions/${sessionId}/live-events`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({
          event: {
            type: "text",
            data: "background progress",
            source: "goal_background",
          },
        });
      expect(publishLiveEvent.status).toBe(202);

      const appendAssistant = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/sessions/${sessionId}/messages/append-assistant`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({
          content: "Autonomous run update",
          toolCalls: [],
          segments: [{ type: "text", content: "Autonomous run update" }],
        });
      expect(appendAssistant.status).toBe(201);

      const largeContent = "L".repeat(220_000);
      const appendLargeAssistant = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/sessions/${sessionId}/messages/append-assistant`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({
          content: largeContent,
          toolCalls: [
            {
              name: "web_fetch",
              args: { url: "https://example.com" },
              result: {
                content: [{ type: "text", text: "R".repeat(25_000) }],
              },
            },
          ],
          segments: [
            { type: "text", content: largeContent },
            {
              type: "tool",
              name: "web_fetch",
              result: {
                content: [{ type: "text", text: "R".repeat(25_000) }],
              },
            },
          ],
        });
      expect(appendLargeAssistant.status).toBe(201);

      const startRun = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/goals/${goalId}/runs`)
        .set("Authorization", `Bearer ${token}`)
        .send({ runType: "background", trigger: "reconciler" });
      expect(startRun.status).toBe(201);
      const runId = startRun.body.run.id as string;
      expect(runId).toBeTruthy();

      const startBackgroundTurn = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/sessions/${sessionId}/background-turn/start`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(startBackgroundTurn.status).toBe(201);
      const backgroundTurnId = startBackgroundTurn.body.turnId as string;
      expect(backgroundTurnId).toBeTruthy();

      const runningBackgroundTurn = await request(runtime.app).get(
        `/api/agent-chat/sessions/${sessionId}/running-turn`,
      );
      expect(runningBackgroundTurn.status).toBe(200);
      expect(runningBackgroundTurn.body.turnId).toBe(backgroundTurnId);
      expect(runningBackgroundTurn.body.source).toBe("goal_background");

      const checkpointPayload = "C".repeat(20_000);
      const appendBackgroundEvent = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/sessions/${sessionId}/background-turn/${backgroundTurnId}/event`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({
          event: {
            type: "text",
            data: {
              mode: "replace",
              text: checkpointPayload,
              blockIndex: 0,
            },
          },
        });
      expect(appendBackgroundEvent.status).toBe(202);
      expect(typeof appendBackgroundEvent.body.seq).toBe("number");

      await vi.waitFor(
        async () => {
          const checkpointRow = await getTestPool().query<{ turn_id: string }>(
            `SELECT turn_id
             FROM agent_chat_turn_checkpoints
             WHERE session_id = $1
               AND turn_id = $2
             LIMIT 1`,
            [sessionId, backgroundTurnId],
          );
          expect(checkpointRow.rows[0]?.turn_id).toBe(backgroundTurnId);
        },
        { timeout: 7_000 },
      );

      const complete = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/goals/${goalId}/complete`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(complete.status).toBe(200);
      expect(complete.body.goal.report_path).toBeNull();
      expect(complete.body.goal.status).toBe("active");
      expect(complete.body.goal.status_reason).toBe("completion_requested");

      const finalizeBackgroundTurn = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/sessions/${sessionId}/background-turn/${backgroundTurnId}/finalize`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({
          status: "completed",
          content: "Autonomous run update",
          toolCalls: [
            {
              name: "complete_goal",
              args: {},
              result: { ok: true, status: "completed" },
              error: false,
            },
          ],
          segments: [
            { type: "text", content: "Autonomous run update" },
            {
              type: "tool",
              name: "complete_goal",
              result: { ok: true, status: "completed" },
              error: false,
            },
          ],
        });
      expect(finalizeBackgroundTurn.status).toBe(204);

      await vi.waitFor(async () => {
        const checkpointRow = await getTestPool().query<{ turn_id: string }>(
          `SELECT turn_id
           FROM agent_chat_turn_checkpoints
           WHERE session_id = $1
             AND turn_id = $2
           LIMIT 1`,
          [sessionId, backgroundTurnId],
        );
        expect(checkpointRow.rows.length).toBe(0);
      });

      const finishRun = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/goals/${goalId}/runs/${runId}/end`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "completed" });
      expect(finishRun.status).toBe(204);

      const goalRow = await getTestPool().query<{
        run_count: number;
        status: string;
        last_run_started_at: Date | null;
        last_run_ended_at: Date | null;
        completed_at: Date | null;
      }>(
        `SELECT run_count, status, last_run_started_at, last_run_ended_at, completed_at
         FROM agent_session_goals
         WHERE id = $1`,
        [goalId],
      );
      expect(goalRow.rows[0]?.run_count).toBe(1);
      expect(goalRow.rows[0]?.status).toBe("completed");
      expect(goalRow.rows[0]?.last_run_started_at).toBeTruthy();
      expect(goalRow.rows[0]?.last_run_ended_at).toBeTruthy();
      expect(goalRow.rows[0]?.completed_at).toBeTruthy();

      const runRow = await getTestPool().query<{ status: string }>(
        `SELECT status
         FROM agent_session_goal_runs
         WHERE id = $1`,
        [runId],
      );
      expect(runRow.rows[0]?.status).toBe("completed");

      const goalUpdateMessages = await getTestPool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM agent_chat_messages
         WHERE session_id = $1
           AND role = 'assistant'
           AND content LIKE '### Goal Update%'`,
        [sessionId],
      );
      expect(Number(goalUpdateMessages.rows[0]?.count || "0")).toBe(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects live-events publish when session belongs to another agent", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
    });

    try {
      const createAgentA = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Live Events Owner Agent" });
      expect(createAgentA.status).toBe(201);
      const agentAId = createAgentA.body.agent.id as string;

      const createAgentB = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Live Events Caller Agent" });
      expect(createAgentB.status).toBe(201);
      const agentBId = createAgentB.body.agent.id as string;

      const issuedForAgentB = await request(runtime.app)
        .post(`/api/internal/agents/${agentBId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");
      expect(issuedForAgentB.status).toBe(200);
      const tokenForAgentB = issuedForAgentB.body.vmToken as string;
      expect(tokenForAgentB).toBeTruthy();

      const userId = await getDefaultUserId();
      const sessionId = randomUUID();
      await getTestPool().query(
        `INSERT INTO agent_chat_sessions (id, agent_id, created_by)
         VALUES ($1, $2, $3)`,
        [sessionId, agentAId, userId],
      );

      const response = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentBId}/sessions/${sessionId}/live-events`,
        )
        .set("Authorization", `Bearer ${tokenForAgentB}`)
        .send({
          event: {
            type: "text",
            data: "should not be accepted",
          },
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Session not found");
    } finally {
      await runtime.cleanup();
    }
  });

  it("sanitizes unsafe unicode in background turn payloads before persistence", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
    });

    try {
      const createAgent = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Unicode Sanitizer Agent" });
      expect(createAgent.status).toBe(201);
      const agentId = createAgent.body.agent.id as string;

      const issued = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");
      expect(issued.status).toBe(200);
      const token = issued.body.vmToken as string;
      expect(token).toBeTruthy();

      const userId = await getDefaultUserId();
      const sessionId = randomUUID();
      await getTestPool().query(
        `INSERT INTO agent_chat_sessions (id, agent_id, created_by)
         VALUES ($1, $2, $3)`,
        [sessionId, agentId, userId],
      );

      const started = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/sessions/${sessionId}/background-turn/start`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(started.status).toBe(201);
      const turnId = started.body.turnId as string;
      expect(turnId).toBeTruthy();

      const appendToolCall = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/sessions/${sessionId}/background-turn/${turnId}/event`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({
          event: {
            type: "tool_call",
            data: {
              name: "bash",
              args: { command: "echo unsafe" },
            },
          },
        });
      expect(appendToolCall.status).toBe(202);

      const appendToolResult = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/sessions/${sessionId}/background-turn/${turnId}/event`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({
          event: {
            type: "tool_result",
            data: {
              name: "bash",
              result: {
                content: [
                  {
                    type: "text",
                    text: `prefix${"\u0000"}middle${"\uD800"}suffix`,
                  },
                ],
              },
            },
          },
        });
      expect(appendToolResult.status).toBe(202);

      const finalized = await request(runtime.app)
        .post(
          `/api/internal/agents/${agentId}/sessions/${sessionId}/background-turn/${turnId}/finalize`,
        )
        .set("Authorization", `Bearer ${token}`)
        .send({
          status: "completed",
        });
      expect(finalized.status).toBe(204);

      const assistantRow = await getTestPool().query<{ tool_calls: string }>(
        `SELECT tool_calls::text AS tool_calls
         FROM agent_chat_messages
         WHERE session_id = $1
           AND role = 'assistant'
         ORDER BY created_at DESC
         LIMIT 1`,
        [sessionId],
      );
      expect(assistantRow.rows.length).toBe(1);
      const payload = assistantRow.rows[0]?.tool_calls || "";
      expect(payload).not.toContain("\\u0000");
      expect(payload).not.toContain("\\ud800");
      expect(payload).toContain("prefix");
      expect(payload).toContain("suffix");
    } finally {
      await runtime.cleanup();
    }
  });

  it("expires past-due goals when active goals are fetched", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      VM_BOOTSTRAP_SECRET: "bootstrap-secret",
    });

    try {
      const createAgent = await request(runtime.app)
        .post("/api/agents")
        .send({ name: "Goal Expiry Agent" });
      expect(createAgent.status).toBe(201);
      const agentId = createAgent.body.agent.id as string;

      await getTestPool().query(
        `UPDATE agents
         SET desired_vm_state = 'running',
             observed_vm_state = 'running'
         WHERE id = $1`,
        [agentId],
      );

      const issued = await request(runtime.app)
        .post(`/api/internal/agents/${agentId}/bootstrap-credentials`)
        .set("x-sandbox-bootstrap-secret", "bootstrap-secret");
      expect(issued.status).toBe(200);
      const token = issued.body.vmToken as string;

      const userId = await getDefaultUserId();
      const sessionId = randomUUID();
      const goalId = randomUUID();

      await getTestPool().query(
        `INSERT INTO agent_chat_sessions (id, agent_id, created_by)
         VALUES ($1, $2, $3)`,
        [sessionId, agentId, userId],
      );
      await getTestPool().query(
        `INSERT INTO agent_session_goals (
           id, session_id, created_by, goal, guidance, output_folder,
           status, deadline_at, next_suggested_run_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           'active', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute'
         )`,
        [goalId, sessionId, userId, "Expired goal", "", "expired/output"],
      );

      const activeGoals = await request(runtime.app)
        .get(`/api/internal/agents/${agentId}/goals/active`)
        .set("Authorization", `Bearer ${token}`);
      expect(activeGoals.status).toBe(200);
      expect(activeGoals.body.goals).toHaveLength(0);

      const row = await getTestPool().query<{
        status: string;
        status_reason: string | null;
      }>(
        `SELECT status, status_reason
         FROM agent_session_goals
         WHERE id = $1`,
        [goalId],
      );
      expect(row.rows[0]?.status).toBe("expired");
      expect(row.rows[0]?.status_reason).toBe("deadline_passed");
    } finally {
      await runtime.cleanup();
    }
  });
});
