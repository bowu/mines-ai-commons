import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalSessionManager } from "./goal-session-manager.js";
import { createPiSession } from "./session.js";
import { streamPiAgent } from "./stream.js";

vi.mock("./session.js", () => ({
  createPiSession: vi.fn(),
}));

vi.mock("./stream.js", () => ({
  streamPiAgent: vi.fn(),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Drain events to completion.
  }
}

describe("GoalSessionManager", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("allows complete_goal tool to mark goal completed without parameters", async () => {
    const agentId = "agent-1";
    const sessionId = "session-1";
    const goalId = "goal-1";
    const runId = "run-1";

    const completionBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname;
        if (path.endsWith(`/sessions/${sessionId}/goal`)) {
          return jsonResponse({
            goal: {
              id: goalId,
              session_id: sessionId,
              goal: "Complete the draft report",
              guidance: "",
              output_folder: "goal-output",
              status: "active",
              next_suggested_run_at: new Date().toISOString(),
            },
          });
        }
        if (path.endsWith(`/goals/${goalId}/runs`)) {
          return jsonResponse({ run: { id: runId } }, 201);
        }
        if (path.endsWith(`/goals/${goalId}/complete`)) {
          const body = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          completionBodies.push(body);
          return jsonResponse({
            goal: {
              id: goalId,
              status: "completed",
            },
          });
        }
        if (path.endsWith(`/goals/${goalId}/runs/${runId}/end`)) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = {
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const capturedTools: ToolDefinition[] = [];
    vi.mocked(createPiSession).mockImplementation(
      async (
        _agentId,
        _sessionId,
        _systemPrompt,
        tools,
      ): ReturnType<typeof createPiSession> => {
        capturedTools.push(...(tools || []));
        return {
          session,
        } as unknown as Awaited<ReturnType<typeof createPiSession>>;
      },
    );

    vi.mocked(streamPiAgent).mockImplementation(async function* () {
      yield { type: "text", data: "working..." };
      yield { type: "done" };
    });

    const manager = new GoalSessionManager({
      agentId,
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => "vm-token",
    });

    const stream = await manager.runForegroundTurn({
      sessionId,
      message: "Please finish the goal.",
      systemPrompt: "base prompt",
      chatHistory: [],
      model: "gemini-3.1-pro",
    });

    const completeGoalTool = capturedTools.find(
      (tool) => tool.name === "complete_goal",
    );
    expect(completeGoalTool).toBeTruthy();
    if (!completeGoalTool) {
      throw new Error("complete_goal tool was not registered");
    }

    await (completeGoalTool.execute as any)(
      "tool-1",
      {},
      undefined,
      undefined,
      undefined,
    );

    await drain(stream);

    expect(completionBodies).toHaveLength(1);
    expect(completionBodies[0]).toEqual({});
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(`/goals/${goalId}/runs/${runId}/end`),
      ),
    ).toBe(true);
  });

  it("restarts due active background goals after each run until completed", async () => {
    const agentId = "agent-2";
    const sessionId = "session-2";
    const goalId = "goal-2";
    let runCounter = 0;
    let backgroundTurnCounter = 0;
    const endedRunIds: string[] = [];

    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname;

        if (path.endsWith("/goals/active")) {
          return jsonResponse({
            goals: [
              {
                id: goalId,
                session_id: sessionId,
                goal: "Continue iterative work",
                guidance: "",
                output_folder: "loop-output",
                status: "active",
                next_suggested_run_at: new Date(
                  Date.now() - 1_000,
                ).toISOString(),
              },
            ],
          });
        }

        if (path.endsWith(`/sessions/${sessionId}/bootstrap`)) {
          return jsonResponse({
            systemPrompt: "system prompt",
            chatHistory: [],
          });
        }

        if (path.endsWith(`/goals/${goalId}/runs`)) {
          runCounter += 1;
          return jsonResponse({ run: { id: `run-${runCounter}` } }, 201);
        }

        if (path.endsWith(`/sessions/${sessionId}/background-turn/start`)) {
          backgroundTurnCounter += 1;
          return jsonResponse({ turnId: `turn-${backgroundTurnCounter}` }, 201);
        }

        if (path.includes(`/sessions/${sessionId}/background-turn/`)) {
          if (path.endsWith("/event")) {
            return jsonResponse({ seq: 1 }, 202);
          }
          if (path.endsWith("/finalize")) {
            return new Response(null, { status: 204 });
          }
        }

        const endMatch = path.match(
          new RegExp(`/goals/${goalId}/runs/(run-\\d+)/end$`),
        );
        if (endMatch) {
          endedRunIds.push(endMatch[1]);
          return new Response(null, { status: 204 });
        }

        if (path.endsWith("/stream-heartbeat")) {
          return new Response(null, { status: 204 });
        }

        throw new Error(
          `Unexpected fetch path: ${path} (${init?.method || "GET"})`,
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = {
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    vi.mocked(createPiSession).mockResolvedValue({
      session,
    } as unknown as Awaited<ReturnType<typeof createPiSession>>);

    vi.mocked(streamPiAgent).mockImplementation(async function* () {
      yield { type: "text", data: "background progress" };
      yield { type: "done" };
    });

    const manager = new GoalSessionManager({
      agentId,
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => "vm-token",
    });

    await (manager as any).reconcileGoals();
    await vi.waitFor(() => {
      expect(runCounter).toBe(1);
      expect(endedRunIds).toEqual(["run-1"]);
    });

    await (manager as any).reconcileGoals();
    await vi.waitFor(() => {
      expect(runCounter).toBe(2);
      expect(endedRunIds).toEqual(["run-1", "run-2"]);
    });
  });

  it("adds a completion-check preflight on same-session restart after agent_end", async () => {
    const agentId = "agent-3";
    const sessionId = "session-3";
    const goalId = "goal-3";
    let runCounter = 0;
    const messagesSentToStream: string[] = [];

    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const path = url.pathname;

      if (path.endsWith(`/sessions/${sessionId}/goal`)) {
        return jsonResponse({
          goal: {
            id: goalId,
            session_id: sessionId,
            goal: "Decide if the goal is already complete",
            guidance: "",
            output_folder: "restart-check-output",
            status: "active",
            next_suggested_run_at: new Date().toISOString(),
          },
        });
      }

      if (path.endsWith(`/goals/${goalId}/runs`)) {
        runCounter += 1;
        return jsonResponse({ run: { id: `run-${runCounter}` } }, 201);
      }

      const endMatch = path.match(
        new RegExp(`/goals/${goalId}/runs/(run-\\d+)/end$`),
      );
      if (endMatch) {
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected fetch path: ${path}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = {
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    vi.mocked(createPiSession).mockResolvedValue({
      session,
    } as unknown as Awaited<ReturnType<typeof createPiSession>>);

    vi.mocked(streamPiAgent).mockImplementation(async function* (_s, message) {
      messagesSentToStream.push(String(message || ""));
      yield { type: "text", data: "done" };
      yield { type: "done" };
    });

    const manager = new GoalSessionManager({
      agentId,
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => "vm-token",
    });

    const run1 = await manager.runForegroundTurn({
      sessionId,
      message: "First run message",
      systemPrompt: "base prompt",
      chatHistory: [],
      model: "gemini-3.1-pro",
    });
    await drain(run1);

    const run2 = await manager.runForegroundTurn({
      sessionId,
      message: "Second run message",
      systemPrompt: "base prompt",
      chatHistory: [],
      model: "gemini-3.1-pro",
    });
    await drain(run2);

    expect(messagesSentToStream).toHaveLength(2);
    expect(messagesSentToStream[0]).toContain("First run message");
    expect(messagesSentToStream[0]).not.toContain("Restart guard");
    expect(messagesSentToStream[1]).toContain("Restart guard");
    expect(messagesSentToStream[1]).toContain("complete_goal");
    expect(messagesSentToStream[1]).toContain("markdown links");
    expect(messagesSentToStream[1]).toContain("Second run message");
  });

  it("does not append fallback assistant text for background runs with no user-facing output", async () => {
    const agentId = "agent-4";
    const sessionId = "session-4";
    const goalId = "goal-4";
    const runId = "run-4";
    const turnId = "turn-4";

    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname;

        if (path.endsWith("/goals/active")) {
          return jsonResponse({
            goals: [
              {
                id: goalId,
                session_id: sessionId,
                goal: "Silent background run",
                guidance: "",
                output_folder: "output",
                status: "active",
                next_suggested_run_at: new Date(
                  Date.now() - 1_000,
                ).toISOString(),
              },
            ],
          });
        }

        if (path.endsWith(`/sessions/${sessionId}/bootstrap`)) {
          return jsonResponse({
            systemPrompt: "system prompt",
            chatHistory: [],
          });
        }

        if (path.endsWith(`/goals/${goalId}/runs`)) {
          return jsonResponse({ run: { id: runId } }, 201);
        }

        if (path.endsWith(`/sessions/${sessionId}/background-turn/start`)) {
          return jsonResponse({ turnId }, 201);
        }

        if (
          path.endsWith(
            `/sessions/${sessionId}/background-turn/${turnId}/event`,
          )
        ) {
          return jsonResponse({ seq: 1 }, 202);
        }

        if (
          path.endsWith(
            `/sessions/${sessionId}/background-turn/${turnId}/finalize`,
          )
        ) {
          return new Response(null, { status: 204 });
        }

        if (path.endsWith(`/goals/${goalId}/runs/${runId}/end`)) {
          return new Response(null, { status: 204 });
        }

        if (path.endsWith("/stream-heartbeat")) {
          return new Response(null, { status: 204 });
        }

        throw new Error(
          `Unexpected fetch path: ${path} (${init?.method || "GET"})`,
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = {
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    vi.mocked(createPiSession).mockResolvedValue({
      session,
    } as unknown as Awaited<ReturnType<typeof createPiSession>>);

    vi.mocked(streamPiAgent).mockImplementation(async function* () {
      yield { type: "done" };
    });

    const manager = new GoalSessionManager({
      agentId,
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => "vm-token",
    });

    await (manager as any).reconcileGoals();
    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes(`/goals/${goalId}/runs/${runId}/end`),
        ),
      ).toBe(true);
    });

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes(
          `/sessions/${sessionId}/background-turn/${turnId}/finalize`,
        ),
      ),
    ).toBe(true);
  });

  it("cancels a stuck foreground run and allows the next turn", async () => {
    const agentId = "agent-foreground-cancel";
    const sessionId = "session-foreground-cancel";

    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, _init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname;
        if (path.endsWith(`/sessions/${sessionId}/goal`)) {
          return jsonResponse({ goal: null });
        }
        if (path.endsWith(`/sessions/${sessionId}/bootstrap`)) {
          return jsonResponse({
            systemPrompt: "system prompt",
            chatHistory: [],
          });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let releaseStream: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const session = {
      abort: vi.fn(async () => {
        releaseStream();
      }),
      dispose: vi.fn(),
    };
    vi.mocked(createPiSession).mockResolvedValue({
      session,
    } as unknown as Awaited<ReturnType<typeof createPiSession>>);

    vi.mocked(streamPiAgent).mockImplementation(async function* () {
      yield { type: "text", data: "working" };
      await blocked;
      yield { type: "done" };
    });

    const manager = new GoalSessionManager({
      agentId,
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => "vm-token",
    });

    const run1 = await manager.runForegroundTurn({
      sessionId,
      message: "first",
      systemPrompt: "base",
      chatHistory: [],
      model: "gemini-3.1-pro",
    });
    const run1DrainPromise = drain(run1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      manager.runForegroundTurn({
        sessionId,
        message: "second",
        systemPrompt: "base",
        chatHistory: [],
        model: "gemini-3.1-pro",
      }),
    ).rejects.toThrow("Session is already processing a foreground turn");

    await expect(manager.cancelForegroundTurn(sessionId)).resolves.toBe(true);
    expect(session.abort).toHaveBeenCalledTimes(1);

    await run1DrainPromise;

    const run2 = await manager.runForegroundTurn({
      sessionId,
      message: "second",
      systemPrompt: "base",
      chatHistory: [],
      model: "gemini-3.1-pro",
    });
    await drain(run2);
  });

  it("does not start a background run while foreground setup is in progress", async () => {
    const agentId = "agent-race-guard";
    const sessionId = "session-race-guard";
    const goalId = "goal-race-guard";
    let runCounter = 0;
    let backgroundTurnCounter = 0;
    const runTypes: string[] = [];

    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname;

        if (path.endsWith(`/sessions/${sessionId}/goal`)) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return jsonResponse({
            goal: {
              id: goalId,
              session_id: sessionId,
              goal: "Race-guard goal",
              guidance: "",
              output_folder: "out",
              status: "active",
              next_suggested_run_at: new Date().toISOString(),
            },
          });
        }

        if (path.endsWith("/goals/active")) {
          return jsonResponse({
            goals: [
              {
                id: goalId,
                session_id: sessionId,
                goal: "Race-guard goal",
                guidance: "",
                output_folder: "out",
                status: "active",
                next_suggested_run_at: new Date(
                  Date.now() - 1_000,
                ).toISOString(),
              },
            ],
          });
        }

        if (path.endsWith(`/sessions/${sessionId}/bootstrap`)) {
          return jsonResponse({
            systemPrompt: "system prompt",
            chatHistory: [],
          });
        }

        if (path.endsWith(`/goals/${goalId}/runs`)) {
          runCounter += 1;
          const body = JSON.parse(String(init?.body || "{}")) as {
            runType?: string;
          };
          runTypes.push(String(body.runType || "unknown"));
          return jsonResponse({ run: { id: `run-${runCounter}` } }, 201);
        }

        if (path.endsWith(`/goals/${goalId}/runs/run-1/end`)) {
          return new Response(null, { status: 204 });
        }

        if (path.endsWith(`/sessions/${sessionId}/background-turn/start`)) {
          backgroundTurnCounter += 1;
          return jsonResponse({ turnId: `turn-${backgroundTurnCounter}` }, 201);
        }

        if (path.includes(`/sessions/${sessionId}/background-turn/`)) {
          if (path.endsWith("/event")) {
            return jsonResponse({ seq: 1 }, 202);
          }
          if (path.endsWith("/finalize")) {
            return new Response(null, { status: 204 });
          }
        }

        if (path.endsWith("/stream-heartbeat")) {
          return new Response(null, { status: 204 });
        }

        throw new Error(
          `Unexpected fetch path: ${path} (${init?.method || "GET"})`,
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = {
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    vi.mocked(createPiSession).mockResolvedValue({
      session,
    } as unknown as Awaited<ReturnType<typeof createPiSession>>);

    vi.mocked(streamPiAgent).mockImplementation(async function* () {
      yield { type: "text", data: "foreground text" };
      yield { type: "done" };
    });

    const manager = new GoalSessionManager({
      agentId,
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => "vm-token",
    });

    const runPromise = manager.runForegroundTurn({
      sessionId,
      message: "Start now",
      systemPrompt: "base prompt",
      chatHistory: [],
      model: "gemini-3.1-pro",
    });

    await (manager as any).reconcileGoals();

    const run = await runPromise;
    await drain(run);

    expect(runTypes).toEqual(["foreground"]);
    expect(runCounter).toBe(1);
  });

  it("does not clear active foreground state when background exits early", async () => {
    const agentId = "agent-clobber-guard";
    const sessionId = "session-clobber-guard";
    const goalId = "goal-clobber-guard";
    const fgRunId = "run-fg-1";

    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname;

        if (path.endsWith(`/sessions/${sessionId}/goal`)) {
          return jsonResponse({
            goal: {
              id: goalId,
              session_id: sessionId,
              goal: "Foreground should stay owned",
              guidance: "",
              output_folder: "out",
              status: "active",
              next_suggested_run_at: new Date().toISOString(),
            },
          });
        }

        if (path.endsWith("/goals/active")) {
          return jsonResponse({
            goals: [
              {
                id: goalId,
                session_id: sessionId,
                goal: "Foreground should stay owned",
                guidance: "",
                output_folder: "out",
                status: "active",
                next_suggested_run_at: new Date(
                  Date.now() - 1_000,
                ).toISOString(),
              },
            ],
          });
        }

        if (path.endsWith(`/goals/${goalId}/runs`)) {
          return jsonResponse({ run: { id: fgRunId } }, 201);
        }

        if (path.endsWith(`/goals/${goalId}/runs/${fgRunId}/end`)) {
          return new Response(null, { status: 204 });
        }

        throw new Error(
          `Unexpected fetch path: ${path} (${init?.method || "GET"})`,
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let releaseForeground: () => void = () => {};
    const foregroundBlocked = new Promise<void>((resolve) => {
      releaseForeground = resolve;
    });
    const session = {
      abort: vi.fn(async () => {
        releaseForeground();
      }),
      dispose: vi.fn(),
    };
    vi.mocked(createPiSession).mockResolvedValue({
      session,
    } as unknown as Awaited<ReturnType<typeof createPiSession>>);

    vi.mocked(streamPiAgent).mockImplementation(async function* () {
      yield { type: "text", data: "foreground in progress" };
      await foregroundBlocked;
      yield { type: "done" };
    });

    const manager = new GoalSessionManager({
      agentId,
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => "vm-token",
    });

    const run = await manager.runForegroundTurn({
      sessionId,
      message: "first",
      systemPrompt: "base",
      chatHistory: [],
      model: "gemini-3.1-pro",
    });
    const runDrainPromise = drain(run);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await (manager as any).reconcileGoals();

    await expect(
      manager.runForegroundTurn({
        sessionId,
        message: "second",
        systemPrompt: "base",
        chatHistory: [],
        model: "gemini-3.1-pro",
      }),
    ).rejects.toThrow("Session is already processing a foreground turn");

    await expect(manager.cancelForegroundTurn(sessionId)).resolves.toBe(true);
    await runDrainPromise;
  });

  it("preempts a running background turn when a foreground turn starts", async () => {
    const agentId = "agent-background-preempt";
    const sessionId = "session-background-preempt";
    const goalId = "goal-background-preempt";
    const startedRuns: Array<{ id: string; runType: string }> = [];
    const endedRuns: Array<{ id: string; status: string }> = [];
    let backgroundTurnCounter = 0;

    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname;

        if (path.endsWith("/goals/active")) {
          return jsonResponse({
            goals: [
              {
                id: goalId,
                session_id: sessionId,
                goal: "Background preemption",
                guidance: "",
                output_folder: "out",
                status: "active",
                next_suggested_run_at: new Date(
                  Date.now() - 1_000,
                ).toISOString(),
              },
            ],
          });
        }

        if (path.endsWith(`/sessions/${sessionId}/bootstrap`)) {
          return jsonResponse({
            systemPrompt: "system prompt",
            chatHistory: [],
          });
        }

        if (path.endsWith(`/sessions/${sessionId}/goal`)) {
          return jsonResponse({
            goal: {
              id: goalId,
              session_id: sessionId,
              goal: "Background preemption",
              guidance: "",
              output_folder: "out",
              status: "active",
              next_suggested_run_at: new Date().toISOString(),
            },
          });
        }

        if (path.endsWith(`/goals/${goalId}/runs`)) {
          const body = JSON.parse(String(init?.body || "{}")) as {
            runType?: string;
          };
          const runType = String(body.runType || "unknown");
          const id =
            runType === "background"
              ? "run-bg-1"
              : runType === "foreground"
                ? "run-fg-1"
                : `run-${runType}`;
          startedRuns.push({ id, runType });
          return jsonResponse({ run: { id } }, 201);
        }

        const endMatch = path.match(
          new RegExp(`/goals/${goalId}/runs/(run-[^-]+-\\d+)/end$`),
        );
        if (endMatch) {
          const body = JSON.parse(String(init?.body || "{}")) as {
            status?: string;
          };
          endedRuns.push({
            id: endMatch[1],
            status: String(body.status || "unknown"),
          });
          return new Response(null, { status: 204 });
        }

        if (path.endsWith(`/sessions/${sessionId}/background-turn/start`)) {
          backgroundTurnCounter += 1;
          return jsonResponse({ turnId: `turn-${backgroundTurnCounter}` }, 201);
        }

        if (path.includes(`/sessions/${sessionId}/background-turn/`)) {
          if (path.endsWith("/event")) {
            return jsonResponse({ seq: 1 }, 202);
          }
          if (path.endsWith("/finalize")) {
            return new Response(null, { status: 204 });
          }
        }

        if (path.endsWith("/stream-heartbeat")) {
          return new Response(null, { status: 204 });
        }

        throw new Error(
          `Unexpected fetch path: ${path} (${init?.method || "GET"})`,
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let releaseBackground: () => void = () => {};
    const backgroundBlocked = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    const session = {
      abort: vi.fn(async () => {
        releaseBackground();
      }),
      dispose: vi.fn(),
    };
    vi.mocked(createPiSession).mockResolvedValue({
      session,
    } as unknown as Awaited<ReturnType<typeof createPiSession>>);

    let streamInvocation = 0;
    vi.mocked(streamPiAgent).mockImplementation(async function* () {
      streamInvocation += 1;
      if (streamInvocation === 1) {
        yield { type: "text", data: "background stream" };
        await backgroundBlocked;
        yield { type: "done" };
        return;
      }
      yield { type: "text", data: "foreground stream" };
      yield { type: "done" };
    });

    const manager = new GoalSessionManager({
      agentId,
      apiBaseUrl: "http://localhost:3001",
      getVmToken: () => "vm-token",
    });

    await (manager as any).reconcileGoals();
    await vi.waitFor(() => {
      expect(startedRuns.some((run) => run.runType === "background")).toBe(
        true,
      );
    });

    const foregroundRun = await manager.runForegroundTurn({
      sessionId,
      message: "user message",
      systemPrompt: "base prompt",
      chatHistory: [],
      model: "gemini-3.1-pro",
    });
    await drain(foregroundRun);

    await vi.waitFor(() => {
      expect(endedRuns.some((run) => run.id === "run-bg-1")).toBe(true);
      expect(endedRuns.some((run) => run.id === "run-fg-1")).toBe(true);
    });

    const backgroundEnd = endedRuns.find((run) => run.id === "run-bg-1");
    const foregroundEnd = endedRuns.find((run) => run.id === "run-fg-1");
    expect(session.abort).toHaveBeenCalled();
    expect(backgroundEnd?.status).toBe("aborted");
    expect(foregroundEnd?.status).toBe("completed");
  });
});
