import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  clearCoreTables,
  closeTestPool,
  getDefaultOrgId,
  getDefaultUserId,
  getTestPool,
} from "../test/db-helper.js";

async function createChatFixture() {
  const orgId = await getDefaultOrgId();
  const userId = await getDefaultUserId();
  const agentId = randomUUID();

  await getTestPool().query(
    `INSERT INTO agents (id, org_id, name, description, icon, system_prompt)
     VALUES ($1, $2, 'Chat Fixture Agent', '', '🔬', 'You are helpful.')`,
    [agentId, orgId],
  );
  await getTestPool().query(
    `INSERT INTO agent_access (agent_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [agentId, userId],
  );

  return { agentId, orgId };
}

async function createChatSessionFixture() {
  const { agentId } = await createChatFixture();
  const userId = await getDefaultUserId();
  const sessionId = randomUUID();

  await getTestPool().query(
    `INSERT INTO agent_chat_sessions (id, agent_id, created_by)
     VALUES ($1, $2, $3)`,
    [sessionId, agentId, userId],
  );

  return { agentId, sessionId, userId };
}

const app = createApp();

async function createFreshAppWithSandboxMock(options?: {
  envOverrides?: Record<string, string | undefined>;
  chatStreamMock?: (...args: unknown[]) => Promise<Response>;
  ensureSandboxMock?: (...args: unknown[]) => Promise<{
    status: "ready" | "starting";
    reason?: string;
    retryAfterMs?: number;
  }>;
}) {
  const envKeys = [
    "NODE_ENV",
    "AUTH_PROVIDER",
    "DATABASE_URL",
    "APP_DATABASE_URL",
    "PUBLIC_URL",
    "SANDBOX_MODE",
    "DEPLOY_DRAIN_FLAG_FILE",
    "SANDBOX_STREAM_LEASE_REFRESH_MS",
    "SANDBOX_STREAM_LEASE_TTL_MS",
    "CHAT_RESUMABLE_STREAM",
  ] as const;
  const previous: Record<string, string | undefined> = {};
  for (const key of envKeys) {
    previous[key] = process.env[key];
  }

  const integrationDb =
    process.env.INTEGRATION_DATABASE_URL ||
    "postgresql://mines_ai:mines_ai_password@localhost:5435/mines_ai_integration";
  process.env.NODE_ENV = "test";
  process.env.AUTH_PROVIDER = "none";
  process.env.DATABASE_URL = integrationDb;
  process.env.APP_DATABASE_URL = integrationDb;
  process.env.PUBLIC_URL = "http://localhost:5173";
  process.env.SANDBOX_MODE = "gce";
  for (const [key, value] of Object.entries(options?.envOverrides || {})) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();
  vi.doMock("../services/sandbox/client.js", async () => {
    const actual = await vi.importActual<
      typeof import("../services/sandbox/client.js")
    >("../services/sandbox/client.js");
    return {
      ...actual,
      ensureSandbox:
        options?.ensureSandboxMock ||
        vi.fn().mockResolvedValue({ status: "ready" }),
      chatStream:
        options?.chatStreamMock ||
        vi.fn().mockRejectedValue(
          Object.assign(new TypeError("terminated"), {
            cause: { code: "UND_ERR_SOCKET" },
          }),
        ),
    };
  });

  const { createApp: createRuntimeApp } = await import("../app.js");
  const { closePools } = await import("../db/index.js");

  return {
    app: createRuntimeApp(),
    async cleanup() {
      await closePools();
      vi.doUnmock("../services/sandbox/client.js");
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

function createSseResponse(events: unknown[], delayMs = 0): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      controller.close();
    },
  });
  return new Response(stream);
}

function createAbortAwareSseResponse(signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: {"type":"text","data":"partial before stop"}\n\n`,
        ),
      );

      let tick = 0;
      while (tick < 50) {
        if (signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        await wait(60);
        tick += 1;
        controller.enqueue(
          encoder.encode(`data: {"type":"text","data":" chunk-${tick}"}\n\n`),
        );
      }

      controller.enqueue(encoder.encode(`data: {"type":"done"}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createOpenEndedSseResponse(
  chunk: string,
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "text", data: chunk })}\n\n`,
        ),
      );

      while (true) {
        if (signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        await wait(50);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createToolOnlyOpenEndedSseResponse(signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "tool_call",
            data: { name: "bash", args: { command: "echo test" } },
          })}\n\n`,
        ),
      );

      while (true) {
        if (signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        await wait(50);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function waitForCondition(
  fn: () => Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const intervalMs = options?.intervalMs ?? 100;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for condition");
}

describe("agent chat routes integration", () => {
  beforeEach(async () => {
    await clearCoreTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("returns empty latest chat when no sessions exist", async () => {
    const orgId = await getDefaultOrgId();
    const defaultUserId = await getDefaultUserId();
    const agentId = randomUUID();
    const pool = getTestPool();

    await pool.query(
      `INSERT INTO agents (id, org_id, name, description, icon, system_prompt)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agentId, orgId, "Empty Chat Agent", "", "🔬", "test prompt"],
    );

    await pool.query(
      `INSERT INTO agent_access (agent_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [agentId, defaultUserId],
    );

    const response = await request(app).get(
      `/api/agent-chat/${agentId}/latest`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sessionId: null, messages: [] });
  });

  it("persists selected model per session", async () => {
    const { agentId } = await createChatFixture();
    const defaultUserId = await getDefaultUserId();
    const pool = getTestPool();

    const createResponse = await request(app)
      .post(`/api/agent-chat/${agentId}/sessions`)
      .send({ title: "Model persistence", model: "opus-4.6" });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.session.model).toBe("opus-4.6");
    const sessionId = String(createResponse.body.session.id);

    const listResponse = await request(app).get(
      `/api/agent-chat/${agentId}/sessions`,
    );
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.sessions[0]?.id).toBe(sessionId);
    expect(listResponse.body.sessions[0]?.model).toBe("opus-4.6");

    const updateResponse = await request(app)
      .patch(`/api/agent-chat/sessions/${sessionId}`)
      .send({ model: "gpt-5.2" });
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.session.model).toBe("gpt-5.2");

    const dbCheck = await pool.query(
      `SELECT model
         FROM agent_chat_sessions
        WHERE id = $1
          AND created_by = $2`,
      [sessionId, defaultUserId],
    );
    expect(dbCheck.rows[0]?.model).toBe("gpt-5.2");
  });

  it("returns latest session and session messages", async () => {
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const orgId = await getDefaultOrgId();
    const defaultUserId = await getDefaultUserId();
    const pool = getTestPool();

    await pool.query(
      `INSERT INTO agents (id, org_id, name, description, icon, system_prompt)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agentId, orgId, "Chat Agent", "", "🔬", "test prompt"],
    );

    await pool.query(
      `INSERT INTO agent_access (agent_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [agentId, defaultUserId],
    );

    await pool.query(
      `INSERT INTO agent_chat_sessions (id, agent_id, created_by)
       VALUES ($1, $2, $3)`,
      [sessionId, agentId, defaultUserId],
    );

    await pool.query(
      `INSERT INTO agent_chat_messages (session_id, user_id, role, content)
       VALUES ($1, $2, 'user', 'hello'), ($1, NULL, 'assistant', 'hi there')`,
      [sessionId, defaultUserId],
    );

    const latest = await request(app).get(`/api/agent-chat/${agentId}/latest`);
    expect(latest.status).toBe(200);
    expect(latest.body.sessionId).toBe(sessionId);
    expect(latest.body.messages).toHaveLength(2);

    const messages = await request(app).get(
      `/api/agent-chat/sessions/${sessionId}/messages`,
    );
    expect(messages.status).toBe(200);
    expect(messages.body.messages).toHaveLength(2);
    expect(messages.body.messages[0].role).toBe("user");
    expect(messages.body.messages[1].role).toBe("assistant");
  });

  it("returns 503 with retryAfterMs when sandbox is still starting", async () => {
    // SANDBOX_MODE=local (the default). Port 8888 is not running in the test
    // environment, so ensureSandbox() health-probe fails and returns "starting".
    // The chat endpoint must propagate that as a 503 — not hang or crash.
    const { agentId } = await createChatFixture();

    const response = await request(app)
      .post(`/api/agent-chat/${agentId}/chat`)
      .send({ message: "hello" });

    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("vm_starting");
    expect(typeof response.body.retryAfterMs).toBe("number");
    expect(response.body.retryAfterMs).toBeGreaterThan(0);
  });

  it("starts resumable chat turns and replays buffered stream events", async () => {
    const runtime = await createFreshAppWithSandboxMock({
      envOverrides: {
        CHAT_RESUMABLE_STREAM: "true",
      },
      chatStreamMock: vi
        .fn()
        .mockResolvedValue(
          createSseResponse([
            { type: "text", data: "hello from resumable" },
            { type: "done" },
          ]),
        ),
    });
    try {
      const { agentId } = await createChatFixture();
      const start = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat/start`)
        .send({ message: "hello" });

      expect(start.status).toBe(200);
      expect(typeof start.body.sessionId).toBe("string");
      expect(typeof start.body.turnId).toBe("string");

      const stream = await request(runtime.app).get(
        `/api/agent-chat/sessions/${start.body.sessionId}/turns/${start.body.turnId}/stream?fromSeq=1`,
      );
      expect(stream.status).toBe(200);
      expect(stream.text).toContain('"type":"session"');
      expect(stream.text).toContain('"type":"text"');
      expect(stream.text).toContain('"type":"done"');
      const doneEvents = (stream.text.match(/"type":"done"/g) || []).length;
      expect(doneEvents).toBe(1);

      const messages = await getTestPool().query(
        `SELECT role, content
           FROM agent_chat_messages
          WHERE session_id = $1
          ORDER BY created_at ASC`,
        [start.body.sessionId],
      );
      if (messages.rows.length < 2) {
        await waitForCondition(async () => {
          const refreshed = await getTestPool().query(
            `SELECT role, content
               FROM agent_chat_messages
              WHERE session_id = $1
              ORDER BY created_at ASC`,
            [start.body.sessionId],
          );
          return refreshed.rows.length >= 2;
        });
      }
      const finalMessages = await getTestPool().query(
        `SELECT role, content
           FROM agent_chat_messages
          WHERE session_id = $1
          ORDER BY created_at ASC`,
        [start.body.sessionId],
      );
      expect(finalMessages.rows.length).toBe(2);
      expect(finalMessages.rows[0].role).toBe("user");
      expect(finalMessages.rows[1].role).toBe("assistant");
      expect(finalMessages.rows[1].content).toContain("hello from resumable");
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await runtime.cleanup();
    }
  });

  it("exposes checkpointed partial output and deletes checkpoint after turn completion", async () => {
    const largeChunk = "A".repeat(20_000);
    const runtime = await createFreshAppWithSandboxMock({
      envOverrides: {
        CHAT_RESUMABLE_STREAM: "true",
      },
      chatStreamMock: vi
        .fn()
        .mockImplementation((...args: unknown[]) =>
          Promise.resolve(
            createOpenEndedSseResponse(
              largeChunk,
              args[4] as AbortSignal | undefined,
            ),
          ),
        ),
    });

    try {
      const { agentId } = await createChatFixture();
      const start = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat/start`)
        .send({ message: "long turn please" });

      expect(start.status).toBe(200);
      const sessionId = String(start.body.sessionId);
      const turnId = String(start.body.turnId);
      expect(sessionId).toBeTruthy();
      expect(turnId).toBeTruthy();

      await waitForCondition(async () => {
        const running = await request(runtime.app).get(
          `/api/agent-chat/sessions/${sessionId}/running-turn`,
        );
        return (
          running.status === 200 &&
          running.body.turnId === turnId &&
          running.body.source === "foreground"
        );
      });

      await waitForCondition(async () => {
        const snapshot = await request(runtime.app).get(
          `/api/agent-chat/sessions/${sessionId}/turns/${turnId}/snapshot`,
        );
        return (
          snapshot.status === 200 &&
          typeof snapshot.body?.snapshot?.assistantContent === "string" &&
          snapshot.body.snapshot.assistantContent.length > 0
        );
      });

      const snapshotResponse = await request(runtime.app).get(
        `/api/agent-chat/sessions/${sessionId}/turns/${turnId}/snapshot`,
      );
      expect(snapshotResponse.status).toBe(200);
      expect(snapshotResponse.body.snapshot.turnId).toBe(turnId);
      expect(snapshotResponse.body.snapshot.status).toBe("running");
      expect(
        snapshotResponse.body.snapshot.assistantContent.length,
      ).toBeGreaterThan(1_000);

      await waitForCondition(async () => {
        const response = await request(runtime.app).get(
          `/api/agent-chat/sessions/${sessionId}/messages`,
        );
        if (response.status !== 200) return false;
        if (response.body.runningTurnId !== turnId) return false;
        const checkpoint = (response.body.messages as Array<any>).find(
          (message) => String(message.id || "").startsWith("checkpoint-"),
        );
        return Boolean(
          checkpoint && String(checkpoint.content || "").length > 1_000,
        );
      });

      const messagesResponse = await request(runtime.app).get(
        `/api/agent-chat/sessions/${sessionId}/messages`,
      );
      expect(messagesResponse.status).toBe(200);
      expect(messagesResponse.body.runningTurnId).toBe(turnId);
      const checkpointMessage = (
        messagesResponse.body.messages as Array<any>
      ).find((message) => String(message.id || "").startsWith("checkpoint-"));
      expect(checkpointMessage).toBeTruthy();
      expect(String(checkpointMessage.content || "").length).toBeGreaterThan(
        1_000,
      );
      expect(checkpointMessage.partial).toBe(true);
      expect(typeof checkpointMessage.last_seq).toBe("number");
      expect(checkpointMessage.last_seq).toBeGreaterThan(0);

      const cancel = await request(runtime.app).post(
        `/api/agent-chat/sessions/${sessionId}/turns/${turnId}/cancel`,
      );
      expect(cancel.status).toBe(202);

      await waitForCondition(async () => {
        const running = await request(runtime.app).get(
          `/api/agent-chat/sessions/${sessionId}/running-turn`,
        );
        return running.status === 200 && running.body.turnId === null;
      });

      await waitForCondition(async () => {
        const row = await getTestPool().query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM agent_chat_turn_checkpoints
            WHERE session_id = $1
              AND turn_id = $2`,
          [sessionId, turnId],
        );
        return Number(row.rows[0]?.count || "0") === 0;
      });
    } finally {
      await runtime.cleanup();
    }
  });

  it("returns running turn id on resumable start conflicts", async () => {
    const runtime = await createFreshAppWithSandboxMock({
      envOverrides: {
        CHAT_RESUMABLE_STREAM: "true",
      },
      chatStreamMock: vi
        .fn()
        .mockResolvedValue(
          createSseResponse([{ type: "text", data: "still running" }], 200),
        ),
    });
    try {
      const { agentId } = await createChatFixture();
      const first = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat/start`)
        .send({ message: "one" });
      expect(first.status).toBe(200);

      const second = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat/start`)
        .send({ message: "two", sessionId: first.body.sessionId });

      expect(second.status).toBe(409);
      expect(second.body.reason).toBe("session_busy");
      expect(second.body.sessionId).toBe(first.body.sessionId);
      expect(second.body.turnId).toBe(first.body.turnId);

      // Drain the running turn so background work finishes before cleanup.
      await request(runtime.app).get(
        `/api/agent-chat/sessions/${first.body.sessionId}/turns/${first.body.turnId}/stream?fromSeq=1`,
      );
    } finally {
      await runtime.cleanup();
    }
  });

  it("persists partial assistant output when a resumable turn is cancelled", async () => {
    const runtime = await createFreshAppWithSandboxMock({
      envOverrides: {
        CHAT_RESUMABLE_STREAM: "true",
      },
      chatStreamMock: vi
        .fn()
        .mockImplementation((...args: unknown[]) =>
          Promise.resolve(
            createAbortAwareSseResponse(args[4] as AbortSignal | undefined),
          ),
        ),
    });
    try {
      const { agentId } = await createChatFixture();
      const start = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat/start`)
        .send({ message: "cancel me" });

      expect(start.status).toBe(200);
      const startedSessionId = start.body.sessionId as string;
      const startedTurnId = start.body.turnId as string;
      expect(startedSessionId).toBeTruthy();
      expect(startedTurnId).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 180));

      const cancel = await request(runtime.app).post(
        `/api/agent-chat/sessions/${startedSessionId}/turns/${startedTurnId}/cancel`,
      );
      expect(cancel.status).toBe(202);

      let runningTurnId: string | null = startedTurnId;
      for (let i = 0; i < 80 && runningTurnId; i += 1) {
        const running = await request(runtime.app).get(
          `/api/agent-chat/sessions/${startedSessionId}/running-turn`,
        );
        expect(running.status).toBe(200);
        runningTurnId =
          typeof running.body.turnId === "string" ? running.body.turnId : null;
        if (!runningTurnId) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(runningTurnId).toBeNull();

      const persistedMessages = await getTestPool().query<{
        role: string;
        content: string;
      }>(
        `SELECT role, content
           FROM agent_chat_messages
          WHERE session_id = $1
          ORDER BY created_at ASC`,
        [startedSessionId],
      );
      const assistantMessage = persistedMessages.rows.find(
        (row) => row.role === "assistant",
      );
      expect(
        assistantMessage,
        JSON.stringify(persistedMessages.rows),
      ).toBeTruthy();
      expect(assistantMessage?.content || "").toMatch(
        /(partial before stop|chunk-\d+)/,
      );
    } finally {
      await runtime.cleanup();
    }
  });

  it("does not persist an empty assistant message when cancelled before text", async () => {
    const runtime = await createFreshAppWithSandboxMock({
      envOverrides: {
        CHAT_RESUMABLE_STREAM: "true",
      },
      chatStreamMock: vi
        .fn()
        .mockImplementation((...args: unknown[]) =>
          Promise.resolve(
            createToolOnlyOpenEndedSseResponse(
              args[4] as AbortSignal | undefined,
            ),
          ),
        ),
    });
    try {
      const { agentId } = await createChatFixture();
      const start = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat/start`)
        .send({ message: "cancel before text" });

      expect(start.status).toBe(200);
      const startedSessionId = start.body.sessionId as string;
      const startedTurnId = start.body.turnId as string;
      expect(startedSessionId).toBeTruthy();
      expect(startedTurnId).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 160));

      const cancel = await request(runtime.app).post(
        `/api/agent-chat/sessions/${startedSessionId}/turns/${startedTurnId}/cancel`,
      );
      expect(cancel.status).toBe(202);

      await waitForCondition(async () => {
        const running = await request(runtime.app).get(
          `/api/agent-chat/sessions/${startedSessionId}/running-turn`,
        );
        return running.status === 200 && running.body.turnId === null;
      });

      const persistedMessages = await getTestPool().query<{
        role: string;
        content: string;
      }>(
        `SELECT role, content
           FROM agent_chat_messages
          WHERE session_id = $1
          ORDER BY created_at ASC`,
        [startedSessionId],
      );
      const assistantMessages = persistedMessages.rows.filter(
        (row) => row.role === "assistant",
      );
      expect(assistantMessages).toHaveLength(0);
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects new chat turns while deploy drain mode is active", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "deploy-drain-"));
    const drainFlagPath = path.join(tmpDir, ".deploy-draining");
    writeFileSync(drainFlagPath, "1", "utf8");

    const runtime = await createFreshAppWithSandboxMock({
      envOverrides: {
        DEPLOY_DRAIN_FLAG_FILE: drainFlagPath,
      },
    });
    try {
      const { agentId } = await createChatFixture();
      const response = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat`)
        .send({ message: "hello" });

      expect(response.status).toBe(503);
      expect(response.body.reason).toBe("deploy_draining");
      expect(typeof response.body.retryAfterMs).toBe("number");
    } finally {
      await runtime.cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns 502 when sandbox transport disconnects but sandbox is still ready", async () => {
    const runtime = await createFreshAppWithSandboxMock();
    try {
      const { agentId } = await createChatFixture();
      const response = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat`)
        .send({ message: "hello" });

      expect(response.status).toBe(502);
      expect(response.body.error).toContain("transport disconnected");
    } finally {
      await runtime.cleanup();
    }
  });

  it("persists partial assistant output when sandbox stream disconnects mid-turn", async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    const runtime = await createFreshAppWithSandboxMock({
      chatStreamMock: vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pullCount === 0) {
                pullCount += 1;
                controller.enqueue(
                  encoder.encode(`data: {"type":"text","data":"partial"}\n\n`),
                );
                return;
              }
              throw new TypeError("terminated");
            },
            cancel() {
              // no-op
            },
            start() {
              // no-op
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
    });
    try {
      const { agentId } = await createChatFixture();
      const userId = await getDefaultUserId();
      const response = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat`)
        .send({ message: "hello" });

      expect(response.status).toBe(200);
      expect(response.text).toContain("Sandbox transport disconnected");

      const sessionRows = await getTestPool().query<{ id: string }>(
        `SELECT id
           FROM agent_chat_sessions
          WHERE agent_id = $1
            AND created_by = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [agentId, userId],
      );
      const persistedSessionId = sessionRows.rows[0]?.id;
      expect(persistedSessionId).toBeTruthy();

      const persistedMessages = await getTestPool().query<{
        role: string;
        content: string;
      }>(
        `SELECT role, content
           FROM agent_chat_messages
          WHERE session_id = $1
          ORDER BY created_at ASC`,
        [persistedSessionId],
      );
      const assistantMessage = persistedMessages.rows.find(
        (row) => row.role === "assistant",
      );
      expect(
        assistantMessage,
        JSON.stringify(persistedMessages.rows),
      ).toBeTruthy();
      expect(assistantMessage?.content).toContain("partial");
    } finally {
      await runtime.cleanup();
    }
  });

  it("keeps active_stream_lease_until after successful chat completion", async () => {
    const runtime = await createFreshAppWithSandboxMock({
      chatStreamMock: vi.fn().mockResolvedValue(
        new Response(`data: {"type":"text","data":"ok"}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    });
    try {
      const { agentId } = await createChatFixture();
      const response = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat`)
        .send({ message: "hello" });

      expect(response.status).toBe(200);
      const row = await getTestPool().query<{
        active_stream_lease_until: Date;
      }>("SELECT active_stream_lease_until FROM agents WHERE id = $1", [
        agentId,
      ]);
      const lease = row.rows[0]?.active_stream_lease_until;
      expect(lease).toBeTruthy();
      expect(lease.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await runtime.cleanup();
    }
  });

  it("clears the lease refresh interval when chat returns upstream 503", async () => {
    const runtime = await createFreshAppWithSandboxMock({
      envOverrides: {
        SANDBOX_STREAM_LEASE_REFRESH_MS: "50",
        SANDBOX_STREAM_LEASE_TTL_MS: "1000",
      },
      chatStreamMock: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ reason: "vm_starting", retryAfterMs: 50 }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    });
    try {
      const { agentId } = await createChatFixture();
      const response = await request(runtime.app)
        .post(`/api/agent-chat/${agentId}/chat`)
        .send({ message: "hello" });

      expect(response.status).toBe(503);
      const first = await getTestPool().query<{
        active_stream_lease_until: Date;
      }>("SELECT active_stream_lease_until FROM agents WHERE id = $1", [
        agentId,
      ]);
      const firstLease = first.rows[0]?.active_stream_lease_until;
      expect(firstLease).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 220));

      const second = await getTestPool().query<{
        active_stream_lease_until: Date;
      }>("SELECT active_stream_lease_until FROM agents WHERE id = $1", [
        agentId,
      ]);
      const secondLease = second.rows[0]?.active_stream_lease_until;
      expect(secondLease).toBeTruthy();

      const driftMs = secondLease.getTime() - firstLease.getTime();
      expect(driftMs).toBeLessThan(25);
    } finally {
      await runtime.cleanup();
    }
  });

  it("creates, fetches, updates, and cancels a session goal", async () => {
    const { sessionId } = await createChatSessionFixture();
    const createDeadlineIso = new Date(
      Date.now() + 60 * 60 * 1000,
    ).toISOString();
    const updateDeadlineIso = new Date(
      Date.now() + 2 * 60 * 60 * 1000,
    ).toISOString();

    const createResponse = await request(app)
      .put(`/api/agent-chat/sessions/${sessionId}/goal`)
      .send({
        goal: "Produce an experiment-ready literature synthesis",
        guidance: "Prioritize seminal papers and benchmark datasets.",
        deadlineAt: createDeadlineIso,
        outputFolder: "/projects/lit-review/",
      });

    expect(createResponse.status).toBe(200);
    expect(createResponse.body.goal).toBeTruthy();
    expect(createResponse.body.goal.status).toBe("active");
    expect(createResponse.body.goal.output_folder).toBe("projects/lit-review");
    const goalId = createResponse.body.goal.id as string;

    const updateResponse = await request(app)
      .put(`/api/agent-chat/sessions/${sessionId}/goal`)
      .send({
        goal: "Produce an experiment-ready literature synthesis (v2)",
        guidance: "Also include reproducibility notes.",
        deadlineAt: updateDeadlineIso,
        outputFolder: "projects/lit-review-v2",
      });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.goal.id).toBe(goalId);
    expect(updateResponse.body.goal.goal).toContain("(v2)");
    expect(updateResponse.body.goal.output_folder).toBe(
      "projects/lit-review-v2",
    );

    const getResponse = await request(app).get(
      `/api/agent-chat/sessions/${sessionId}/goal`,
    );
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.goal.id).toBe(goalId);
    expect(getResponse.body.goal.status).toBe("active");

    const cancelResponse = await request(app).delete(
      `/api/agent-chat/sessions/${sessionId}/goal`,
    );
    expect(cancelResponse.status).toBe(200);
    expect(cancelResponse.body.goal.status).toBe("cancelled");
    expect(cancelResponse.body.goal.status_reason).toBe("user_cancelled");

    const latestResponse = await request(app).get(
      `/api/agent-chat/sessions/${sessionId}/goal`,
    );
    expect(latestResponse.status).toBe(200);
    expect(latestResponse.body.goal.status).toBe("cancelled");
  });

  it("validates goal upsert payload for deadline and supports workspace-root output folder", async () => {
    const { sessionId } = await createChatSessionFixture();
    const futureIso = new Date(Date.now() + 3_600_000).toISOString();
    const pastIso = new Date(Date.now() - 60_000).toISOString();

    const invalidDeadline = await request(app)
      .put(`/api/agent-chat/sessions/${sessionId}/goal`)
      .send({
        goal: "Write report",
        guidance: "",
        deadlineAt: "not-a-date",
        outputFolder: "outputs",
      });
    expect(invalidDeadline.status).toBe(400);
    expect(invalidDeadline.body.error).toBe("Invalid deadlineAt");

    const pastDeadline = await request(app)
      .put(`/api/agent-chat/sessions/${sessionId}/goal`)
      .send({
        goal: "Write report",
        guidance: "",
        deadlineAt: pastIso,
        outputFolder: "outputs",
      });
    expect(pastDeadline.status).toBe(400);
    expect(pastDeadline.body.error).toBe("deadlineAt must be in the future");

    const rootOutputFolder = await request(app)
      .put(`/api/agent-chat/sessions/${sessionId}/goal`)
      .send({
        goal: "Write report",
        guidance: "",
        deadlineAt: futureIso,
        outputFolder: "///",
      });
    expect(rootOutputFolder.status).toBe(200);
    expect(rootOutputFolder.body.goal.output_folder).toBe("");
  });
});
