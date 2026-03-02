import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import {
  type AgentModelSelection,
  type ChatHistoryEntry,
  createPiSession,
} from "./session.js";
import { type StreamEvent, streamPiAgent } from "./stream.js";
import { createSandboxTools } from "./tools.js";

const DEFAULT_BACKGROUND_MODEL: AgentModelSelection = "sonnet-4.6";
const RECONCILE_INTERVAL_MS = Number(
  process.env.SANDBOX_GOAL_RECONCILE_INTERVAL_MS || 10_000,
);
const HEARTBEAT_INTERVAL_MS = Number(
  process.env.SANDBOX_GOAL_HEARTBEAT_INTERVAL_MS || 20_000,
);
const INTERNAL_FETCH_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.SANDBOX_INTERNAL_FETCH_TIMEOUT_MS || 15_000),
);
const INTERNAL_FETCH_RETRY_DELAY_MS = Math.max(
  50,
  Number(process.env.SANDBOX_INTERNAL_FETCH_RETRY_DELAY_MS || 250),
);
const INTERNAL_FETCH_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.SANDBOX_INTERNAL_FETCH_MAX_ATTEMPTS || 2),
);
const GOAL_RUN_FINALIZE_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.SANDBOX_GOAL_RUN_FINALIZE_TIMEOUT_MS || 12_000),
);
const FOREGROUND_RUN_IDLE_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.SANDBOX_FOREGROUND_RUN_IDLE_TIMEOUT_MS || 120_000),
);
const FOREGROUND_RUN_MAX_TIMEOUT_MS = Math.max(
  FOREGROUND_RUN_IDLE_TIMEOUT_MS,
  Number(process.env.SANDBOX_FOREGROUND_RUN_MAX_TIMEOUT_MS || 600_000),
);
const BACKGROUND_RUN_IDLE_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.SANDBOX_GOAL_BACKGROUND_RUN_IDLE_TIMEOUT_MS || 900_000),
);
const BACKGROUND_RUN_TIMEOUT_MS = Math.max(
  BACKGROUND_RUN_IDLE_TIMEOUT_MS,
  Number(process.env.SANDBOX_GOAL_BACKGROUND_RUN_TIMEOUT_MS || 900_000),
);
const MAX_BACKGROUND_CONCURRENCY = Math.max(
  1,
  Number(process.env.SANDBOX_GOAL_MAX_BACKGROUND_CONCURRENCY || 2),
);
const GOAL_TRACE_ENABLED =
  (process.env.SANDBOX_GOAL_TRACE || "true").trim().toLowerCase() !== "false";

interface SessionGoal {
  id: string;
  session_id: string;
  goal: string;
  guidance: string;
  output_folder: string;
  deadline_at?: string | null;
  report_path?: string | null;
  artifact_paths?: unknown;
  progress_summary?: string | null;
  next_suggested_run_at?: string | null;
  run_count?: number;
}

interface ManagedRun {
  kind: "foreground" | "background";
  goalId: string | null;
  preemptRequested: boolean;
  startedAtMs: number;
  lastActivityAtMs: number;
  donePromise?: Promise<void>;
}

interface ManagedSession {
  session: Awaited<ReturnType<typeof createPiSession>>["session"];
  sessionId: string;
  baseSystemPrompt: string;
  modelSelection: AgentModelSelection;
  currentRun: ManagedRun | null;
  currentGoal: SessionGoal | null;
  requiresCompletionCheckOnRestart: boolean;
}

interface GoalSessionManagerOptions {
  agentId: string;
  apiBaseUrl: string;
  getVmToken: () => string | null;
  ensureVmToken?: () => Promise<string | null>;
  refreshVmToken?: () => Promise<string | null>;
}

interface SessionBootstrapPayload {
  systemPrompt: string;
  chatHistory: ChatHistoryEntry[];
}

interface StartRunPayload {
  run: {
    id: string;
  };
}

type PersistedAssistantSegment =
  | { type: "text"; content: string; blockIndex?: number }
  | { type: "thinking"; content: string; blockIndex?: number }
  | {
      type: "tool";
      name: string;
      args?: unknown;
      result?: unknown;
      error?: boolean;
    };

interface PersistedToolCall {
  name: string;
  args?: unknown;
  result?: unknown;
  error?: boolean;
}

function goalTrace(event: string, details: Record<string, unknown>): void {
  if (!GOAL_TRACE_ENABLED) return;
  try {
    console.log(
      `[goal_trace] ${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...details,
      })}`,
    );
  } catch {
    // Never fail goal execution due to logging.
  }
}

function summarizeHistory(history: ChatHistoryEntry[] | undefined): {
  count: number;
  totalChars: number;
  userCount: number;
  assistantCount: number;
} {
  const entries = Array.isArray(history) ? history : [];
  let totalChars = 0;
  let userCount = 0;
  let assistantCount = 0;
  for (const entry of entries) {
    const content = typeof entry?.content === "string" ? entry.content : "";
    totalChars += content.length;
    if (entry.role === "user") userCount += 1;
    if (entry.role === "assistant") assistantCount += 1;
  }
  return {
    count: entries.length,
    totalChars,
    userCount,
    assistantCount,
  };
}

export class SessionBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBusyError";
  }
}

function formatGoalContext(
  goal: SessionGoal,
  mode: "foreground" | "background",
): string {
  const artifactPaths = Array.isArray(goal.artifact_paths)
    ? goal.artifact_paths
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

  const lines = ["[GOAL CONTEXT]"];
  lines.push(`Goal ID: ${goal.id}`);
  lines.push(`Goal: ${goal.goal}`);
  lines.push(`Guidance: ${goal.guidance || "(none)"}`);
  lines.push(`Output folder: ${goal.output_folder}`);
  lines.push(`Run mode: ${mode}`);
  if (goal.deadline_at) {
    lines.push(`Deadline: ${goal.deadline_at}`);
  } else {
    lines.push("Deadline: none");
  }
  if (goal.progress_summary) {
    lines.push(`Latest progress summary: ${goal.progress_summary}`);
  }
  if (artifactPaths.length > 0) {
    lines.push(`Known artifacts: ${artifactPaths.join(", ")}`);
  }
  lines.push(
    "When determining whether the goal is complete, fully consider the acceptance criteria in Guidance.",
  );
  lines.push("If this goal is complete, call complete_goal.");
  lines.push(
    "Before calling complete_goal, send one final summary for the entire goal that includes markdown links to key generated artifacts.",
  );
  lines.push(
    "At the end of each turn, send a concise progress summary describing what was completed in that turn and which artifacts were created or updated.",
  );
  lines.push(
    "Demonstrate progress by generating or updating concrete artifacts in the output folder as you work.",
  );
  lines.push(
    "Goal mode is autonomous: do not ask the user for clarifications, approvals, or next steps while the goal is active.",
  );
  lines.push(
    "If information is missing, make a reasonable assumption, proceed, and record assumptions in the relevant output-folder artifacts.",
  );
  lines.push(
    "For autonomous runs, do concrete work immediately. Avoid repeating completed work.",
  );
  return lines.join("\n");
}

function buildContinuationPrompt(goal: SessionGoal): string {
  const timeLine = goal.deadline_at
    ? `Deadline: ${goal.deadline_at}`
    : "No deadline was provided.";
  return [
    "Continue working autonomously on the active goal.",
    `Primary goal: ${goal.goal}`,
    goal.guidance ? `Guidance: ${goal.guidance}` : "Guidance: none",
    `Output folder: ${goal.output_folder}`,
    timeLine,
    "When evaluating completion, treat the acceptance criteria in Guidance as mandatory.",
    "Do not ask the user for input while this goal is active. Continue autonomously.",
    "If something is ambiguous, choose the most reasonable assumption and proceed.",
    "Generate or update concrete artifacts in the output folder to demonstrate progress.",
    "End each turn with a concise progress summary and mention key updated artifacts.",
    "Before complete_goal, post a final summary for the entire goal with markdown links to key artifacts.",
    "Only call complete_goal once the goal is fully complete.",
  ].join("\n");
}

function buildRestartCompletionCheckPrompt(goal: SessionGoal): string {
  return [
    "Restart guard: this is a continuation in the same session after agent_end (second turn or later).",
    "At the beginning of this turn, carefully read the goal description and acceptance criteria, then evaluate existing artifacts to determine whether the goal is already complete.",
    `If the goal is already complete, post a concise summary for the entire goal with markdown links to key artifacts in ${goal.output_folder}, then call complete_goal.`,
    "If not complete, proceed with incremental artifact updates and end the turn with a concise progress summary.",
  ].join("\n");
}

export class GoalSessionManager {
  private readonly agentId: string;
  private readonly apiBaseUrl: string;
  private readonly getVmToken: () => string | null;
  private readonly ensureVmToken?: () => Promise<string | null>;
  private readonly refreshVmToken?: () => Promise<string | null>;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly runningGoalIds = new Set<string>();
  private readonly foregroundSetupSessions = new Set<string>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconcileInFlight = false;
  private lastActiveGoalCount = 0;

  constructor(options: GoalSessionManagerOptions) {
    this.agentId = options.agentId;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.getVmToken = options.getVmToken;
    this.ensureVmToken = options.ensureVmToken;
    this.refreshVmToken = options.refreshVmToken;
  }

  start(): void {
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => {
        void this.reconcileGoals();
      }, RECONCILE_INTERVAL_MS);
    }
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        void this.maybeHeartbeat();
      }, HEARTBEAT_INTERVAL_MS);
    }
    void this.reconcileGoals();
  }

  getStatus(): { busy: boolean; activeSessions: number } {
    const busy = Array.from(this.sessions.values()).some(
      (managed) => managed.currentRun !== null,
    );
    return {
      busy,
      activeSessions: this.sessions.size,
    };
  }

  async runForegroundTurn(options: {
    sessionId: string;
    message: string;
    systemPrompt: string;
    chatHistory: ChatHistoryEntry[];
    model: AgentModelSelection;
  }): Promise<AsyncGenerator<StreamEvent>> {
    this.foregroundSetupSessions.add(options.sessionId);
    try {
      const managed = await this.ensureManagedSession({
        sessionId: options.sessionId,
        systemPrompt: options.systemPrompt,
        chatHistory: options.chatHistory,
        modelSelection: options.model,
      });

      await this.preemptBackgroundRun(managed);

      if (managed.currentRun?.kind === "foreground") {
        const idleMs = Date.now() - managed.currentRun.lastActivityAtMs;
        if (idleMs >= FOREGROUND_RUN_IDLE_TIMEOUT_MS) {
          await this.cancelForegroundTurn(
            options.sessionId,
            "stale_foreground",
          );
        } else {
          throw new SessionBusyError(
            "Session is already processing a foreground turn",
          );
        }
      }

      if (managed.currentRun?.kind === "foreground") {
        throw new SessionBusyError(
          "Session is already processing a foreground turn",
        );
      }

      if (managed.modelSelection !== options.model) {
        const recreated = await this.ensureManagedSession({
          sessionId: options.sessionId,
          systemPrompt: options.systemPrompt,
          chatHistory: options.chatHistory,
          modelSelection: options.model,
        });
        return this.runForegroundTurn({
          ...options,
          model: recreated.modelSelection,
        });
      }

      const sessionGoal = await this.fetchSessionGoal(options.sessionId).catch(
        () => null,
      );
      const historySummary = summarizeHistory(options.chatHistory);
      let resolveForegroundDone: (() => void) | null = null;
      const foregroundDone = new Promise<void>((resolve) => {
        resolveForegroundDone = resolve;
      });
      const now = Date.now();
      managed.currentGoal = sessionGoal;
      managed.currentRun = {
        kind: "foreground",
        goalId: sessionGoal?.id || null,
        preemptRequested: false,
        startedAtMs: now,
        lastActivityAtMs: now,
        donePromise: foregroundDone,
      };

      const self = this;
      async function* generator(): AsyncGenerator<StreamEvent> {
        let goalRunId: string | null = null;
        let goalRunStatus: "completed" | "failed" | "aborted" = "completed";
        let goalRunErrorMessage: string | undefined;
        const startedAtMs = Date.now();
        let firstEventAtMs: number | null = null;
        const eventCounts: Record<string, number> = {};
        const requiresRestartCheck = managed.requiresCompletionCheckOnRestart;
        managed.requiresCompletionCheckOnRestart = false;
        const message =
          sessionGoal && requiresRestartCheck
            ? `${buildRestartCompletionCheckPrompt(sessionGoal)}\n\n${options.message}`
            : options.message;
        goalTrace("foreground.run_start", {
          agentId: self.agentId,
          sessionId: options.sessionId,
          goalId: sessionGoal?.id || null,
          model: options.model,
          messageChars: message.length,
          userMessageChars: options.message.length,
          systemPromptChars: options.systemPrompt.length,
          chatHistoryCount: historySummary.count,
          chatHistoryChars: historySummary.totalChars,
          chatHistoryUserCount: historySummary.userCount,
          chatHistoryAssistantCount: historySummary.assistantCount,
          requiresRestartCheck,
        });
        try {
          if (sessionGoal?.id) {
            try {
              const start = await self.startGoalRun(
                sessionGoal.id,
                "foreground",
                "user_message",
              );
              goalRunId = start?.run?.id || null;
            } catch (error) {
              console.warn("Foreground goal run start failed:", error);
            }
          }
          for await (const event of streamPiAgent(
            managed.session,
            message,
            options.systemPrompt,
          )) {
            eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
            if (firstEventAtMs === null) {
              firstEventAtMs = Date.now();
            }
            if (managed.currentRun?.kind === "foreground") {
              managed.currentRun.lastActivityAtMs = Date.now();
            }
            if (event.type === "error") {
              goalRunStatus = "failed";
              goalRunErrorMessage = String(
                event.data || "foreground run failed",
              );
            }
            yield event;
          }
        } catch (error) {
          goalRunStatus = "failed";
          goalRunErrorMessage =
            error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          if (
            managed.currentRun?.kind === "foreground" &&
            Date.now() - managed.currentRun.startedAtMs >
              FOREGROUND_RUN_MAX_TIMEOUT_MS
          ) {
            goalRunStatus = "aborted";
            goalRunErrorMessage = "foreground run exceeded max runtime";
          }
          if (sessionGoal?.id && goalRunId) {
            void self
              .endGoalRunWithTimeout(sessionGoal.id, goalRunId, {
                status: goalRunStatus,
                errorMessage: goalRunErrorMessage,
              })
              .catch((error) => {
                console.warn("Foreground goal run finalization failed:", error);
              });
          }
          if (sessionGoal?.id) {
            managed.requiresCompletionCheckOnRestart = true;
          }
          goalTrace("foreground.run_end", {
            agentId: self.agentId,
            sessionId: options.sessionId,
            goalId: sessionGoal?.id || null,
            runId: goalRunId,
            status: goalRunStatus,
            errorMessage: goalRunErrorMessage || null,
            durationMs: Date.now() - startedAtMs,
            firstEventLatencyMs:
              firstEventAtMs === null ? null : firstEventAtMs - startedAtMs,
            eventCounts,
          });
          managed.currentRun = null;
          managed.currentGoal = null;
          resolveForegroundDone?.();
          self.maybeDisposeIdleSessions();
        }
      }

      return generator();
    } finally {
      this.foregroundSetupSessions.delete(options.sessionId);
    }
  }

  async cancelForegroundTurn(
    sessionId: string,
    _reason = "manual_cancel",
  ): Promise<boolean> {
    const managed = this.sessions.get(sessionId);
    if (!managed || managed.currentRun?.kind !== "foreground") {
      return false;
    }

    managed.currentRun.preemptRequested = true;
    managed.currentRun.lastActivityAtMs = Date.now();

    try {
      await managed.session.abort();
    } catch {
      // Ignore abort races.
    }

    if (managed.currentRun?.donePromise) {
      await managed.currentRun.donePromise.catch(() => {});
    }
    return true;
  }

  private maybeDisposeIdleSessions(): void {
    for (const [sessionId, managed] of this.sessions.entries()) {
      if (managed.currentRun) continue;
      if (managed.requiresCompletionCheckOnRestart) continue;
      if (this.lastActiveGoalCount > 0) continue;
      managed.session.dispose();
      this.sessions.delete(sessionId);
    }
  }

  private async preemptBackgroundRun(managed: ManagedSession): Promise<void> {
    if (managed.currentRun?.kind !== "background") return;
    managed.currentRun.preemptRequested = true;
    try {
      await managed.session.abort();
    } catch {
      // Ignore abort errors: the session may have just finished.
    }
    if (managed.currentRun.donePromise) {
      await managed.currentRun.donePromise.catch(() => {});
    }
  }

  private async ensureManagedSession(options: {
    sessionId: string;
    systemPrompt?: string;
    chatHistory?: ChatHistoryEntry[];
    modelSelection: AgentModelSelection;
  }): Promise<ManagedSession> {
    const existing = this.sessions.get(options.sessionId);
    if (
      existing &&
      existing.modelSelection === options.modelSelection &&
      existing.currentRun === null
    ) {
      if (typeof options.systemPrompt === "string") {
        existing.baseSystemPrompt = options.systemPrompt;
      }
      return existing;
    }

    if (existing && existing.currentRun !== null) {
      return existing;
    }

    const bootstrap =
      typeof options.systemPrompt === "string" && options.chatHistory
        ? {
            systemPrompt: options.systemPrompt,
            chatHistory: options.chatHistory,
          }
        : await this.fetchSessionBootstrap(options.sessionId);
    const bootstrapHistorySummary = summarizeHistory(bootstrap.chatHistory);
    goalTrace("session.bootstrap_ready", {
      agentId: this.agentId,
      sessionId: options.sessionId,
      model: options.modelSelection,
      systemPromptChars: bootstrap.systemPrompt.length,
      chatHistoryCount: bootstrapHistorySummary.count,
      chatHistoryChars: bootstrapHistorySummary.totalChars,
      chatHistoryUserCount: bootstrapHistorySummary.userCount,
      chatHistoryAssistantCount: bootstrapHistorySummary.assistantCount,
      source:
        typeof options.systemPrompt === "string" && options.chatHistory
          ? "request"
          : "api",
    });

    if (existing) {
      existing.session.dispose();
      this.sessions.delete(options.sessionId);
    }

    const managed = await this.createManagedSession({
      sessionId: options.sessionId,
      modelSelection: options.modelSelection,
      systemPrompt: bootstrap.systemPrompt,
      chatHistory: bootstrap.chatHistory,
    });
    this.sessions.set(options.sessionId, managed);
    return managed;
  }

  private async createManagedSession(options: {
    sessionId: string;
    modelSelection: AgentModelSelection;
    systemPrompt: string;
    chatHistory: ChatHistoryEntry[];
  }): Promise<ManagedSession> {
    const managed: ManagedSession = {
      session: null as never,
      sessionId: options.sessionId,
      modelSelection: options.modelSelection,
      baseSystemPrompt: options.systemPrompt,
      currentRun: null,
      currentGoal: null,
      requiresCompletionCheckOnRestart: false,
    };

    const goalExtension: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", async (event) => {
        const goal = managed.currentGoal;
        const runKind = managed.currentRun?.kind;
        if (!goal || !runKind) return;
        const restartGuard = managed.requiresCompletionCheckOnRestart
          ? `\n\n[RESTART CHECK]\n${buildRestartCompletionCheckPrompt(goal)}`
          : "";
        const goalBlock = `${formatGoalContext(goal, runKind)}${restartGuard}`;
        return {
          systemPrompt: `${event.systemPrompt}\n\n${goalBlock}`,
        };
      });
    };

    const tools = createSandboxTools({
      agentId: this.agentId,
      apiBaseUrl: this.apiBaseUrl,
      getVmToken: this.getVmToken,
      ensureVmToken: this.ensureVmToken,
      refreshVmToken: this.refreshVmToken,
      getActiveGoalId: () => managed.currentGoal?.id || null,
      completeGoal: async (payload) => this.completeGoal(payload),
    });

    const created = await createPiSession(
      this.agentId,
      options.sessionId,
      options.systemPrompt,
      tools,
      options.chatHistory,
      options.modelSelection,
      [goalExtension],
    );
    managed.session = created.session;
    return managed;
  }

  private async reconcileGoals(): Promise<void> {
    if (this.reconcileInFlight) return;
    this.reconcileInFlight = true;
    try {
      const goals = await this.listActiveGoals();
      this.lastActiveGoalCount = goals.length;
      const activeBackgroundCount = Array.from(this.sessions.values()).filter(
        (managed) => managed.currentRun?.kind === "background",
      ).length;
      let availableSlots = Math.max(
        0,
        MAX_BACKGROUND_CONCURRENCY - activeBackgroundCount,
      );
      for (const goal of goals) {
        if (availableSlots <= 0) break;
        if (this.runningGoalIds.has(goal.id)) continue;
        this.runningGoalIds.add(goal.id);
        availableSlots -= 1;
        void this.runBackgroundGoal(goal).finally(() => {
          this.runningGoalIds.delete(goal.id);
        });
      }
    } catch (error) {
      console.warn("Goal reconcile failed:", error);
    } finally {
      this.reconcileInFlight = false;
    }
  }

  private async runBackgroundGoal(goal: SessionGoal): Promise<void> {
    let runId: string | null = null;
    let streamTurnId: string | null = null;
    let status: "completed" | "failed" | "aborted" = "completed";
    let errorMessage: string | undefined;
    let managed: ManagedSession | null = null;
    let ownsManagedRun = false;
    const toolCalls: PersistedToolCall[] = [];
    const segments: PersistedAssistantSegment[] = [];
    const textBlockToSegIdx = new Map<number, number>();
    const thinkingBlockToSegIdx = new Map<number, number>();
    const startedAtMs = Date.now();
    let firstEventAtMs: number | null = null;
    const eventCounts: Record<string, number> = {};
    let resolveDonePromise: () => void = () => {};
    const donePromise = new Promise<void>((resolve) => {
      resolveDonePromise = resolve;
    });
    try {
      if (this.foregroundSetupSessions.has(goal.session_id)) {
        status = "aborted";
        errorMessage = "foreground setup in progress";
        goalTrace("background.run_skip_foreground_setup", {
          agentId: this.agentId,
          sessionId: goal.session_id,
          goalId: goal.id,
        });
        return;
      }
      managed = await this.ensureManagedSession({
        sessionId: goal.session_id,
        modelSelection: DEFAULT_BACKGROUND_MODEL,
      });
      if (managed.currentRun) {
        status = "aborted";
        errorMessage = "session already has active run";
        return;
      }

      const run: ManagedRun = {
        kind: "background",
        goalId: goal.id,
        preemptRequested: false,
        startedAtMs: Date.now(),
        lastActivityAtMs: Date.now(),
        donePromise,
      };
      managed.currentRun = run;
      managed.currentGoal = goal;
      ownsManagedRun = true;

      if (
        this.foregroundSetupSessions.has(goal.session_id) ||
        run.preemptRequested
      ) {
        status = "aborted";
        errorMessage = "foreground setup detected before background start";
        return;
      }

      const startResult = await this.startGoalRun(
        goal.id,
        "background",
        "reconciler",
      );
      runId = startResult?.run?.id || null;
      if (!runId) {
        status = "aborted";
        return;
      }
      const streamTurn = await this.startBackgroundTurnStream(goal.session_id);
      streamTurnId = streamTurn.turnId;
      goalTrace("background.run_start", {
        agentId: this.agentId,
        sessionId: goal.session_id,
        goalId: goal.id,
        runId,
        streamTurnId,
        goalRunCount: goal.run_count ?? null,
        model: DEFAULT_BACKGROUND_MODEL,
        systemPromptChars: managed.baseSystemPrompt.length,
      });

      run.donePromise = (async () => {
        let streamError: string | null = null;
        const requiresRestartCheck = managed.requiresCompletionCheckOnRestart;
        managed.requiresCompletionCheckOnRestart = false;
        const continuationPrompt = requiresRestartCheck
          ? `${buildRestartCompletionCheckPrompt(goal)}\n\n${buildContinuationPrompt(goal)}`
          : buildContinuationPrompt(goal);
        goalTrace("background.prompt_ready", {
          agentId: this.agentId,
          sessionId: goal.session_id,
          goalId: goal.id,
          runId,
          continuationPromptChars: continuationPrompt.length,
          requiresRestartCheck,
          deadlineAt: goal.deadline_at || null,
        });
        let timeoutReason: "idle" | "max" | null = null;
        let idleTimeoutHandle: NodeJS.Timeout | null = null;
        const triggerTimeout = (reason: "idle" | "max") => {
          if (timeoutReason) return;
          timeoutReason = reason;
          goalTrace("background.timeout_triggered", {
            agentId: this.agentId,
            sessionId: goal.session_id,
            goalId: goal.id,
            runId,
            reason,
            elapsedMs: Date.now() - run.startedAtMs,
            idleForMs: Date.now() - run.lastActivityAtMs,
            eventCounts,
          });
          void managed?.session.abort().catch(() => {});
        };
        const scheduleIdleTimeout = () => {
          if (idleTimeoutHandle) {
            clearTimeout(idleTimeoutHandle);
          }
          idleTimeoutHandle = setTimeout(() => {
            triggerTimeout("idle");
          }, BACKGROUND_RUN_IDLE_TIMEOUT_MS);
        };
        const maxTimeoutHandle = setTimeout(() => {
          triggerTimeout("max");
        }, BACKGROUND_RUN_TIMEOUT_MS);
        scheduleIdleTimeout();
        try {
          for await (const event of streamPiAgent(
            managed.session,
            continuationPrompt,
            managed.baseSystemPrompt,
          )) {
            eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
            if (firstEventAtMs === null) {
              firstEventAtMs = Date.now();
            }
            if (managed.currentRun?.kind === "background") {
              managed.currentRun.lastActivityAtMs = Date.now();
            }
            scheduleIdleTimeout();
            if (streamTurnId) {
              await this.publishBackgroundTurnEvent(
                goal.session_id,
                streamTurnId,
                event,
              ).catch((error) => {
                console.warn("Publish background turn event failed:", error);
              });
            }

            if (event.type === "text") {
              const payload = event.data;
              const isReplace =
                payload &&
                typeof payload === "object" &&
                (payload as { mode?: string }).mode === "replace" &&
                typeof (payload as { text?: unknown }).text === "string";
              const blockIndex =
                isReplace &&
                typeof (payload as { blockIndex?: unknown }).blockIndex ===
                  "number"
                  ? (payload as { blockIndex: number }).blockIndex
                  : 0;
              const text =
                isReplace && payload
                  ? String((payload as { text: string }).text)
                  : String(payload ?? "");

              const existingIdx = textBlockToSegIdx.get(blockIndex);
              if (existingIdx !== undefined) {
                segments[existingIdx] = {
                  type: "text",
                  content: text,
                  blockIndex,
                };
              } else {
                textBlockToSegIdx.set(blockIndex, segments.length);
                segments.push({
                  type: "text",
                  content: text,
                  blockIndex,
                });
              }
            }

            if (event.type === "thinking") {
              const payload = event.data;
              const isReplace =
                payload &&
                typeof payload === "object" &&
                (payload as { mode?: string }).mode === "replace" &&
                typeof (payload as { text?: unknown }).text === "string";
              const blockIndex =
                isReplace &&
                typeof (payload as { blockIndex?: unknown }).blockIndex ===
                  "number"
                  ? (payload as { blockIndex: number }).blockIndex
                  : 0;
              const text =
                isReplace && payload
                  ? String((payload as { text: string }).text)
                  : String(payload ?? "");

              const existingIdx = thinkingBlockToSegIdx.get(blockIndex);
              if (existingIdx !== undefined) {
                segments[existingIdx] = {
                  type: "thinking",
                  content: text,
                  blockIndex,
                };
              } else {
                thinkingBlockToSegIdx.set(blockIndex, segments.length);
                segments.push({
                  type: "thinking",
                  content: text,
                  blockIndex,
                });
              }
            }

            if (event.type === "tool_call") {
              const data = (event.data || {}) as {
                name?: unknown;
                args?: unknown;
              };
              const name = String(data.name || "");
              toolCalls.push({
                name,
                args: data.args,
              });
              segments.push({
                type: "tool",
                name,
                args: data.args,
              });
            }

            if (event.type === "tool_result") {
              const data = (event.data || {}) as {
                name?: unknown;
                result?: unknown;
                error?: unknown;
              };
              const name = String(data.name || "");
              const toolCall = [...toolCalls]
                .reverse()
                .find(
                  (item) => item.name === name && item.result === undefined,
                );
              if (toolCall) {
                toolCall.result = data.result;
                toolCall.error = Boolean(data.error);
              }
              const toolSeg = [...segments]
                .reverse()
                .find(
                  (segment) =>
                    segment.type === "tool" &&
                    segment.name === name &&
                    segment.result === undefined,
                );
              if (toolSeg && toolSeg.type === "tool") {
                toolSeg.result = data.result;
                toolSeg.error = Boolean(data.error);
              }
            }

            if (event.type === "error") {
              streamError = String(event.data || "background run failed");
            }
          }
        } finally {
          if (idleTimeoutHandle) {
            clearTimeout(idleTimeoutHandle);
          }
          clearTimeout(maxTimeoutHandle);
        }

        if (timeoutReason && !streamError) {
          streamError =
            timeoutReason === "idle"
              ? `Background run timed out after ${Math.round(
                  BACKGROUND_RUN_IDLE_TIMEOUT_MS / 1000,
                )}s of inactivity`
              : `Background run timed out after ${Math.round(
                  BACKGROUND_RUN_TIMEOUT_MS / 1000,
                )}s`;
        }
        if (streamError) {
          goalTrace("background.stream_error", {
            agentId: this.agentId,
            sessionId: goal.session_id,
            goalId: goal.id,
            runId,
            timeoutReason,
            streamError,
            elapsedMs: Date.now() - run.startedAtMs,
            eventCounts,
          });
        }

        let fullAnswer = segments
          .filter((segment) => segment.type === "text")
          .map((segment) => segment.content)
          .join("\n\n");

        if (!fullAnswer.trim() && streamError) {
          fullAnswer = `Error: ${streamError}`;
          segments.push({ type: "text", content: fullAnswer });
        }

        if (run.preemptRequested) {
          status = "aborted";
        } else if (streamError) {
          status = "failed";
          errorMessage = streamError;
        }

        if (streamTurnId) {
          await this.finalizeBackgroundTurnStream(
            goal.session_id,
            streamTurnId,
            {
              status,
              errorMessage,
              content: fullAnswer,
              toolCalls,
              segments,
            },
          ).catch((error) => {
            console.warn("Finalize background turn stream failed:", error);
          });
        }
      })();

      await run.donePromise;
    } catch (error) {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      resolveDonePromise();
      if (managed && ownsManagedRun) {
        managed.requiresCompletionCheckOnRestart = true;
        managed.currentRun = null;
        managed.currentGoal = null;
      }
      if (runId) {
        void this.endGoalRunWithTimeout(goal.id, runId, {
          status,
          errorMessage,
        }).catch((error) => {
          console.warn("Goal run finalization failed:", error);
        });
      }
      goalTrace("background.run_end", {
        agentId: this.agentId,
        sessionId: goal.session_id,
        goalId: goal.id,
        runId,
        status,
        errorMessage: errorMessage || null,
        durationMs: Date.now() - startedAtMs,
        firstEventLatencyMs:
          firstEventAtMs === null ? null : firstEventAtMs - startedAtMs,
        eventCounts,
        ownsManagedRun,
      });
    }
  }

  private async maybeHeartbeat(): Promise<void> {
    const hasRunning = Array.from(this.sessions.values()).some(
      (session) => session.currentRun !== null,
    );
    if (!hasRunning && this.lastActiveGoalCount <= 0) {
      return;
    }

    try {
      await this.internalFetch(
        `/api/internal/agents/${this.agentId}/stream-heartbeat`,
        {
          method: "POST",
          body: JSON.stringify({ source: "goal-session-manager" }),
        },
      );
    } catch (error) {
      console.warn("Goal session heartbeat failed:", error);
    }
  }

  private async fetchSessionBootstrap(
    sessionId: string,
  ): Promise<SessionBootstrapPayload> {
    const response = await this.internalFetch(
      `/api/internal/agents/${this.agentId}/sessions/${sessionId}/bootstrap`,
      { method: "GET" },
    );
    if (!response.ok) {
      throw new Error(
        `Bootstrap failed: ${response.status} ${response.statusText}`,
      );
    }
    const payload = (await response.json()) as SessionBootstrapPayload;
    return {
      systemPrompt:
        typeof payload.systemPrompt === "string" ? payload.systemPrompt : "",
      chatHistory: Array.isArray(payload.chatHistory)
        ? payload.chatHistory
        : [],
    };
  }

  private async listActiveGoals(): Promise<SessionGoal[]> {
    const response = await this.internalFetch(
      `/api/internal/agents/${this.agentId}/goals/active`,
      { method: "GET" },
    );
    if (!response.ok) {
      throw new Error(`List active goals failed: ${response.status}`);
    }
    const payload = (await response.json()) as { goals?: SessionGoal[] };
    return Array.isArray(payload.goals) ? payload.goals : [];
  }

  private async fetchSessionGoal(
    sessionId: string,
  ): Promise<SessionGoal | null> {
    const response = await this.internalFetch(
      `/api/internal/agents/${this.agentId}/sessions/${sessionId}/goal`,
      { method: "GET" },
    );
    if (!response.ok) {
      throw new Error(`Fetch session goal failed: ${response.status}`);
    }
    const payload = (await response.json()) as { goal?: SessionGoal | null };
    return payload.goal || null;
  }

  private async startGoalRun(
    goalId: string,
    runType: "foreground" | "background",
    trigger: string,
  ): Promise<StartRunPayload | null> {
    const response = await this.internalFetch(
      `/api/internal/agents/${this.agentId}/goals/${goalId}/runs`,
      {
        method: "POST",
        body: JSON.stringify({
          runType,
          trigger,
        }),
      },
    );
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 409
    ) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Start goal run failed: ${response.status}`);
    }
    return (await response.json()) as StartRunPayload;
  }

  private async endGoalRun(
    goalId: string,
    runId: string,
    payload: {
      status: "completed" | "failed" | "aborted";
      errorMessage?: string;
    },
  ): Promise<void> {
    const response = await this.internalFetch(
      `/api/internal/agents/${this.agentId}/goals/${goalId}/runs/${runId}/end`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      throw new Error(`End goal run failed: ${response.status}`);
    }
  }

  private async endGoalRunWithTimeout(
    goalId: string,
    runId: string,
    payload: {
      status: "completed" | "failed" | "aborted";
      errorMessage?: string;
    },
  ): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        this.endGoalRun(goalId, runId, payload),
        new Promise<void>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `End goal run timed out after ${GOAL_RUN_FINALIZE_TIMEOUT_MS}ms`,
              ),
            );
          }, GOAL_RUN_FINALIZE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async completeGoal(options: {
    goalId: string;
  }): Promise<
    | { ok: true; goal?: unknown }
    | { ok: false; error: string; statusCode?: number }
  > {
    const response = await this.internalFetch(
      `/api/internal/agents/${this.agentId}/goals/${options.goalId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        error: text || `Complete goal failed (${response.status})`,
        statusCode: response.status,
      };
    }
    const payload = (await response.json().catch(() => null)) as {
      goal?: unknown;
    } | null;
    return { ok: true, goal: payload?.goal };
  }

  private async startBackgroundTurnStream(
    sessionId: string,
  ): Promise<{ turnId: string }> {
    const response = await this.internalFetch(
      `/api/internal/agents/${this.agentId}/sessions/${sessionId}/background-turn/start`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Start background turn stream failed: ${response.status}`,
      );
    }
    const payload = (await response.json().catch(() => null)) as {
      turnId?: string;
    } | null;
    const turnId =
      payload && typeof payload.turnId === "string" ? payload.turnId : "";
    if (!turnId) {
      throw new Error("Start background turn stream returned no turnId");
    }
    return { turnId };
  }

  private async publishBackgroundTurnEvent(
    sessionId: string,
    turnId: string,
    event: StreamEvent,
  ): Promise<void> {
    const response = await this.internalFetch(
      `/api/internal/agents/${this.agentId}/sessions/${sessionId}/background-turn/${turnId}/event`,
      {
        method: "POST",
        body: JSON.stringify({
          event: {
            type: event.type,
            data: event.data,
            source: "goal_background",
            sessionId,
            turnId,
          },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Publish background turn event failed: ${response.status}`,
      );
    }
  }

  private async finalizeBackgroundTurnStream(
    sessionId: string,
    turnId: string,
    payload: {
      status: "completed" | "failed" | "aborted";
      errorMessage?: string;
      content: string;
      toolCalls: PersistedToolCall[];
      segments: PersistedAssistantSegment[];
    },
  ): Promise<void> {
    const response = await this.internalFetch(
      `/api/internal/agents/${this.agentId}/sessions/${sessionId}/background-turn/${turnId}/finalize`,
      {
        method: "POST",
        body: JSON.stringify({
          status: payload.status,
          errorMessage: payload.errorMessage,
          content: payload.content,
          toolCalls: payload.toolCalls,
          segments: payload.segments,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Finalize background turn stream failed: ${response.status}`,
      );
    }
  }

  private async internalFetch(
    endpoint: string,
    init: RequestInit,
  ): Promise<Response> {
    await this.ensureVmToken?.();
    const url = `${this.apiBaseUrl}${endpoint}`;
    let lastError: unknown;

    for (let attempt = 1; attempt <= INTERNAL_FETCH_MAX_ATTEMPTS; attempt++) {
      const token = this.getVmToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, INTERNAL_FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
          headers: {
            ...headers,
            ...(init.headers as Record<string, string> | undefined),
          },
        });

        if (response.status === 401 && attempt < INTERNAL_FETCH_MAX_ATTEMPTS) {
          await this.refreshVmToken?.().catch(() => {});
          await new Promise((resolve) =>
            setTimeout(resolve, INTERNAL_FETCH_RETRY_DELAY_MS),
          );
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;
        if (attempt < INTERNAL_FETCH_MAX_ATTEMPTS) {
          await this.refreshVmToken?.().catch(() => {});
          await new Promise((resolve) =>
            setTimeout(resolve, INTERNAL_FETCH_RETRY_DELAY_MS),
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    const reason =
      lastError instanceof Error ? lastError.message : String(lastError || "");
    throw new Error(`Internal fetch failed for ${endpoint}: ${reason}`);
  }
}
