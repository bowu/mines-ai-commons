import { type Request, type Response, Router } from "express";
import { config } from "../config.js";
import { withOrgContextQuery } from "../db/index.js";
import {
  combineSanitizeStats,
  hasSanitizationChanges,
  sanitizePersistableString,
  sanitizePersistableValue,
} from "../lib/persistable-sanitize.js";
import { requireAuthContext } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { validate } from "../middleware/validate.js";
import { subscribeSessionLiveEvents } from "../services/agent-chat/live-events.js";
import {
  InMemoryResumableTurnStore,
  type ResumableEvent,
  type ResumableEventInput,
} from "../services/agent-chat/resumable-turn-store.js";
import {
  checkSessionAccess,
  requireAgentAccess,
} from "../services/auth/acl.js";
import { isDeployDraining } from "../services/deploy/drain-state.js";
import type { AgentModelSelection } from "../services/pi-agent/session.js";
import { buildSystemPrompt } from "../services/pi-agent/stream.js";
import { refreshStreamLease } from "../services/sandbox/activity.js";
import {
  SandboxNotReadyError,
  ensureSandbox,
  listFiles as sandboxListFiles,
  chatStream as streamSandboxChat,
} from "../services/sandbox/client.js";
import { readInstalledSkillMarkdown } from "../services/skills/packages.js";
import {
  chatAgentParamsSchema,
  createSessionBodySchema,
  listSessionsParamsSchema,
  sendMessageBodySchema,
  sessionParamsSchema,
  sessionTurnParamsSchema,
  updateSessionBodySchema,
  upsertGoalBodySchema,
} from "./schemas/agent-chat.schema.js";

const router = Router();
const DEFAULT_SANDBOX_RETRY_AFTER_MS = 5000;
const agentChatRateLimit = createRateLimit({
  bucket: "agent_chat",
  maxRequests: config.agentChatRateLimitMax,
  windowMs: config.agentChatRateLimitWindowMs,
  key: (req) => {
    const { user } = requireAuthContext(req);
    const agentId = getRouteParam(req.params.agentId);
    return `${user.id}:${agentId}`;
  },
});

function getRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function resolveAgentModel(
  requestedModel: unknown,
  fallback: AgentModelSelection = "gemini-3.1-pro",
): AgentModelSelection {
  if (
    requestedModel === "gemini-3.1-pro" ||
    requestedModel === "sonnet-4.6" ||
    requestedModel === "opus-4.6" ||
    requestedModel === "gpt-5.2"
  ) {
    return requestedModel;
  }
  return fallback;
}

function hasCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object") return false;
  const obj = error as { code?: unknown; cause?: unknown };
  if (obj.code === code) return true;
  return hasCode(obj.cause, code);
}

function isRecoverableSandboxTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (msg.includes("terminated")) return true;
  if (msg.includes("econnrefused")) return true;
  if (msg.includes("connect timeout")) return true;
  return (
    hasCode(error, "UND_ERR_SOCKET") ||
    hasCode(error, "UND_ERR_CONNECT_TIMEOUT") ||
    hasCode(error, "ECONNREFUSED") ||
    hasCode(error, "ECONNRESET") ||
    hasCode(error, "ETIMEDOUT")
  );
}

const DEFAULT_AGENT_MODEL: AgentModelSelection = "gemini-3.1-pro";
const TURN_CHECKPOINT_FLUSH_INTERVAL_MS = 2_000;
const TURN_CHECKPOINT_MIN_DIRTY_BYTES = 16 * 1024;
const TURN_CHECKPOINT_REPLAY_TAIL_EVENTS = 200;
const TURN_CHECKPOINT_RETENTION_MS = 24 * 60 * 60 * 1000;
const TURN_CHECKPOINT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const TURN_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;
const TURN_STREAM_MAX_PENDING_BYTES = 1 * 1024 * 1024;
const turnCheckpointCleanupAtByOrg = new Map<string, number>();
let warnedUserMessageRecencyUpdateFailure = false;
const NO_OUTPUT_FALLBACK_MESSAGE = "Run completed with no user-facing output.";
const LEGACY_NO_OUTPUT_FALLBACK_MESSAGES = new Set([
  NO_OUTPUT_FALLBACK_MESSAGE,
  "I completed the run but did not produce a textual response. Please ask me to summarize what I built, or check the workspace files.",
  "I completed the autonomous goal run but did not produce a textual response.",
]);
const NOISY_FILE_EXTENSIONS = new Set([
  "aux",
  "log",
  "out",
  "toc",
  "synctex",
  "tmp",
  "pyc",
]);
const RESEARCH_DELIVERABLE_EXTENSIONS = new Set([
  "pdf",
  "docx",
  "xlsx",
  "csv",
  "tsv",
  "ppt",
  "pptx",
  "md",
  "txt",
  "html",
  "rtf",
  "odt",
  "ods",
  "json",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "svg",
  "gif",
]);

function getExtension(filePath: string): string {
  const last = filePath.split("/").pop() || "";
  const dot = last.lastIndexOf(".");
  return dot === -1 ? "" : last.slice(dot + 1).toLowerCase();
}

function parseDeadline(value: unknown): Date | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid deadlineAt");
  }
  return parsed;
}

function isPastOrNow(value: Date): boolean {
  return value.getTime() <= Date.now();
}

function normalizeOutputFolder(value: string): string {
  // Empty string means workspace root.
  return value.replace(/^\/+|\/+$/g, "").trim();
}

function normalizePathCandidate(rawPath: string, baseDir = ""): string | null {
  let cleaned = decodeURIComponent(String(rawPath || ""))
    .replace(/^file:\/\//i, "")
    .replace(/^['"`(\[]+|['"`)\],;:]+$/g, "")
    .replace(/\\/g, "/")
    .trim();
  if (!cleaned || cleaned.split("/").some((seg) => seg === "..")) return null;

  const sandboxWorkspaceMarker = "/sandbox-workspace/";
  const markerIndex = cleaned.lastIndexOf(sandboxWorkspaceMarker);
  if (markerIndex >= 0) {
    cleaned = cleaned.slice(markerIndex + sandboxWorkspaceMarker.length);
  }

  if (cleaned.startsWith("/workspace/")) {
    cleaned = cleaned.slice("/workspace/".length);
  } else if (cleaned.startsWith("workspace/")) {
    cleaned = cleaned.slice("workspace/".length);
  }

  const noLeadingSlash = cleaned.replace(/^\/+/, "").replace(/^\.\/+/, "");
  if (!noLeadingSlash) return null;
  if (baseDir && !noLeadingSlash.includes("/")) {
    return `${baseDir.replace(/^\/+|\/+$/g, "")}/${noLeadingSlash}`;
  }
  return noLeadingSlash;
}

function encodeFileLinkPath(relativePath: string): string {
  return relativePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function flattenSandboxFiles(
  items: unknown[],
  out: Set<string> = new Set(),
): Set<string> {
  for (const item of items) {
    const f = item as { path?: string; type?: string; children?: unknown[] };
    if (f.type === "file" && f.path) out.add(f.path);
    if (Array.isArray(f.children)) flattenSandboxFiles(f.children, out);
  }
  return out;
}

async function touchAgentUserMessageRecency(
  orgId: string,
  agentId: string,
): Promise<void> {
  try {
    await withOrgContextQuery(
      orgId,
      `UPDATE agents
       SET last_user_message_at = NOW()
       WHERE id = $1`,
      [agentId],
    );
  } catch (error) {
    if (warnedUserMessageRecencyUpdateFailure) return;
    warnedUserMessageRecencyUpdateFailure = true;
    console.warn(
      "Failed to update agent last_user_message_at; falling back to existing ordering:",
      error,
    );
  }
}

async function filterExistingWorkspacePaths(
  orgId: string,
  agentId: string,
  candidatePaths: string[],
): Promise<string[]> {
  const unique = Array.from(new Set(candidatePaths));
  if (unique.length === 0) return [];
  try {
    const data = (await sandboxListFiles(orgId, agentId)) as {
      files?: unknown[];
    };
    const existingPaths = flattenSandboxFiles(data.files ?? []);
    return unique.filter((p) => existingPaths.has(p));
  } catch {
    // Sandbox not reachable — trust the agent and pass all paths through.
    return unique;
  }
}

async function sanitizeAnswerFileLinks(
  orgId: string,
  agentId: string,
  text: string,
): Promise<string> {
  if (!text) return text;
  const linkPattern = /(!?)\[([^\]]+)\]\(file:\/\/([^)]+)\)/g;
  const links = Array.from(text.matchAll(linkPattern));
  if (links.length === 0) return text;

  const normalizedPaths = links
    .map((m) => normalizePathCandidate(m[3]))
    .filter((p): p is string => Boolean(p));
  const existingSet = new Set(
    await filterExistingWorkspacePaths(orgId, agentId, normalizedPaths),
  );

  return text.replace(
    linkPattern,
    (_full, imagePrefix: string, label: string, rawPath: string) => {
      const normalized = normalizePathCandidate(rawPath);
      if (normalized && existingSet.has(normalized)) {
        return `${imagePrefix}[${label}](file://${encodeFileLinkPath(normalized)})`;
      }
      return `\`${label}\` (file not found)`;
    },
  );
}

function getCommandBaseDir(command: string): string {
  const match = command.match(/^\s*cd\s+(['"]?)([^'"&;|]+)\1\s*&&/);
  if (!match) return "";
  const dir = normalizePathCandidate(match[2]) || "";
  return dir.replace(/\/+$/, "");
}

function collectPathsFromText(
  text: string,
  baseDir: string,
  out: Set<string>,
): void {
  const add = (candidate: string) => {
    const normalized = normalizePathCandidate(candidate, baseDir);
    if (normalized) out.add(normalized);
  };

  const hintPatterns = [
    /output written on\s+([^\s)]+)/gi,
    /saved as\s+([^\s)]+)/gi,
    /saved to\s+([^\s)]+)/gi,
    /written to\s+([^\s)]+)/gi,
    /wrote [^\n]* to\s+([^\s)]+)/gi,
    /generated(?:\s+at)?\s+([^\s)]+)/gi,
    /created(?:\s+at)?\s+([^\s)]+)/gi,
  ];
  for (const pattern of hintPatterns) {
    for (const match of text.matchAll(pattern)) {
      add(match[1]);
    }
  }

  const genericPathPattern =
    /(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,10}/g;
  for (const match of text.matchAll(genericPathPattern)) {
    add(match[0]);
  }
}

function collectPathsFromUnknown(
  value: unknown,
  baseDir: string,
  out: Set<string>,
): void {
  if (value == null) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectPathsFromUnknown(JSON.parse(trimmed), baseDir, out);
      } catch {
        // Continue parsing as plain text below.
      }
    }
    collectPathsFromText(value, baseDir, out);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPathsFromUnknown(item, baseDir, out);
    return;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const pathKeys = [
      "path",
      "file",
      "file_path",
      "filePath",
      "output",
      "output_path",
      "outputPath",
    ];
    for (const key of pathKeys) {
      if (typeof obj[key] === "string") {
        const normalized = normalizePathCandidate(obj[key] as string, baseDir);
        if (normalized) out.add(normalized);
      }
    }
    for (const nested of Object.values(obj)) {
      collectPathsFromUnknown(nested, baseDir, out);
    }
  }
}

function extractProducedPathsFromToolCalls(toolCalls: any[]): string[] {
  const paths = new Set<string>();

  for (const tc of toolCalls) {
    if (!tc || tc.error) continue;
    const toolName = String(tc.name || "");
    const args = (tc.args || {}) as Record<string, unknown>;
    const baseDir =
      toolName === "bash" && typeof args.command === "string"
        ? getCommandBaseDir(args.command)
        : "";

    if (typeof args.path === "string") {
      const argPath = normalizePathCandidate(args.path, baseDir);
      if (argPath) paths.add(argPath);
    }
    collectPathsFromUnknown(tc.result, baseDir, paths);
  }

  return Array.from(paths);
}

async function buildProducedFilesMessage(
  orgId: string,
  agentId: string,
  toolCalls: any[],
  outputFolder?: string,
): Promise<string | null> {
  const extractedPaths = extractProducedPathsFromToolCalls(toolCalls);
  const candidatePaths = await filterExistingWorkspacePaths(
    orgId,
    agentId,
    extractedPaths,
  );
  const filtered = Array.from(new Set(candidatePaths)).filter((p) => {
    const ext = getExtension(p);
    return (
      ext.length > 0 &&
      !NOISY_FILE_EXTENSIONS.has(ext) &&
      RESEARCH_DELIVERABLE_EXTENSIONS.has(ext)
    );
  });
  if (filtered.length === 0) return null;

  const preferredOutputPrefix = (outputFolder || "").replace(/^\/+|\/+$/g, "");
  const inPreferredOutput = (p: string) =>
    preferredOutputPrefix
      ? p === preferredOutputPrefix || p.startsWith(`${preferredOutputPrefix}/`)
      : false;
  const preferred = [
    "pdf",
    "docx",
    "xlsx",
    "csv",
    "tsv",
    "ppt",
    "pptx",
    "md",
    "txt",
    "html",
    "rtf",
    "odt",
    "ods",
    "json",
    "png",
    "jpg",
    "jpeg",
    "webp",
    "svg",
    "gif",
  ];
  const rank = new Map(preferred.map((ext, idx) => [ext, idx]));
  filtered.sort((a, b) => {
    const aInOutput = inPreferredOutput(a);
    const bInOutput = inPreferredOutput(b);
    if (aInOutput !== bInOutput) return aInOutput ? -1 : 1;
    const ra = rank.get(getExtension(a)) ?? 999;
    const rb = rank.get(getExtension(b)) ?? 999;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
  const selected = filtered.slice(0, 6);

  if (selected.length === 1) {
    const p = selected[0];
    const name = p.split("/").pop() || p;
    return `Created file: [${name}](file://${encodeFileLinkPath(p)})`;
  }

  const bullets = selected
    .map((p) => {
      const name = p.split("/").pop() || p;
      return `- [${name}](file://${encodeFileLinkPath(p)})`;
    })
    .join("\n");
  return `Created files:\n\n${bullets}`;
}

async function shouldEmitNoOutputFallback(
  orgId: string,
  sessionId: string,
): Promise<boolean> {
  const lastAssistant = await withOrgContextQuery<{ content: string }>(
    orgId,
    `SELECT content
       FROM agent_chat_messages
      WHERE session_id = $1
        AND role = 'assistant'
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId],
  );
  const previous = String(lastAssistant.rows[0]?.content || "").trim();
  if (!previous) return true;
  return !LEGACY_NO_OUTPUT_FALLBACK_MESSAGES.has(previous);
}

const resumableTurnStore = new InMemoryResumableTurnStore({
  maxEventBytes: config.chatResumableMaxEventBytes,
  maxEventsPerTurn: config.chatResumableMaxEventsPerTurn,
  maxTurnBytes: config.chatResumableMaxTurnBytes,
  maxActiveTurns: config.chatResumableMaxActiveTurns,
  ttlAfterCloseMs: config.chatResumableTtlMs,
});
const resumableTurnAbortControllers = new Map<string, AbortController>();
type TurnSource = "foreground" | "goal_background";
const turnSourceById = new Map<string, TurnSource>();

function setTurnSource(turnId: string, source: TurnSource): void {
  turnSourceById.set(turnId, source);
}

function clearTurnSource(turnId: string): void {
  turnSourceById.delete(turnId);
}

function getTurnSource(turnId: string): TurnSource | null {
  return turnSourceById.get(turnId) || null;
}

function getRunningTurnWithSource(sessionId: string): {
  turnId: string;
  source: TurnSource;
} | null {
  const turnId = resumableTurnStore.getRunningTurnId(sessionId);
  if (!turnId) return null;
  return {
    turnId,
    source: getTurnSource(turnId) || "foreground",
  };
}

type AssistantSegment =
  | { type: "text"; content: string; blockIndex?: number }
  | { type: "thinking"; content: string; blockIndex?: number }
  | {
      type: "tool";
      name: string;
      args?: any;
      result?: any;
      error?: boolean;
    };

function toResumableEventInput(event: unknown): ResumableEventInput | null {
  if (!event || typeof event !== "object") return null;
  const raw = event as { type?: unknown; data?: unknown; source?: unknown };
  if (typeof raw.type !== "string" || !raw.type.trim()) return null;
  return {
    type: raw.type,
    data: raw.data,
    source: typeof raw.source === "string" ? raw.source : undefined,
  };
}

function parseFromSeq(raw: unknown): number {
  if (typeof raw !== "string") return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

interface TurnCheckpointSnapshot {
  session_id: string;
  turn_id: string;
  status: string;
  last_seq: number;
  assistant_content: string;
  tool_calls: unknown;
  segments: unknown;
  last_event_at: Date;
  updated_at: Date;
}

function normalizeJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function logSanitizedPersistence(
  scope: string,
  context: Record<string, unknown>,
  stats: {
    stringsSanitized: number;
    nullBytesRemoved: number;
    invalidSurrogatesReplaced: number;
    circularRefsReplaced: number;
  },
): void {
  if (!hasSanitizationChanges(stats)) return;
  console.warn("[agent_chat] sanitized persistable payload", {
    scope,
    ...context,
    ...stats,
  });
}

function hasCompleteGoalToolCall(toolCalls: unknown[]): boolean {
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue;
    const name = (call as { name?: unknown }).name;
    if (typeof name === "string" && name.trim() === "complete_goal") {
      return true;
    }
  }
  return false;
}

async function completeRequestedGoalForSession(
  orgId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await withOrgContextQuery<{ id: string }>(
    orgId,
    `UPDATE agent_session_goals
     SET status = 'completed',
         status_reason = NULL,
         completed_at = COALESCE(completed_at, NOW()),
         updated_at = NOW()
     WHERE session_id = $1
       AND status = 'active'
       AND status_reason = 'completion_requested'
     RETURNING id`,
    [sessionId],
  );
  return result.rows.length > 0;
}

async function upsertTurnCheckpoint(
  orgId: string,
  sessionId: string,
  turnId: string,
  payload: {
    status: "running" | "done" | "error" | "cancelled";
    lastSeq: number;
    assistantContent: string;
    toolCalls: unknown[];
    segments: unknown[];
  },
): Promise<void> {
  const sanitizedContent = sanitizePersistableString(payload.assistantContent);
  const sanitizedToolCalls = sanitizePersistableValue(payload.toolCalls);
  const sanitizedSegments = sanitizePersistableValue(payload.segments);
  const combinedStats = combineSanitizeStats(
    sanitizedContent.stats,
    sanitizedToolCalls.stats,
    sanitizedSegments.stats,
  );
  logSanitizedPersistence(
    "turn_checkpoint",
    { sessionId, turnId, status: payload.status },
    combinedStats,
  );

  await withOrgContextQuery(
    orgId,
    `INSERT INTO agent_chat_turn_checkpoints (
       session_id, turn_id, status, last_seq, assistant_content,
       tool_calls, segments, last_event_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NOW(), NOW())
     ON CONFLICT (session_id, turn_id) DO UPDATE
     SET status = EXCLUDED.status,
         last_seq = GREATEST(agent_chat_turn_checkpoints.last_seq, EXCLUDED.last_seq),
         assistant_content = EXCLUDED.assistant_content,
         tool_calls = EXCLUDED.tool_calls,
         segments = EXCLUDED.segments,
         last_event_at = NOW(),
         updated_at = NOW()`,
    [
      sessionId,
      turnId,
      payload.status,
      payload.lastSeq,
      sanitizedContent.value,
      JSON.stringify(sanitizedToolCalls.value),
      JSON.stringify(sanitizedSegments.value),
    ],
  );
}

async function readTurnCheckpoint(
  orgId: string,
  sessionId: string,
  turnId: string,
): Promise<TurnCheckpointSnapshot | null> {
  const result = await withOrgContextQuery<TurnCheckpointSnapshot>(
    orgId,
    `SELECT session_id, turn_id, status, last_seq, assistant_content,
            tool_calls, segments, last_event_at, updated_at
       FROM agent_chat_turn_checkpoints
      WHERE session_id = $1
        AND turn_id = $2
      LIMIT 1`,
    [sessionId, turnId],
  );
  return result.rows[0] || null;
}

async function deleteTurnCheckpoint(
  orgId: string,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await withOrgContextQuery(
    orgId,
    `DELETE FROM agent_chat_turn_checkpoints
      WHERE session_id = $1
        AND turn_id = $2`,
    [sessionId, turnId],
  );
}

async function cleanupStaleTurnCheckpoints(orgId: string): Promise<void> {
  await withOrgContextQuery(
    orgId,
    `DELETE FROM agent_chat_turn_checkpoints
      WHERE status <> 'running'
        AND updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
    [TURN_CHECKPOINT_RETENTION_MS],
  );
}

function shouldRunCheckpointCleanup(
  orgId: string,
  nowMs = Date.now(),
): boolean {
  const lastRunAt = turnCheckpointCleanupAtByOrg.get(orgId) || 0;
  if (nowMs - lastRunAt < TURN_CHECKPOINT_CLEANUP_INTERVAL_MS) {
    return false;
  }
  turnCheckpointCleanupAtByOrg.set(orgId, nowMs);
  return true;
}

function hasCheckpointData(snapshot: TurnCheckpointSnapshot | null): boolean {
  if (!snapshot) return false;
  if (snapshot.assistant_content.trim().length > 0) return true;
  if (normalizeJsonArray(snapshot.tool_calls).length > 0) return true;
  if (normalizeJsonArray(snapshot.segments).length > 0) return true;
  return false;
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    return 0;
  }
}

type BufferedSseWriter = {
  sendData: (event: unknown) => boolean;
  sendComment: (comment?: string) => boolean;
  close: () => void;
  isClosed: () => boolean;
};

function createBufferedSseWriter(
  res: Response,
  options?: { maxPendingBytes?: number },
): BufferedSseWriter {
  const maxPendingBytes =
    options?.maxPendingBytes ?? TURN_STREAM_MAX_PENDING_BYTES;
  let closed = false;
  let writing = false;
  let pendingBytes = 0;
  const queue: Array<{ frame: string; bytes: number }> = [];

  const markClosed = () => {
    closed = true;
  };
  res.on("close", markClosed);
  res.on("error", markClosed);

  const waitForDrain = () =>
    new Promise<void>((resolve) => {
      if (closed || res.writableEnded || res.destroyed) {
        resolve();
        return;
      }
      const cleanup = () => {
        res.off("drain", onDrain);
        res.off("close", onClose);
        res.off("error", onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      res.once("drain", onDrain);
      res.once("close", onClose);
      res.once("error", onClose);
    });

  const flush = async () => {
    if (writing || closed) return;
    writing = true;
    try {
      while (!closed && queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        pendingBytes = Math.max(0, pendingBytes - next.bytes);

        if (res.writableEnded || res.destroyed) {
          closed = true;
          break;
        }

        let wrote = false;
        try {
          wrote = res.write(next.frame);
        } catch {
          closed = true;
          break;
        }

        if (!wrote) {
          await waitForDrain();
        }
      }
    } finally {
      writing = false;
      if (!closed && queue.length > 0) {
        void flush();
      }
    }
  };

  const enqueue = (frame: string): boolean => {
    if (closed || res.writableEnded || res.destroyed) return false;
    const bytes = Buffer.byteLength(frame, "utf8");
    if (pendingBytes + bytes > maxPendingBytes) {
      closed = true;
      try {
        res.end();
      } catch {
        // ignore close errors
      }
      return false;
    }
    queue.push({ frame, bytes });
    pendingBytes += bytes;
    void flush();
    return true;
  };

  return {
    sendData: (event: unknown) => enqueue(`data: ${JSON.stringify(event)}\n\n`),
    sendComment: (comment = "ping") => enqueue(`: ${comment}\n\n`),
    close: () => {
      if (closed) return;
      closed = true;
      try {
        res.end();
      } catch {
        // ignore close errors
      }
    },
    isClosed: () => closed || res.writableEnded || res.destroyed,
  };
}

async function resolveOrCreateSessionId(
  orgId: string,
  agentId: string,
  userId: string,
  requestedSessionId?: string,
): Promise<string> {
  if (requestedSessionId) {
    return requestedSessionId;
  }

  const latestSessionResult = await withOrgContextQuery(
    orgId,
    `SELECT id
       FROM agent_chat_sessions
      WHERE agent_id = $1
        AND created_by = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [agentId, userId],
  );
  if (latestSessionResult.rows.length > 0) {
    return latestSessionResult.rows[0].id;
  }

  const sessionResult = await withOrgContextQuery(
    orgId,
    `INSERT INTO agent_chat_sessions (agent_id, created_by)
     VALUES ($1, $2)
     RETURNING id`,
    [agentId, userId],
  );
  return sessionResult.rows[0].id;
}

async function fetchSessionModel(
  orgId: string,
  sessionId: string,
): Promise<AgentModelSelection | null> {
  const result = await withOrgContextQuery<{ model: string | null }>(
    orgId,
    `SELECT model
       FROM agent_chat_sessions
      WHERE id = $1
      LIMIT 1`,
    [sessionId],
  );
  if (result.rows.length === 0) return null;
  return resolveAgentModel(result.rows[0].model, DEFAULT_AGENT_MODEL);
}

async function persistSessionModel(
  orgId: string,
  sessionId: string,
  model: AgentModelSelection,
): Promise<void> {
  await withOrgContextQuery(
    orgId,
    `UPDATE agent_chat_sessions
     SET model = $1
     WHERE id = $2
       AND model IS DISTINCT FROM $1`,
    [model, sessionId],
  );
}

interface BackgroundTurnState {
  orgId: string;
  agentId: string;
  sessionId: string;
  turnId: string;
  toolCalls: any[];
  segments: AssistantSegment[];
  textBlockToSegIdx: Map<number, number>;
  thinkingBlockToSegIdx: Map<number, number>;
  checkpointFlushTimer: NodeJS.Timeout | null;
  checkpointInFlight: Promise<void> | null;
  checkpointRetryNeeded: boolean;
  checkpointLastObservedSeq: number;
  checkpointLastFlushedSeq: number;
  checkpointDirtyBytes: number;
  sawTerminalEvent: boolean;
}

const backgroundTurnStates = new Map<string, BackgroundTurnState>();

function buildAssistantContent(segments: AssistantSegment[]): string {
  return segments
    .filter((segment) => segment.type === "text")
    .map((segment) => (segment as { content: string }).content)
    .join("\n\n");
}

function applyResumableEventToSegments(
  state: BackgroundTurnState,
  event: ResumableEventInput,
): void {
  if (event.type === "text") {
    const payload = event.data;
    const blockIndex =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { blockIndex?: unknown }).blockIndex === "number"
        ? ((payload as { blockIndex: number }).blockIndex ?? 0)
        : 0;
    const text =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { text?: unknown }).text === "string"
        ? String((payload as { text: string }).text)
        : typeof payload === "string"
          ? payload
          : String(payload ?? "");

    const existingIdx = state.textBlockToSegIdx.get(blockIndex);
    if (existingIdx !== undefined) {
      (
        state.segments[existingIdx] as {
          type: "text";
          content: string;
          blockIndex?: number;
        }
      ).content = text;
    } else {
      state.textBlockToSegIdx.set(blockIndex, state.segments.length);
      state.segments.push({ type: "text", content: text, blockIndex });
    }
  }

  if (event.type === "thinking") {
    const payload = event.data;
    const blockIndex =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { blockIndex?: unknown }).blockIndex === "number"
        ? ((payload as { blockIndex: number }).blockIndex ?? 0)
        : 0;
    const text =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { text?: unknown }).text === "string"
        ? String((payload as { text: string }).text)
        : typeof payload === "string"
          ? payload
          : String(payload ?? "");

    const existingIdx = state.thinkingBlockToSegIdx.get(blockIndex);
    if (existingIdx !== undefined) {
      (
        state.segments[existingIdx] as {
          type: "thinking";
          content: string;
          blockIndex?: number;
        }
      ).content = text;
    } else {
      state.thinkingBlockToSegIdx.set(blockIndex, state.segments.length);
      state.segments.push({ type: "thinking", content: text, blockIndex });
    }
  }

  if (event.type === "tool_call") {
    const payload =
      event.data && typeof event.data === "object"
        ? (event.data as Record<string, unknown>)
        : {};
    state.toolCalls.push({ ...payload, result: null, error: false });
    state.segments.push({
      type: "tool",
      name: String(payload.name || ""),
      args: payload.args,
      result: null,
      error: false,
    });
  }

  if (event.type === "tool_result") {
    const payload =
      event.data && typeof event.data === "object"
        ? (event.data as Record<string, unknown>)
        : {};
    const toolName = String(payload.name || "");
    const tc = [...state.toolCalls]
      .reverse()
      .find((tool) => tool.name === toolName && tool.result === null);
    if (tc) {
      tc.result = payload.result;
      tc.error = Boolean(payload.error);
    }

    const seg = [...state.segments]
      .reverse()
      .find(
        (segment) =>
          segment.type === "tool" &&
          segment.name === toolName &&
          segment.result === null,
      ) as
      | { type: "tool"; name: string; result?: unknown; error?: boolean }
      | undefined;
    if (seg) {
      seg.result = payload.result;
      seg.error = Boolean(payload.error);
    }
  }
}

async function flushBackgroundTurnCheckpoint(
  state: BackgroundTurnState,
  status: "running" | "done" | "error" | "cancelled" = "running",
  force = false,
): Promise<void> {
  if (state.checkpointInFlight) {
    if (!force) {
      return;
    }
    await state.checkpointInFlight;
  }

  if (
    !force &&
    !state.checkpointRetryNeeded &&
    state.checkpointLastObservedSeq <= state.checkpointLastFlushedSeq &&
    state.checkpointDirtyBytes < TURN_CHECKPOINT_MIN_DIRTY_BYTES
  ) {
    return;
  }

  const snapshotSeq = state.checkpointLastObservedSeq;
  const snapshotContent = buildAssistantContent(state.segments);
  const snapshotToolCalls = [...state.toolCalls];
  const snapshotSegments = [...state.segments];
  const shouldPersistCheckpoint =
    snapshotSeq > 0 ||
    snapshotContent.trim().length > 0 ||
    snapshotToolCalls.length > 0 ||
    snapshotSegments.length > 0;
  if (!shouldPersistCheckpoint && !force) {
    return;
  }

  state.checkpointInFlight = (async () => {
    try {
      if (shouldPersistCheckpoint) {
        await upsertTurnCheckpoint(state.orgId, state.sessionId, state.turnId, {
          status,
          lastSeq: snapshotSeq,
          assistantContent: snapshotContent,
          toolCalls: snapshotToolCalls,
          segments: snapshotSegments,
        });

        state.checkpointLastFlushedSeq = Math.max(
          state.checkpointLastFlushedSeq,
          snapshotSeq,
        );
        state.checkpointDirtyBytes = 0;
        state.checkpointRetryNeeded = false;
        const keepFromSeq = Math.max(
          1,
          state.checkpointLastFlushedSeq -
            TURN_CHECKPOINT_REPLAY_TAIL_EVENTS +
            1,
        );
        resumableTurnStore.trimBeforeSeq(state.turnId, keepFromSeq);
      } else {
        state.checkpointLastFlushedSeq = Math.max(
          state.checkpointLastFlushedSeq,
          snapshotSeq,
        );
      }
    } catch (error) {
      state.checkpointRetryNeeded = true;
      console.error("Background turn checkpoint flush failed:", {
        sessionId: state.sessionId,
        turnId: state.turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  await state.checkpointInFlight;
  state.checkpointInFlight = null;
}

function stopBackgroundCheckpointTimer(state: BackgroundTurnState): void {
  if (!state.checkpointFlushTimer) return;
  clearInterval(state.checkpointFlushTimer);
  state.checkpointFlushTimer = null;
}

export async function startBackgroundResumableTurn(params: {
  orgId: string;
  agentId: string;
  sessionId: string;
}): Promise<
  | { ok: true; turnId: string }
  | {
      ok: false;
      reason: "session_busy" | "capacity_exhausted";
      turnId?: string;
    }
> {
  const running = getRunningTurnWithSource(params.sessionId);
  if (running) {
    if (running.source === "goal_background") {
      return { ok: true, turnId: running.turnId };
    }
    return { ok: false, reason: "session_busy", turnId: running.turnId };
  }

  const created = resumableTurnStore.createTurn(params.sessionId);
  if (!created.ok || !created.turnId) {
    if (created.reason === "already_running" && created.turnId) {
      const source = getTurnSource(created.turnId);
      if (source === "goal_background") {
        return { ok: true, turnId: created.turnId };
      }
      return { ok: false, reason: "session_busy", turnId: created.turnId };
    }
    return { ok: false, reason: "capacity_exhausted" };
  }

  const turnId = created.turnId;
  setTurnSource(turnId, "goal_background");

  const state: BackgroundTurnState = {
    orgId: params.orgId,
    agentId: params.agentId,
    sessionId: params.sessionId,
    turnId,
    toolCalls: [],
    segments: [],
    textBlockToSegIdx: new Map<number, number>(),
    thinkingBlockToSegIdx: new Map<number, number>(),
    checkpointFlushTimer: null,
    checkpointInFlight: null,
    checkpointRetryNeeded: false,
    checkpointLastObservedSeq: 0,
    checkpointLastFlushedSeq: 0,
    checkpointDirtyBytes: 0,
    sawTerminalEvent: false,
  };
  state.checkpointFlushTimer = setInterval(() => {
    if (
      state.checkpointRetryNeeded ||
      state.checkpointLastObservedSeq > state.checkpointLastFlushedSeq ||
      state.checkpointDirtyBytes >= TURN_CHECKPOINT_MIN_DIRTY_BYTES
    ) {
      void flushBackgroundTurnCheckpoint(state, "running");
    }
  }, TURN_CHECKPOINT_FLUSH_INTERVAL_MS);
  backgroundTurnStates.set(turnId, state);
  return { ok: true, turnId };
}

export async function appendBackgroundResumableTurnEvent(params: {
  turnId: string;
  event: ResumableEventInput;
}): Promise<{ ok: true; seq: number } | { ok: false; reason: "not_found" }> {
  const state = backgroundTurnStates.get(params.turnId);
  if (!state) {
    return { ok: false, reason: "not_found" };
  }

  const event = {
    ...params.event,
    source: "goal_background",
  } satisfies ResumableEventInput;

  const appended = resumableTurnStore.appendEvent(state.turnId, event);
  if (!appended) {
    return { ok: false, reason: "not_found" };
  }

  state.checkpointLastObservedSeq = Math.max(
    state.checkpointLastObservedSeq,
    appended.seq,
  );
  state.checkpointDirtyBytes += byteLength(appended.data) + 24;
  applyResumableEventToSegments(state, event);

  if (event.type === "done" || event.type === "error") {
    state.sawTerminalEvent = true;
  }

  if (state.checkpointDirtyBytes >= TURN_CHECKPOINT_MIN_DIRTY_BYTES) {
    void flushBackgroundTurnCheckpoint(state, "running");
  }

  return { ok: true, seq: appended.seq };
}

export async function finalizeBackgroundResumableTurn(params: {
  turnId: string;
  status: "completed" | "failed" | "aborted";
  errorMessage?: string;
  content?: string;
  toolCalls?: unknown[];
  segments?: unknown[];
}): Promise<void> {
  const state = backgroundTurnStates.get(params.turnId) || null;

  if (state && !state.sawTerminalEvent) {
    if (
      (params.status === "failed" || params.status === "aborted") &&
      params.errorMessage
    ) {
      await appendBackgroundResumableTurnEvent({
        turnId: params.turnId,
        event: {
          type: "error",
          data: params.errorMessage,
          source: "goal_background",
        },
      });
    }
    await appendBackgroundResumableTurnEvent({
      turnId: params.turnId,
      event: {
        type: "done",
        source: "goal_background",
      },
    });
  }

  const rawToolCalls = Array.isArray(params.toolCalls) ? params.toolCalls : [];
  const rawSegments = Array.isArray(params.segments) ? params.segments : [];

  let content =
    typeof params.content === "string"
      ? params.content
      : state
        ? buildAssistantContent(state.segments)
        : "";
  const toolCalls =
    rawToolCalls.length > 0 ? rawToolCalls : state ? [...state.toolCalls] : [];
  const segments =
    rawSegments.length > 0 ? rawSegments : state ? [...state.segments] : [];
  const requestedGoalCompletion = hasCompleteGoalToolCall(toolCalls);

  let assistantPersisted = false;
  if (state && (content.trim().length > 0 || toolCalls.length > 0)) {
    content = await sanitizeAnswerFileLinks(
      state.orgId,
      state.agentId,
      content,
    );
    const sanitizedContent = sanitizePersistableString(content);
    const sanitizedToolCalls = sanitizePersistableValue(toolCalls);
    const sanitizedSegments = sanitizePersistableValue(segments);
    const combinedStats = combineSanitizeStats(
      sanitizedContent.stats,
      sanitizedToolCalls.stats,
      sanitizedSegments.stats,
    );
    logSanitizedPersistence(
      "background_finalize",
      {
        sessionId: state.sessionId,
        turnId: params.turnId,
        status: params.status,
      },
      combinedStats,
    );

    await withOrgContextQuery(
      state.orgId,
      `INSERT INTO agent_chat_messages (session_id, role, content, tool_calls, segments)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        state.sessionId,
        "assistant",
        sanitizedContent.value,
        JSON.stringify(sanitizedToolCalls.value),
        JSON.stringify(sanitizedSegments.value),
      ],
    );
    await withOrgContextQuery(
      state.orgId,
      `UPDATE agent_chat_sessions SET updated_at = NOW() WHERE id = $1`,
      [state.sessionId],
    );
    if (requestedGoalCompletion) {
      await completeRequestedGoalForSession(state.orgId, state.sessionId);
    }
    assistantPersisted = true;
  }

  const terminalStatus: "done" | "error" =
    params.status === "completed" ? "done" : "error";

  if (state) {
    stopBackgroundCheckpointTimer(state);
    await flushBackgroundTurnCheckpoint(
      state,
      terminalStatus === "done" ? "done" : "error",
      true,
    );
    if (assistantPersisted) {
      await deleteTurnCheckpoint(
        state.orgId,
        state.sessionId,
        params.turnId,
      ).catch((error) => {
        console.warn(
          "Failed to delete completed background turn checkpoint:",
          error,
        );
      });
    }
    if (shouldRunCheckpointCleanup(state.orgId)) {
      void cleanupStaleTurnCheckpoints(state.orgId).catch((error) => {
        console.warn(
          "Failed to cleanup stale background turn checkpoints:",
          error,
        );
      });
    }
  }

  resumableTurnStore.closeTurnIfRunning(params.turnId, terminalStatus);
  clearTurnSource(params.turnId);
  backgroundTurnStates.delete(params.turnId);
}

async function runResumableTurn(params: {
  orgId: string;
  userId: string;
  agentId: string;
  sessionId: string;
  message: string;
  outputFolder?: string;
  selectedModel: AgentModelSelection;
  turnId: string;
  abortController: AbortController;
}): Promise<void> {
  const {
    orgId,
    userId,
    agentId,
    sessionId,
    message,
    outputFolder,
    selectedModel,
    turnId,
    abortController,
  } = params;
  const turnSource = getTurnSource(turnId) || "foreground";
  let leaseRefreshInterval: NodeJS.Timeout | null = null;
  const toolCalls: any[] = [];
  const segments: AssistantSegment[] = [];
  let streamError: string | null = null;
  let terminalStatus: "done" | "error" = "done";
  let assistantPersisted = false;
  let checkpointFlushTimer: NodeJS.Timeout | null = null;
  let checkpointInFlight: Promise<void> | null = null;
  let checkpointRetryNeeded = false;
  let checkpointLastObservedSeq = 0;
  let checkpointLastFlushedSeq = 0;
  let checkpointDirtyBytes = 0;

  const stopLeaseRefresh = () => {
    if (!leaseRefreshInterval) return;
    clearInterval(leaseRefreshInterval);
    leaseRefreshInterval = null;
  };

  const stopCheckpointFlushTimer = () => {
    if (!checkpointFlushTimer) return;
    clearInterval(checkpointFlushTimer);
    checkpointFlushTimer = null;
  };

  const emit = (event: ResumableEventInput): ResumableEvent | null => {
    const appended = resumableTurnStore.appendEvent(turnId, event);
    if (appended) {
      checkpointLastObservedSeq = Math.max(
        checkpointLastObservedSeq,
        appended.seq,
      );
      checkpointDirtyBytes += byteLength(appended.data) + 24;
    }
    return appended;
  };

  const getFullAnswer = () =>
    segments
      .filter((segment) => segment.type === "text")
      .map((segment) => (segment as { content: string }).content)
      .join("\n\n");

  const flushTurnCheckpoint = async (
    status: "running" | "done" | "error" | "cancelled" = "running",
    force = false,
  ): Promise<void> => {
    if (checkpointInFlight) {
      if (!force) {
        return;
      }
      await checkpointInFlight;
    }

    if (
      !force &&
      !checkpointRetryNeeded &&
      checkpointLastObservedSeq <= checkpointLastFlushedSeq &&
      checkpointDirtyBytes < TURN_CHECKPOINT_MIN_DIRTY_BYTES
    ) {
      return;
    }

    const snapshotSeq = checkpointLastObservedSeq;
    const snapshotContent = getFullAnswer();
    const snapshotToolCalls = [...toolCalls];
    const snapshotSegments = [...segments];
    const shouldPersistCheckpoint =
      snapshotSeq > 0 ||
      snapshotContent.trim().length > 0 ||
      snapshotToolCalls.length > 0 ||
      snapshotSegments.length > 0;
    if (!shouldPersistCheckpoint && !force) {
      return;
    }

    checkpointInFlight = (async () => {
      try {
        if (shouldPersistCheckpoint) {
          await upsertTurnCheckpoint(orgId, sessionId, turnId, {
            status,
            lastSeq: snapshotSeq,
            assistantContent: snapshotContent,
            toolCalls: snapshotToolCalls,
            segments: snapshotSegments,
          });

          checkpointLastFlushedSeq = Math.max(
            checkpointLastFlushedSeq,
            snapshotSeq,
          );
          checkpointDirtyBytes = 0;
          checkpointRetryNeeded = false;
          const keepFromSeq = Math.max(
            1,
            checkpointLastFlushedSeq - TURN_CHECKPOINT_REPLAY_TAIL_EVENTS + 1,
          );
          resumableTurnStore.trimBeforeSeq(turnId, keepFromSeq);
        } else {
          checkpointLastFlushedSeq = Math.max(
            checkpointLastFlushedSeq,
            snapshotSeq,
          );
        }
      } catch (error) {
        checkpointRetryNeeded = true;
        console.error("Turn checkpoint flush failed:", {
          sessionId,
          turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    await checkpointInFlight;
    checkpointInFlight = null;
  };

  const persistAssistantMessage = async (): Promise<boolean> => {
    if (assistantPersisted) return false;

    let fullAnswer = getFullAnswer();
    const shouldPersistAssistant = fullAnswer.trim().length > 0;
    if (!shouldPersistAssistant) return false;
    const requestedGoalCompletion = hasCompleteGoalToolCall(toolCalls);

    const sanitizedAnswer = await sanitizeAnswerFileLinks(
      orgId,
      agentId,
      fullAnswer,
    );
    if (sanitizedAnswer !== fullAnswer) {
      for (const seg of segments) {
        if (seg.type === "text") {
          seg.content = await sanitizeAnswerFileLinks(
            orgId,
            agentId,
            seg.content,
          );
        }
      }
      fullAnswer = getFullAnswer();
      emit({
        type: "text",
        data: { mode: "replace", text: fullAnswer, blockIndex: 0 },
      });
    }

    let textPayloadChanged = false;
    for (const seg of segments) {
      if (seg.type !== "text") continue;
      const sanitized = sanitizePersistableString(seg.content);
      if (!sanitized.changed) continue;
      seg.content = sanitized.value;
      textPayloadChanged = true;
    }
    if (textPayloadChanged) {
      fullAnswer = getFullAnswer();
      emit({
        type: "text",
        data: { mode: "replace", text: fullAnswer, blockIndex: 0 },
      });
    }

    const sanitizedContent = sanitizePersistableString(fullAnswer);
    const sanitizedToolCalls = sanitizePersistableValue(toolCalls);
    const sanitizedSegments = sanitizePersistableValue(segments);
    const combinedStats = combineSanitizeStats(
      sanitizedContent.stats,
      sanitizedToolCalls.stats,
      sanitizedSegments.stats,
    );
    logSanitizedPersistence(
      "resumable_foreground_insert",
      { sessionId, turnId },
      combinedStats,
    );

    await withOrgContextQuery(
      orgId,
      `INSERT INTO agent_chat_messages (session_id, role, content, tool_calls, segments)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        sessionId,
        "assistant",
        sanitizedContent.value,
        JSON.stringify(sanitizedToolCalls.value),
        JSON.stringify(sanitizedSegments.value),
      ],
    );
    if (requestedGoalCompletion) {
      await completeRequestedGoalForSession(orgId, sessionId);
    }
    assistantPersisted = true;
    return true;
  };

  try {
    checkpointFlushTimer = setInterval(() => {
      if (
        checkpointRetryNeeded ||
        checkpointLastObservedSeq > checkpointLastFlushedSeq ||
        checkpointDirtyBytes >= TURN_CHECKPOINT_MIN_DIRTY_BYTES
      ) {
        void flushTurnCheckpoint("running");
      }
    }, TURN_CHECKPOINT_FLUSH_INTERVAL_MS);

    const agentResult = await withOrgContextQuery(
      orgId,
      "SELECT * FROM agents WHERE id = $1",
      [agentId],
    );
    if (agentResult.rows.length === 0) {
      terminalStatus = "error";
      emit({ type: "error", data: "Agent not found" });
      emit({ type: "done" });
      return;
    }
    const agent = agentResult.rows[0];

    const skillsResult = await withOrgContextQuery(
      orgId,
      `SELECT s.*, ags.install_path FROM skills s
       JOIN agent_skills ags ON ags.skill_id = s.id
      WHERE ags.agent_id = $1
        AND ags.installed = true
        AND ags.enabled = true
      ORDER BY s.created_at ASC`,
      [agentId],
    );
    const enabledSkills = skillsResult.rows;

    await refreshStreamLease(orgId, agentId);
    leaseRefreshInterval = setInterval(() => {
      void refreshStreamLease(orgId, agentId);
    }, config.sandboxStreamLeaseRefreshMs);

    await withOrgContextQuery(
      orgId,
      `INSERT INTO agent_chat_messages (session_id, user_id, role, content)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, userId, "user", message],
    );
    if (turnSource === "foreground") {
      await touchAgentUserMessageRecency(orgId, agentId);
    }

    const skills = await Promise.all(
      enabledSkills.map(async (skill: any) => {
        const skillMarkdown = await readInstalledSkillMarkdown(
          orgId,
          agentId,
          skill.install_path,
        );
        return {
          name: skill.name,
          whenToUse: skill.when_to_use || "",
          instructions: skill.instructions || "",
          installPath: skill.install_path || null,
          skillMarkdown: skillMarkdown ?? undefined,
        };
      }),
    );
    const systemPrompt = buildSystemPrompt(
      agent.system_prompt || "",
      skills,
      outputFolder || undefined,
    );

    const textBlockToSegIdx = new Map<number, number>();
    const thinkingBlockToSegIdx = new Map<number, number>();

    const handleEvent = (event: ResumableEventInput) => {
      if (event.type === "text") {
        const payload = event.data;
        const blockIndex =
          payload &&
          typeof payload === "object" &&
          typeof (payload as { blockIndex?: unknown }).blockIndex === "number"
            ? ((payload as { blockIndex: number }).blockIndex ?? 0)
            : 0;
        const text =
          payload &&
          typeof payload === "object" &&
          typeof (payload as { text?: unknown }).text === "string"
            ? String((payload as { text: string }).text)
            : typeof payload === "string"
              ? payload
              : String(payload ?? "");

        const existingIdx = textBlockToSegIdx.get(blockIndex);
        if (existingIdx !== undefined) {
          (
            segments[existingIdx] as {
              type: "text";
              content: string;
              blockIndex?: number;
            }
          ).content = text;
        } else {
          textBlockToSegIdx.set(blockIndex, segments.length);
          segments.push({ type: "text", content: text, blockIndex });
        }
      }

      if (event.type === "thinking") {
        const payload = event.data;
        const blockIndex =
          payload &&
          typeof payload === "object" &&
          typeof (payload as { blockIndex?: unknown }).blockIndex === "number"
            ? ((payload as { blockIndex: number }).blockIndex ?? 0)
            : 0;
        const text =
          payload &&
          typeof payload === "object" &&
          typeof (payload as { text?: unknown }).text === "string"
            ? String((payload as { text: string }).text)
            : typeof payload === "string"
              ? payload
              : String(payload ?? "");

        const existingIdx = thinkingBlockToSegIdx.get(blockIndex);
        if (existingIdx !== undefined) {
          (
            segments[existingIdx] as {
              type: "thinking";
              content: string;
              blockIndex?: number;
            }
          ).content = text;
        } else {
          thinkingBlockToSegIdx.set(blockIndex, segments.length);
          segments.push({ type: "thinking", content: text, blockIndex });
        }
      }

      if (event.type === "tool_call") {
        const payload =
          event.data && typeof event.data === "object"
            ? (event.data as Record<string, unknown>)
            : {};
        toolCalls.push({ ...payload, result: null, error: false });
        segments.push({
          type: "tool",
          name: String(payload.name || ""),
          args: payload.args,
          result: null,
          error: false,
        });
      }

      if (event.type === "tool_result") {
        const payload =
          event.data && typeof event.data === "object"
            ? (event.data as Record<string, unknown>)
            : {};
        const toolName = String(payload.name || "");
        const tc = [...toolCalls]
          .reverse()
          .find((tool) => tool.name === toolName && tool.result === null);
        if (tc) {
          tc.result = payload.result;
          tc.error = Boolean(payload.error);
        }

        const seg = [...segments]
          .reverse()
          .find(
            (segment) =>
              segment.type === "tool" &&
              segment.name === toolName &&
              segment.result === null,
          ) as
          | { type: "tool"; name: string; result?: unknown; error?: boolean }
          | undefined;
        if (seg) {
          seg.result = payload.result;
          seg.error = Boolean(payload.error);
        }
      }

      if (event.type === "error") {
        const errText = String(event.data || "").trim();
        if (errText) streamError = errText;
      }
    };

    const prevMessagesResult = await withOrgContextQuery<{
      role: string;
      content: string;
    }>(
      orgId,
      `SELECT m.role, m.content
         FROM agent_chat_messages m
        WHERE m.session_id = $1
          AND m.role IN ('user', 'assistant')
        ORDER BY m.created_at DESC
        LIMIT 51`,
      [sessionId],
    );
    const chatHistory = prevMessagesResult.rows.slice(1).reverse();

    let sandboxResponse: globalThis.Response;
    try {
      sandboxResponse = await streamSandboxChat(
        orgId,
        agentId,
        sessionId,
        {
          message,
          systemPrompt,
          chatHistory,
          model: selectedModel,
        },
        abortController.signal,
      );
    } catch (error) {
      if (error instanceof SandboxNotReadyError) {
        emit({
          type: "vm_starting",
          data: {
            reason: error.reason,
            retryAfterMs: error.retryAfterMs,
          },
        });
        emit({ type: "done" });
        return;
      }
      throw error;
    }

    if (sandboxResponse.status === 503) {
      const payload = (await sandboxResponse.json().catch(() => null)) as {
        reason?: string;
        retryAfterMs?: number;
      } | null;
      emit({
        type: "vm_starting",
        data: {
          reason: payload?.reason || "vm_starting",
          retryAfterMs: payload?.retryAfterMs || DEFAULT_SANDBOX_RETRY_AFTER_MS,
        },
      });
      emit({ type: "done" });
      return;
    }

    if (sandboxResponse.status === 409) {
      const payload = (await sandboxResponse.json().catch(() => null)) as {
        error?: string;
      } | null;
      terminalStatus = "error";
      emit({
        type: "error",
        data: payload?.error || "Session is already processing a turn",
      });
      emit({ type: "done" });
      return;
    }

    if (!sandboxResponse.ok || !sandboxResponse.body) {
      throw new Error(
        `Sandbox chat failed: ${sandboxResponse.status} ${sandboxResponse.statusText}`,
      );
    }

    const reader = sandboxResponse.body.getReader();
    const decoder = new TextDecoder();
    let streamBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      streamBuffer += decoder.decode(value, { stream: true });
      const lines = streamBuffer.split("\n");
      streamBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const raw = JSON.parse(line.slice(6));
          const event = toResumableEventInput(raw);
          if (!event) continue;
          if (event.type === "done") continue;
          emit(event);
          handleEvent(event);
          if (checkpointDirtyBytes >= TURN_CHECKPOINT_MIN_DIRTY_BYTES) {
            void flushTurnCheckpoint("running");
          }
        } catch {
          // ignore malformed stream chunk
        }
      }
    }

    let fullAnswer = getFullAnswer();
    if (!fullAnswer.trim()) {
      const fallbackAnswer = await buildProducedFilesMessage(
        orgId,
        agentId,
        toolCalls,
        outputFolder || undefined,
      );
      if (fallbackAnswer) {
        fullAnswer = fallbackAnswer;
        const fallbackEvent = { type: "text", data: fallbackAnswer };
        emit(fallbackEvent);
        handleEvent(fallbackEvent);
      }
    }

    if (!fullAnswer.trim() && streamError) {
      fullAnswer = `Error: ${streamError}`;
      const errorTextEvent = { type: "text", data: fullAnswer };
      emit(errorTextEvent);
      handleEvent(errorTextEvent);
    }

    if (!fullAnswer.trim() && toolCalls.length === 0 && !streamError) {
      const shouldEmitFallback = await shouldEmitNoOutputFallback(
        orgId,
        sessionId,
      );
      if (shouldEmitFallback) {
        fullAnswer = NO_OUTPUT_FALLBACK_MESSAGE;
        const noOutputEvent = { type: "text", data: fullAnswer };
        emit(noOutputEvent);
        handleEvent(noOutputEvent);
      }
    }

    await persistAssistantMessage();

    await withOrgContextQuery(
      orgId,
      `UPDATE agent_chat_sessions SET updated_at = NOW() WHERE id = $1`,
      [sessionId],
    );

    const sessionCheck = await withOrgContextQuery(
      orgId,
      `SELECT title FROM agent_chat_sessions WHERE id = $1`,
      [sessionId],
    );
    if (sessionCheck.rows.length > 0 && !sessionCheck.rows[0].title) {
      const autoTitle =
        message.slice(0, 60).trim() + (message.length > 60 ? "..." : "");
      await withOrgContextQuery(
        orgId,
        `UPDATE agent_chat_sessions SET title = $1 WHERE id = $2`,
        [autoTitle, sessionId],
      );
      emit({
        type: "session_update",
        data: { title: autoTitle },
      });
    }

    emit({ type: "done" });
  } catch (error) {
    if (abortController.signal.aborted) {
      try {
        const persisted = await persistAssistantMessage();
        if (persisted) {
          await withOrgContextQuery(
            orgId,
            `UPDATE agent_chat_sessions SET updated_at = NOW() WHERE id = $1`,
            [sessionId],
          );
        }
      } catch (persistError) {
        console.error(
          "Failed to persist partial assistant response after user stop:",
          persistError,
        );
      }
      terminalStatus = "error";
      emit({ type: "error", data: "Turn stopped by user." });
      emit({ type: "done" });
      return;
    }
    console.error("Resumable agent chat execution error:", error);
    try {
      await persistAssistantMessage();
    } catch (persistError) {
      console.error(
        "Failed to persist partial assistant response during resumable run:",
        persistError,
      );
    }

    if (isRecoverableSandboxTransportError(error)) {
      try {
        const ensured = await ensureSandbox(orgId, agentId, {
          touchActivity: false,
        });
        if (ensured.status === "starting") {
          emit({
            type: "vm_starting",
            data: {
              reason: ensured.reason,
              retryAfterMs: ensured.retryAfterMs,
            },
          });
          emit({ type: "done" });
          return;
        }
      } catch {
        // fall back to generic error below
      }
    }

    terminalStatus = "error";
    emit({ type: "error", data: "Agent chat failed" });
    emit({ type: "done" });
  } finally {
    stopCheckpointFlushTimer();
    stopLeaseRefresh();
    await flushTurnCheckpoint(
      terminalStatus === "done" ? "done" : "error",
      true,
    );
    if (assistantPersisted) {
      await deleteTurnCheckpoint(orgId, sessionId, turnId).catch((error) => {
        console.warn("Failed to delete completed turn checkpoint:", error);
      });
    }
    if (shouldRunCheckpointCleanup(orgId)) {
      void cleanupStaleTurnCheckpoints(orgId).catch((error) => {
        console.warn("Failed to cleanup stale turn checkpoints:", error);
      });
    }
    resumableTurnStore.closeTurnIfRunning(turnId, terminalStatus);
    clearTurnSource(turnId);
    resumableTurnAbortControllers.delete(turnId);
  }
}

// ==================== Session CRUD ====================

// List sessions for an agent
router.get(
  "/:agentId/sessions",
  requireAgentAccess("viewer"),
  validate({ params: listSessionsParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const result = await withOrgContextQuery(
        orgId,
        `SELECT id, agent_id, created_by, title, model, shared, created_at, updated_at
         FROM agent_chat_sessions
         WHERE agent_id = $1
         ORDER BY updated_at DESC NULLS LAST`,
        [agentId],
      );
      res.json({ sessions: result.rows });
    } catch (error) {
      console.error("List sessions error:", error);
      res.status(500).json({ error: "Failed to list sessions" });
    }
  },
);

// Create a new session for an agent
router.post(
  "/:agentId/sessions",
  requireAgentAccess("editor"),
  validate({ params: chatAgentParamsSchema, body: createSessionBodySchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const { title, model } = req.body;
      const selectedModel = resolveAgentModel(model, DEFAULT_AGENT_MODEL);
      const result = await withOrgContextQuery(
        orgId,
        `INSERT INTO agent_chat_sessions (agent_id, created_by, title, model)
         VALUES ($1, $2, $3, $4)
         RETURNING id, agent_id, created_by, title, model, shared, created_at, updated_at`,
        [agentId, user.id, title || null, selectedModel],
      );
      res.status(201).json({ session: result.rows[0] });
    } catch (error) {
      console.error("Create session error:", error);
      res.status(500).json({ error: "Failed to create session" });
    }
  },
);

// Update a session (rename and/or model)
router.patch(
  "/sessions/:sessionId",
  validate({ params: sessionParamsSchema, body: updateSessionBodySchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const sessionId = getRouteParam(req.params.sessionId);
      const access = await checkSessionAccess(
        orgId,
        sessionId,
        user.id,
        "editor",
      );
      if (access === "not_found") {
        return res.status(404).json({ error: "Session not found" });
      }
      if (access !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }
      const { title, model } = req.body;
      const result =
        title !== undefined && model !== undefined
          ? await withOrgContextQuery(
              orgId,
              `UPDATE agent_chat_sessions
               SET title = $1, model = $2, updated_at = NOW()
               WHERE id = $3
               RETURNING id, agent_id, created_by, title, model, shared, created_at, updated_at`,
              [title, resolveAgentModel(model, DEFAULT_AGENT_MODEL), sessionId],
            )
          : title !== undefined
            ? await withOrgContextQuery(
                orgId,
                `UPDATE agent_chat_sessions
                 SET title = $1, updated_at = NOW()
                 WHERE id = $2
                 RETURNING id, agent_id, created_by, title, model, shared, created_at, updated_at`,
                [title, sessionId],
              )
            : await withOrgContextQuery(
                orgId,
                `UPDATE agent_chat_sessions
                 SET model = $1
                 WHERE id = $2
                 RETURNING id, agent_id, created_by, title, model, shared, created_at, updated_at`,
                [resolveAgentModel(model, DEFAULT_AGENT_MODEL), sessionId],
              );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json({ session: result.rows[0] });
    } catch (error) {
      console.error("Update session error:", error);
      res.status(500).json({ error: "Failed to update session" });
    }
  },
);

// Delete a session and its messages
router.delete(
  "/sessions/:sessionId",
  validate({ params: sessionParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const sessionId = getRouteParam(req.params.sessionId);
      const access = await checkSessionAccess(
        orgId,
        sessionId,
        user.id,
        "editor",
      );
      if (access === "not_found") {
        return res.status(404).json({ error: "Session not found" });
      }
      if (access !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }
      await withOrgContextQuery(
        orgId,
        `DELETE FROM agent_chat_sessions WHERE id = $1`,
        [sessionId],
      );
      res.status(204).end();
    } catch (error) {
      console.error("Delete session error:", error);
      res.status(500).json({ error: "Failed to delete session" });
    }
  },
);

// Get the latest goal for a session (active takes precedence)
router.get(
  "/sessions/:sessionId/goal",
  validate({ params: sessionParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const sessionId = getRouteParam(req.params.sessionId);
      const access = await checkSessionAccess(
        orgId,
        sessionId,
        user.id,
        "viewer",
      );
      if (access === "not_found") {
        return res.status(404).json({ error: "Session not found" });
      }
      if (access !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }

      const result = await withOrgContextQuery(
        orgId,
        `SELECT id, session_id, goal, guidance, output_folder, deadline_at,
                status, status_reason, report_path, artifact_paths,
                progress_summary, next_suggested_run_at, run_count,
                last_run_started_at, last_run_ended_at, completed_at,
                created_at, updated_at
         FROM agent_session_goals
         WHERE session_id = $1
         ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`,
        [sessionId],
      );

      res.json({ goal: result.rows[0] || null });
    } catch (error) {
      console.error("Get session goal error:", error);
      res.status(500).json({ error: "Failed to get session goal" });
    }
  },
);

// Create or update the active goal for a session
router.put(
  "/sessions/:sessionId/goal",
  validate({ params: sessionParamsSchema, body: upsertGoalBodySchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const sessionId = getRouteParam(req.params.sessionId);
      const access = await checkSessionAccess(
        orgId,
        sessionId,
        user.id,
        "editor",
      );
      if (access === "not_found") {
        return res.status(404).json({ error: "Session not found" });
      }
      if (access !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }

      const goal = String(req.body.goal || "").trim();
      const guidance = String(req.body.guidance || "").trim();
      const deadlineAt = parseDeadline(req.body.deadlineAt);
      if (deadlineAt && isPastOrNow(deadlineAt)) {
        return res.status(400).json({
          error: "deadlineAt must be in the future",
        });
      }
      const outputFolder = normalizeOutputFolder(
        String(req.body.outputFolder || ""),
      );

      const activeResult = await withOrgContextQuery<{ id: string }>(
        orgId,
        `SELECT id
         FROM agent_session_goals
         WHERE session_id = $1
           AND status = 'active'
         ORDER BY updated_at DESC, created_at DESC`,
        [sessionId],
      );

      const activeIds = activeResult.rows.map((row) => row.id);
      const primaryGoalId = activeIds[0] || null;
      const duplicateGoalIds = activeIds.slice(1);

      if (duplicateGoalIds.length > 0) {
        await withOrgContextQuery(
          orgId,
          `UPDATE agent_session_goals
           SET status = 'cancelled',
               status_reason = 'superseded',
               completed_at = NOW(),
               updated_at = NOW()
           WHERE id = ANY($1::uuid[])`,
          [duplicateGoalIds],
        );
      }

      const sql =
        primaryGoalId == null
          ? `INSERT INTO agent_session_goals (
               session_id, created_by, goal, guidance, output_folder, deadline_at,
               status, status_reason, report_path, artifact_paths, progress_summary,
               next_suggested_run_at, run_count, last_run_started_at, last_run_ended_at,
               completed_at, created_at, updated_at
             )
             VALUES (
               $1, $2, $3, $4, $5, $6,
               'active', NULL, NULL, '[]'::jsonb, NULL,
               NOW(), 0, NULL, NULL, NULL, NOW(), NOW()
             )
             RETURNING id, session_id, goal, guidance, output_folder, deadline_at,
                       status, status_reason, report_path, artifact_paths,
                       progress_summary, next_suggested_run_at, run_count,
                       last_run_started_at, last_run_ended_at, completed_at,
                       created_at, updated_at`
          : `UPDATE agent_session_goals
             SET goal = $2,
                 guidance = $3,
                 output_folder = $4,
                 deadline_at = $5,
                 status = 'active',
                 status_reason = NULL,
                 completed_at = NULL,
                 next_suggested_run_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING id, session_id, goal, guidance, output_folder, deadline_at,
                       status, status_reason, report_path, artifact_paths,
                       progress_summary, next_suggested_run_at, run_count,
                       last_run_started_at, last_run_ended_at, completed_at,
                       created_at, updated_at`;

      const params =
        primaryGoalId == null
          ? [sessionId, user.id, goal, guidance, outputFolder, deadlineAt]
          : [primaryGoalId, goal, guidance, outputFolder, deadlineAt];

      const result = await withOrgContextQuery(orgId, sql, params);
      res.json({ goal: result.rows[0] || null });
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid deadlineAt") {
        return res.status(400).json({ error: "Invalid deadlineAt" });
      }
      console.error("Upsert session goal error:", error);
      res.status(500).json({ error: "Failed to update session goal" });
    }
  },
);

// Cancel the active goal for a session
router.delete(
  "/sessions/:sessionId/goal",
  validate({ params: sessionParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const sessionId = getRouteParam(req.params.sessionId);
      const access = await checkSessionAccess(
        orgId,
        sessionId,
        user.id,
        "editor",
      );
      if (access === "not_found") {
        return res.status(404).json({ error: "Session not found" });
      }
      if (access !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }

      const result = await withOrgContextQuery(
        orgId,
        `UPDATE agent_session_goals
         SET status = 'cancelled',
             status_reason = 'user_cancelled',
             completed_at = NOW(),
             updated_at = NOW()
         WHERE session_id = $1
           AND status = 'active'
         RETURNING id, session_id, goal, guidance, output_folder, deadline_at,
                   status, status_reason, report_path, artifact_paths,
                   progress_summary, next_suggested_run_at, run_count,
                   last_run_started_at, last_run_ended_at, completed_at,
                   created_at, updated_at`,
        [sessionId],
      );

      res.json({ goal: result.rows[0] || null });
    } catch (error) {
      console.error("Cancel session goal error:", error);
      res.status(500).json({ error: "Failed to cancel session goal" });
    }
  },
);

// ==================== Chat ====================

router.post(
  "/:agentId/chat/start",
  agentChatRateLimit,
  requireAgentAccess("editor"),
  validate({ params: chatAgentParamsSchema, body: sendMessageBodySchema }),
  async (req: Request, res: Response) => {
    try {
      if (!config.chatResumableStream) {
        return res.status(404).json({ error: "Not found" });
      }

      const { orgId, user } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const { message, sessionId, outputFolder } = req.body;
      const requestedModel = req.body?.model;

      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }
      if (isDeployDraining()) {
        return res.status(503).json({
          error: "Deployment is in progress. Please retry shortly.",
          reason: "deploy_draining",
          retryAfterMs: DEFAULT_SANDBOX_RETRY_AFTER_MS,
        });
      }

      const resolvedSessionId = await resolveOrCreateSessionId(
        orgId,
        agentId,
        user.id,
        sessionId,
      );
      const persistedModel = await fetchSessionModel(orgId, resolvedSessionId);
      const selectedModel: AgentModelSelection = resolveAgentModel(
        requestedModel,
        persistedModel ?? DEFAULT_AGENT_MODEL,
      );
      await persistSessionModel(orgId, resolvedSessionId, selectedModel);

      const runningTurn = getRunningTurnWithSource(resolvedSessionId);
      if (runningTurn && runningTurn.source !== "goal_background") {
        return res.status(409).json({
          error: "Session is already processing a turn",
          reason: "session_busy",
          sessionId: resolvedSessionId,
          turnId: runningTurn.turnId,
          retryAfterMs: 2000,
        });
      }
      if (runningTurn && runningTurn.source === "goal_background") {
        await finalizeBackgroundResumableTurn({
          turnId: runningTurn.turnId,
          status: "aborted",
          errorMessage: "Background turn preempted by foreground message.",
        });
      }

      const ensured = await ensureSandbox(orgId, agentId, {
        touchActivity: true,
      });
      if (ensured.status === "starting") {
        return res.status(503).json({
          error: "Sandbox is starting",
          reason: ensured.reason,
          retryAfterMs: ensured.retryAfterMs,
        });
      }

      const turnResult = resumableTurnStore.createTurn(resolvedSessionId);
      if (!turnResult.ok) {
        if (turnResult.reason === "already_running" && turnResult.turnId) {
          return res.status(409).json({
            error: "Session is already processing a turn",
            reason: "session_busy",
            sessionId: resolvedSessionId,
            turnId: turnResult.turnId,
            retryAfterMs: 2000,
          });
        }

        return res.status(503).json({
          error: "Chat capacity exhausted. Please retry shortly.",
          reason: "chat_capacity_exhausted",
          retryAfterMs: 2000,
        });
      }

      const turnId = turnResult.turnId!;
      setTurnSource(turnId, "foreground");
      const abortController = new AbortController();
      resumableTurnAbortControllers.set(turnId, abortController);
      void runResumableTurn({
        orgId,
        userId: user.id,
        agentId,
        sessionId: resolvedSessionId,
        message,
        outputFolder: outputFolder || undefined,
        selectedModel,
        turnId,
        abortController,
      });

      return res.json({
        sessionId: resolvedSessionId,
        turnId,
      });
    } catch (error) {
      console.error("Agent chat start error:", error);
      return res.status(500).json({ error: "Failed to start agent chat" });
    }
  },
);

router.post(
  "/sessions/:sessionId/turns/:turnId/cancel",
  validate({ params: sessionTurnParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      if (!config.chatResumableStream) {
        return res.status(404).json({ error: "Not found" });
      }

      const { orgId, user } = requireAuthContext(req);
      const sessionId = getRouteParam(req.params.sessionId);
      const turnId = getRouteParam(req.params.turnId);

      const access = await checkSessionAccess(
        orgId,
        sessionId,
        user.id,
        "editor",
      );
      if (access === "not_found") {
        return res.status(404).json({ error: "Session not found" });
      }
      if (access !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }

      const turn = resumableTurnStore.readFromSeq(sessionId, turnId, 1);
      if (turn.status === "not_found") {
        return res.status(404).json({ error: "Turn not found" });
      }

      const controller = resumableTurnAbortControllers.get(turnId);
      if (controller && !controller.signal.aborted) {
        controller.abort();
      } else {
        // Fallback for stale controller map: close the stream immediately.
        resumableTurnStore.appendEvent(turnId, {
          type: "error",
          data: "Turn stopped by user.",
        });
        resumableTurnStore.appendEvent(turnId, { type: "done" });
      }

      return res.status(202).json({ status: "cancelling", turnId });
    } catch (error) {
      console.error("Cancel turn error:", error);
      return res.status(500).json({ error: "Failed to cancel turn" });
    }
  },
);

router.get(
  "/sessions/:sessionId/turns/:turnId/snapshot",
  validate({ params: sessionTurnParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      if (!config.chatResumableStream) {
        return res.status(404).json({ error: "Not found" });
      }

      const { orgId, user } = requireAuthContext(req);
      const sessionId = getRouteParam(req.params.sessionId);
      const turnId = getRouteParam(req.params.turnId);
      const access = await checkSessionAccess(
        orgId,
        sessionId,
        user.id,
        "viewer",
      );
      if (access === "not_found") {
        return res.status(404).json({ error: "Session not found" });
      }
      if (access !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }

      const checkpoint = await readTurnCheckpoint(orgId, sessionId, turnId);
      if (!checkpoint) {
        return res.status(404).json({ error: "Turn snapshot not found" });
      }

      return res.json({
        snapshot: {
          sessionId,
          turnId,
          status: checkpoint.status,
          lastSeq: Number(checkpoint.last_seq || 0),
          assistantContent: checkpoint.assistant_content,
          toolCalls: normalizeJsonArray(checkpoint.tool_calls),
          segments: normalizeJsonArray(checkpoint.segments),
          updatedAt: checkpoint.updated_at,
          lastEventAt: checkpoint.last_event_at,
        },
      });
    } catch (error) {
      console.error("Get turn snapshot error:", error);
      return res.status(500).json({ error: "Failed to get turn snapshot" });
    }
  },
);

router.get(
  "/sessions/:sessionId/turns/:turnId/stream",
  validate({ params: sessionTurnParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      if (!config.chatResumableStream) {
        return res.status(404).json({ error: "Not found" });
      }

      const { orgId, user } = requireAuthContext(req);
      const sessionId = getRouteParam(req.params.sessionId);
      const turnId = getRouteParam(req.params.turnId);
      const fromSeq = parseFromSeq(req.query.fromSeq);

      const access = await checkSessionAccess(
        orgId,
        sessionId,
        user.id,
        "viewer",
      );
      if (access === "not_found") {
        return res.status(404).json({ error: "Session not found" });
      }
      if (access !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }

      const initial = resumableTurnStore.readFromSeq(
        sessionId,
        turnId,
        fromSeq,
      );
      if (initial.status === "not_found") {
        return res.status(404).json({ error: "Turn not found" });
      }
      if (initial.status === "seq_too_old") {
        return res.status(410).json({
          error: "Turn replay is no longer available",
          minSeq: initial.minSeq,
          nextSeq: initial.nextSeq,
        });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      const writer = createBufferedSseWriter(res, {
        maxPendingBytes: TURN_STREAM_MAX_PENDING_BYTES,
      });
      if (!writer.sendData({ type: "session", sessionId, turnId })) {
        return res.end();
      }

      let localNextSeq = fromSeq;
      const sendEvent = (event: ResumableEvent): boolean => {
        if (event.seq < localNextSeq) return true;
        const ok = writer.sendData(event);
        if (!ok) return false;
        localNextSeq = event.seq + 1;
        return true;
      };

      for (const event of initial.events) {
        if (!sendEvent(event)) {
          return res.end();
        }
      }

      let unsubscribed = false;
      const unsubscribe = () => {
        if (unsubscribed) return;
        unsubscribed = true;
        rawUnsubscribe();
      };

      const rawUnsubscribe = resumableTurnStore.subscribe(
        sessionId,
        turnId,
        (event) => {
          if (!sendEvent(event)) {
            unsubscribe();
            writer.close();
            return;
          }
          if (event.type === "done" || event.type === "error") {
            unsubscribe();
            writer.close();
          }
        },
      );

      const catchup = resumableTurnStore.readFromSeq(
        sessionId,
        turnId,
        localNextSeq,
      );
      if (catchup.status === "ok") {
        for (const event of catchup.events) {
          if (!sendEvent(event)) {
            unsubscribe();
            return res.end();
          }
        }
      }

      if (catchup.status === "ok" && catchup.turnStatus !== "running") {
        unsubscribe();
        writer.close();
        return;
      }

      const keepAlive = setInterval(() => {
        if (writer.isClosed()) {
          clearInterval(keepAlive);
          return;
        }
        if (!writer.sendComment("ping")) {
          clearInterval(keepAlive);
          unsubscribe();
          writer.close();
        }
      }, TURN_STREAM_HEARTBEAT_INTERVAL_MS);

      req.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
        writer.close();
      });
    } catch (error) {
      console.error("Turn stream error:", error);
      if (!res.headersSent) {
        return res.status(500).json({ error: "Failed to open turn stream" });
      }
      try {
        res.write(
          `data: ${JSON.stringify({ type: "error", data: "Stream failed" })}\n\n`,
        );
      } catch {
        // socket already closed
      }
      res.end();
    }
  },
);

// Stream chat with an agent
router.post(
  "/:agentId/chat",
  agentChatRateLimit,
  requireAgentAccess("editor"),
  validate({ params: chatAgentParamsSchema, body: sendMessageBodySchema }),
  async (req: Request, res: Response) => {
    // Declare before the try so that catch can reference them even if an error
    // occurs mid-handler. TypeScript 5.x enforces block-scoping of const/let
    // declared inside try {}, making them inaccessible in catch {}.
    const { orgId, user } = requireAuthContext(req);
    const { message, sessionId, outputFolder } = req.body;
    const requestedModel = req.body?.model;
    const agentId = getRouteParam(req.params.agentId);
    let leaseRefreshInterval: NodeJS.Timeout | null = null;
    let currentSessionId = sessionId;
    const toolCalls: any[] = [];
    type AssistantSegment =
      | { type: "text"; content: string; blockIndex?: number }
      | { type: "thinking"; content: string; blockIndex?: number }
      | {
          type: "tool";
          name: string;
          args?: any;
          result?: any;
          error?: boolean;
        };
    const segments: AssistantSegment[] = [];
    let streamError: string | null = null;
    let assistantPersisted = false;
    let streamWriter: BufferedSseWriter | null = null;
    let streamHeartbeatInterval: NodeJS.Timeout | null = null;
    const stopLeaseRefresh = () => {
      if (!leaseRefreshInterval) return;
      clearInterval(leaseRefreshInterval);
      leaseRefreshInterval = null;
    };
    const stopStreamHeartbeat = () => {
      if (!streamHeartbeatInterval) return;
      clearInterval(streamHeartbeatInterval);
      streamHeartbeatInterval = null;
    };
    const writeSseEvent = (event: unknown): boolean => {
      if (streamWriter) {
        return streamWriter.sendData(event);
      }
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        try {
          return res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          return false;
        }
      }
      return false;
    };
    const getFullAnswer = () =>
      segments
        .filter((s) => s.type === "text")
        .map((s) => (s as { content: string }).content)
        .join("\n\n");
    const persistAssistantMessage = async (options?: {
      emitSanitizedReplaceEvent?: boolean;
    }): Promise<boolean> => {
      if (assistantPersisted || !currentSessionId) return false;
      let fullAnswer = getFullAnswer();
      const shouldPersistAssistant = fullAnswer.trim().length > 0;
      if (!shouldPersistAssistant) return false;
      const requestedGoalCompletion = hasCompleteGoalToolCall(toolCalls);

      const sanitizedAnswer = await sanitizeAnswerFileLinks(
        orgId,
        agentId,
        fullAnswer,
      );
      if (sanitizedAnswer !== fullAnswer) {
        for (const seg of segments) {
          if (seg.type === "text") {
            seg.content = await sanitizeAnswerFileLinks(
              orgId,
              agentId,
              seg.content,
            );
          }
        }
        fullAnswer = getFullAnswer();
        if (options?.emitSanitizedReplaceEvent && res.headersSent) {
          try {
            writeSseEvent({
              type: "text",
              data: { mode: "replace", text: fullAnswer, blockIndex: 0 },
            });
          } catch {
            // Socket may already be closed.
          }
        }
      }

      let textPayloadChanged = false;
      for (const seg of segments) {
        if (seg.type !== "text") continue;
        const sanitized = sanitizePersistableString(seg.content);
        if (!sanitized.changed) continue;
        seg.content = sanitized.value;
        textPayloadChanged = true;
      }
      if (textPayloadChanged) {
        fullAnswer = getFullAnswer();
      }
      if (
        textPayloadChanged &&
        options?.emitSanitizedReplaceEvent &&
        res.headersSent
      ) {
        try {
          writeSseEvent({
            type: "text",
            data: { mode: "replace", text: fullAnswer, blockIndex: 0 },
          });
        } catch {
          // Socket may already be closed.
        }
      }

      const sanitizedContent = sanitizePersistableString(fullAnswer);
      const sanitizedToolCalls = sanitizePersistableValue(toolCalls);
      const sanitizedSegments = sanitizePersistableValue(segments);
      const combinedStats = combineSanitizeStats(
        sanitizedContent.stats,
        sanitizedToolCalls.stats,
        sanitizedSegments.stats,
      );
      logSanitizedPersistence(
        "legacy_foreground_insert",
        { sessionId: currentSessionId },
        combinedStats,
      );

      await withOrgContextQuery(
        orgId,
        `INSERT INTO agent_chat_messages (session_id, role, content, tool_calls, segments)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          currentSessionId,
          "assistant",
          sanitizedContent.value,
          JSON.stringify(sanitizedToolCalls.value),
          JSON.stringify(sanitizedSegments.value),
        ],
      );
      if (requestedGoalCompletion) {
        await completeRequestedGoalForSession(orgId, currentSessionId);
      }
      assistantPersisted = true;
      return true;
    };
    try {
      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }
      if (isDeployDraining()) {
        return res.status(503).json({
          error: "Deployment is in progress. Please retry shortly.",
          reason: "deploy_draining",
          retryAfterMs: DEFAULT_SANDBOX_RETRY_AFTER_MS,
        });
      }

      // Get agent
      const agentResult = await withOrgContextQuery(
        orgId,
        "SELECT * FROM agents WHERE id = $1",
        [agentId],
      );
      if (agentResult.rows.length === 0) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const agent = agentResult.rows[0];

      // Get enabled skills for this agent
      const skillsResult = await withOrgContextQuery(
        orgId,
        `SELECT s.*, ags.install_path FROM skills s
       JOIN agent_skills ags ON ags.skill_id = s.id
       WHERE ags.agent_id = $1
         AND ags.installed = true
         AND ags.enabled = true
       ORDER BY s.created_at ASC`,
        [agentId],
      );
      const enabledSkills = skillsResult.rows;

      // Get or create session.
      // If client sessionId is missing (e.g. after refresh), reuse the latest
      // session for this user + agent to avoid cross-user session mixing.
      if (!currentSessionId) {
        const latestSessionResult = await withOrgContextQuery(
          orgId,
          `SELECT id
         FROM agent_chat_sessions
         WHERE agent_id = $1
           AND created_by = $2
         ORDER BY created_at DESC
         LIMIT 1`,
          [agentId, user.id],
        );
        if (latestSessionResult.rows.length > 0) {
          currentSessionId = latestSessionResult.rows[0].id;
        } else {
          const sessionResult = await withOrgContextQuery(
            orgId,
            `INSERT INTO agent_chat_sessions (agent_id, created_by)
             VALUES ($1, $2)
             RETURNING id`,
            [agentId, user.id],
          );
          currentSessionId = sessionResult.rows[0].id;
        }
      }
      const persistedModel = await fetchSessionModel(orgId, currentSessionId);
      const selectedModel: AgentModelSelection = resolveAgentModel(
        requestedModel,
        persistedModel ?? DEFAULT_AGENT_MODEL,
      );
      await persistSessionModel(orgId, currentSessionId, selectedModel);

      const ensured = await ensureSandbox(orgId, agentId, {
        touchActivity: true,
      });
      if (ensured.status === "starting") {
        return res.status(503).json({
          error: "Sandbox is starting",
          reason: ensured.reason,
          retryAfterMs: ensured.retryAfterMs,
        });
      }

      // Acquire a stream lease so the idle monitor does not stop the VM
      // while a potentially long-running LLM request is in flight.
      await refreshStreamLease(orgId, agentId);
      leaseRefreshInterval = setInterval(() => {
        void refreshStreamLease(orgId, agentId);
      }, config.sandboxStreamLeaseRefreshMs);

      // Save user message
      await withOrgContextQuery(
        orgId,
        `INSERT INTO agent_chat_messages (session_id, user_id, role, content)
         VALUES ($1, $2, $3, $4)`,
        [currentSessionId, user.id, "user", message],
      );
      await touchAgentUserMessageRecency(orgId, agentId);

      // Build system prompt with skills
      const skills = await Promise.all(
        enabledSkills.map(async (s: any) => {
          const skillMarkdown = await readInstalledSkillMarkdown(
            orgId,
            agentId,
            s.install_path,
          );
          return {
            name: s.name,
            whenToUse: s.when_to_use || "",
            instructions: s.instructions || "",
            installPath: s.install_path || null,
            skillMarkdown: skillMarkdown ?? undefined,
          };
        }),
      );
      const systemPrompt = buildSystemPrompt(
        agent.system_prompt || "",
        skills,
        outputFolder || undefined,
      );

      // Map from text blockIndex → index in segments array
      const textBlockToSegIdx = new Map<number, number>();
      // Map from thinking blockIndex → index in segments array
      const thinkingBlockToSegIdx = new Map<number, number>();

      const handleEvent = (event: any) => {
        if (event.type === "text") {
          const payload = event.data;
          const blockIndex =
            payload &&
            typeof payload === "object" &&
            typeof payload.blockIndex === "number"
              ? payload.blockIndex
              : 0;
          const text =
            payload &&
            typeof payload === "object" &&
            typeof payload.text === "string"
              ? payload.text
              : typeof payload === "string"
                ? payload
                : String(payload ?? "");

          const existingIdx = textBlockToSegIdx.get(blockIndex);
          if (existingIdx !== undefined) {
            // Update existing text segment
            (
              segments[existingIdx] as {
                type: "text";
                content: string;
                blockIndex?: number;
              }
            ).content = text;
          } else {
            // New text block — append to segments
            textBlockToSegIdx.set(blockIndex, segments.length);
            segments.push({ type: "text", content: text, blockIndex });
          }
        }
        if (event.type === "thinking") {
          const payload = event.data;
          const blockIndex =
            payload &&
            typeof payload === "object" &&
            typeof payload.blockIndex === "number"
              ? payload.blockIndex
              : 0;
          const text =
            payload &&
            typeof payload === "object" &&
            typeof payload.text === "string"
              ? payload.text
              : typeof payload === "string"
                ? payload
                : String(payload ?? "");

          const existingIdx = thinkingBlockToSegIdx.get(blockIndex);
          if (existingIdx !== undefined) {
            (
              segments[existingIdx] as {
                type: "thinking";
                content: string;
                blockIndex?: number;
              }
            ).content = text;
          } else {
            thinkingBlockToSegIdx.set(blockIndex, segments.length);
            segments.push({ type: "thinking", content: text, blockIndex });
          }
        }
        if (event.type === "tool_call") {
          toolCalls.push({ ...event.data, result: null, error: false });
          segments.push({
            type: "tool",
            name: event.data.name,
            args: event.data.args,
            result: null,
            error: false,
          });
        }
        if (event.type === "tool_result") {
          // Merge result into the matching tool call
          const tc = [...toolCalls]
            .reverse()
            .find((t) => t.name === event.data.name && t.result === null);
          if (tc) {
            tc.result = event.data.result;
            tc.error = !!event.data.error;
          }
          // Also update segments
          const seg = [...segments]
            .reverse()
            .find(
              (s) =>
                s.type === "tool" &&
                s.name === event.data.name &&
                s.result === null,
            ) as
            | { type: "tool"; name: string; result?: any; error?: boolean }
            | undefined;
          if (seg) {
            seg.result = event.data.result;
            seg.error = !!event.data.error;
          }
        }
        if (event.type === "error") {
          const errText = String(event.data || "").trim();
          if (errText) {
            streamError = errText;
          }
        }
      };

      // Fetch previous chat messages for the current session only
      const prevMessagesResult = await withOrgContextQuery<{
        role: string;
        content: string;
      }>(
        orgId,
        `SELECT m.role, m.content
           FROM agent_chat_messages m
           WHERE m.session_id = $1
             AND m.role IN ('user', 'assistant')
           ORDER BY m.created_at DESC
           LIMIT 51`,
        [currentSessionId],
      );
      // Exclude the just-saved user message (most recent) and reverse to chronological order
      const chatHistory = prevMessagesResult.rows.slice(1).reverse();

      let sandboxResponse: globalThis.Response;
      try {
        sandboxResponse = await streamSandboxChat(
          orgId,
          agentId,
          currentSessionId,
          {
            message,
            systemPrompt,
            chatHistory,
            model: selectedModel,
          },
        );
      } catch (error) {
        if (error instanceof SandboxNotReadyError) {
          stopLeaseRefresh();
          return res.status(503).json({
            error: "Sandbox is starting",
            reason: error.reason,
            retryAfterMs: error.retryAfterMs,
          });
        }
        throw error;
      }

      if (sandboxResponse.status === 503) {
        stopLeaseRefresh();
        const payload = (await sandboxResponse.json().catch(() => null)) as {
          reason?: string;
          retryAfterMs?: number;
        } | null;
        return res.status(503).json({
          error: "Sandbox is starting",
          reason: payload?.reason || "vm_starting",
          retryAfterMs: payload?.retryAfterMs || 5000,
        });
      }
      if (sandboxResponse.status === 409) {
        stopLeaseRefresh();
        const payload = (await sandboxResponse.json().catch(() => null)) as {
          error?: string;
        } | null;
        return res.status(409).json({
          error: payload?.error || "Session is already processing a turn",
          reason: "session_busy",
          retryAfterMs: 2000,
        });
      }

      if (!sandboxResponse.ok || !sandboxResponse.body) {
        throw new Error(
          `Sandbox chat failed: ${sandboxResponse.status} ${sandboxResponse.statusText}`,
        );
      }

      // Set up SSE only after sandbox stream is confirmed available.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      streamWriter = createBufferedSseWriter(res, {
        maxPendingBytes: TURN_STREAM_MAX_PENDING_BYTES,
      });
      streamHeartbeatInterval = setInterval(() => {
        if (!streamWriter) return;
        if (streamWriter.isClosed()) {
          stopStreamHeartbeat();
          return;
        }
        if (!streamWriter.sendComment("ping")) {
          stopStreamHeartbeat();
        }
      }, TURN_STREAM_HEARTBEAT_INTERVAL_MS);
      req.on("close", () => {
        stopStreamHeartbeat();
      });

      // Send session ID first so the client can persist message routing.
      if (!writeSseEvent({ type: "session", sessionId: currentSessionId })) {
        stopLeaseRefresh();
        stopStreamHeartbeat();
        return res.end();
      }

      const reader = sandboxResponse.body.getReader();
      const decoder = new TextDecoder();
      let streamBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        streamBuffer += decoder.decode(value, { stream: true });
        const lines = streamBuffer.split("\n");
        streamBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (!writeSseEvent(event)) {
              stopLeaseRefresh();
              stopStreamHeartbeat();
              return res.end();
            }
            handleEvent(event);
          } catch {
            // ignore malformed SSE chunk
          }
        }
      }

      let fullAnswer = getFullAnswer();

      if (!fullAnswer.trim()) {
        const fallbackAnswer = await buildProducedFilesMessage(
          orgId,
          agentId,
          toolCalls,
          outputFolder || undefined,
        );
        if (fallbackAnswer) {
          fullAnswer = fallbackAnswer;
          segments.push({ type: "text", content: fallbackAnswer });
          writeSseEvent({ type: "text", data: fallbackAnswer });
        }
      }

      if (!fullAnswer.trim() && streamError) {
        fullAnswer = `Error: ${streamError}`;
        segments.push({ type: "text", content: fullAnswer });
        writeSseEvent({ type: "text", data: fullAnswer });
      }

      if (!fullAnswer.trim() && toolCalls.length === 0 && !streamError) {
        const shouldEmitFallback = await shouldEmitNoOutputFallback(
          orgId,
          currentSessionId,
        );
        if (shouldEmitFallback) {
          fullAnswer = NO_OUTPUT_FALLBACK_MESSAGE;
          segments.push({ type: "text", content: fullAnswer });
          writeSseEvent({ type: "text", data: fullAnswer });
        }
      }

      await persistAssistantMessage({ emitSanitizedReplaceEvent: true });

      // Update session timestamp
      await withOrgContextQuery(
        orgId,
        `UPDATE agent_chat_sessions SET updated_at = NOW() WHERE id = $1`,
        [currentSessionId],
      );

      // Auto-title: set title from first user message if not already set
      const sessionCheck = await withOrgContextQuery(
        orgId,
        `SELECT title FROM agent_chat_sessions WHERE id = $1`,
        [currentSessionId],
      );
      if (sessionCheck.rows.length > 0 && !sessionCheck.rows[0].title) {
        const autoTitle =
          message.slice(0, 60).trim() + (message.length > 60 ? "..." : "");
        await withOrgContextQuery(
          orgId,
          `UPDATE agent_chat_sessions SET title = $1 WHERE id = $2`,
          [autoTitle, currentSessionId],
        );
        writeSseEvent({ type: "session_update", data: { title: autoTitle } });
      }

      // Release the stream lease now that the request has completed.
      stopLeaseRefresh();
      stopStreamHeartbeat();

      if (streamWriter) {
        streamWriter.close();
      } else {
        res.end();
      }
    } catch (error) {
      // Stop the lease refresh interval. The 90-second TTL on
      // active_stream_lease_until acts as a safety net for the lease itself.
      stopLeaseRefresh();
      stopStreamHeartbeat();
      try {
        await persistAssistantMessage();
      } catch (persistError) {
        console.error(
          "Failed to persist partial assistant response:",
          persistError,
        );
      }
      if (isRecoverableSandboxTransportError(error)) {
        try {
          const ensured = await ensureSandbox(orgId, agentId, {
            touchActivity: false,
          });
          if (ensured.status !== "starting") {
            throw new Error("Sandbox transport disconnected while VM is ready");
          }
          const reason = ensured.reason;
          const retryAfterMs = ensured.retryAfterMs;

          if (!res.headersSent) {
            return res.status(503).json({
              error: "Sandbox is starting",
              reason,
              retryAfterMs,
            });
          }

          writeSseEvent({
            type: "vm_starting",
            data: { reason, retryAfterMs },
          });
          writeSseEvent({ type: "done" });
          if (streamWriter) {
            streamWriter.close();
          } else {
            res.end();
          }
          return;
        } catch (ensureError) {
          // If ensure check itself fails, keep the existing vm_starting fallback.
          if (ensureError instanceof SandboxNotReadyError) {
            if (!res.headersSent) {
              return res.status(503).json({
                error: "Sandbox is starting",
                reason: ensureError.reason,
                retryAfterMs: ensureError.retryAfterMs,
              });
            }
            try {
              writeSseEvent({
                type: "vm_starting",
                data: {
                  reason: ensureError.reason,
                  retryAfterMs: ensureError.retryAfterMs,
                },
              });
              writeSseEvent({ type: "done" });
            } catch {
              // headers already sent / socket closed
            }
            if (streamWriter) {
              streamWriter.close();
            } else {
              res.end();
            }
            return;
          }

          console.error(
            "Agent chat transport error while sandbox is ready:",
            error,
          );
          if (!res.headersSent) {
            return res.status(502).json({
              error: "Sandbox transport disconnected. Please retry.",
            });
          }
          try {
            writeSseEvent({
              type: "error",
              data: "Sandbox transport disconnected. Please retry.",
            });
            writeSseEvent({ type: "done" });
          } catch {
            // headers already sent / socket closed
          }
          if (streamWriter) {
            streamWriter.close();
          } else {
            res.end();
          }
          return;
        }
      }

      console.error("Agent chat error:", error);
      if (!res.headersSent) {
        return res.status(500).json({ error: "Agent chat failed" });
      }
      try {
        writeSseEvent({ type: "error", data: "Agent chat failed" });
        writeSseEvent({ type: "done" });
      } catch {
        // headers already sent
      }
      if (streamWriter) {
        streamWriter.close();
      } else {
        res.end();
      }
    }
  },
);

// Get chat history for a session
router.get(
  "/sessions/:sessionId/messages",
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const sessionId = getRouteParam(req.params.sessionId);
      const access = await checkSessionAccess(
        orgId,
        sessionId,
        user.id,
        "viewer",
      );
      if (access === "not_found") {
        return res.status(404).json({ error: "Session not found" });
      }
      if (access !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }

      const result = await withOrgContextQuery(
        orgId,
        `SELECT id, session_id, user_id, role, content, tool_calls, segments, sources, created_at
       FROM agent_chat_messages
       WHERE session_id = $1
       ORDER BY created_at ASC`,
        [sessionId],
      );
      const messages = [...result.rows];
      const runningTurnId = config.chatResumableStream
        ? resumableTurnStore.getRunningTurnId(sessionId)
        : null;
      if (runningTurnId) {
        const checkpoint = await readTurnCheckpoint(
          orgId,
          sessionId,
          runningTurnId,
        );
        if (hasCheckpointData(checkpoint)) {
          const checkpointRow = checkpoint!;
          messages.push({
            id: `checkpoint-${checkpointRow.turn_id}`,
            session_id: sessionId,
            user_id: null,
            role: "assistant",
            content: checkpointRow.assistant_content,
            tool_calls: normalizeJsonArray(checkpointRow.tool_calls),
            segments: normalizeJsonArray(checkpointRow.segments),
            sources: [],
            created_at: checkpointRow.updated_at,
            turn_id: checkpointRow.turn_id,
            last_seq: Number(checkpointRow.last_seq || 0),
            partial: true,
          });
        }
      }
      res.json({ messages, runningTurnId: runningTurnId || null });
    } catch (error) {
      console.error("Get messages error:", error);
      res.status(500).json({ error: "Failed to get messages" });
    }
  },
);

router.get(
  "/sessions/:sessionId/running-turn",
  validate({ params: sessionParamsSchema }),
  async (req: Request, res: Response) => {
    try {
      if (!config.chatResumableStream) {
        return res.status(404).json({ error: "Not found" });
      }

      const { orgId, user } = requireAuthContext(req);
      const sessionId = getRouteParam(req.params.sessionId);
      const access = await checkSessionAccess(
        orgId,
        sessionId,
        user.id,
        "viewer",
      );
      if (access === "not_found") {
        return res.status(404).json({ error: "Session not found" });
      }
      if (access !== "allowed") {
        return res.status(403).json({ error: "Forbidden" });
      }

      const running = getRunningTurnWithSource(sessionId);
      return res.json({
        turnId: running?.turnId || null,
        source: running?.source || null,
      });
    } catch (error) {
      console.error("Get running turn error:", error);
      return res.status(500).json({ error: "Failed to get running turn" });
    }
  },
);

// Subscribe to live session events (goal background runs, etc.)
router.get("/sessions/:sessionId/live", async (req: Request, res: Response) => {
  try {
    const { orgId, user } = requireAuthContext(req);
    const sessionId = getRouteParam(req.params.sessionId);
    const access = await checkSessionAccess(
      orgId,
      sessionId,
      user.id,
      "viewer",
    );
    if (access === "not_found") {
      return res.status(404).json({ error: "Session not found" });
    }
    if (access !== "allowed") {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    const writer = createBufferedSseWriter(res, {
      maxPendingBytes: TURN_STREAM_MAX_PENDING_BYTES,
    });
    const writeEvent = (event: unknown): boolean => writer.sendData(event);

    if (
      !writeEvent({
        type: "session",
        sessionId,
        source: "live_stream",
      })
    ) {
      return res.end();
    }

    const unsubscribe = subscribeSessionLiveEvents(sessionId, (event) => {
      if (writeEvent(event)) return;
      clearInterval(keepAlive);
      unsubscribe();
      writer.close();
    });

    const keepAlive = setInterval(() => {
      if (writer.isClosed()) {
        clearInterval(keepAlive);
        unsubscribe();
        return;
      }
      if (!writer.sendComment("ping")) {
        clearInterval(keepAlive);
        unsubscribe();
        writer.close();
      }
    }, TURN_STREAM_HEARTBEAT_INTERVAL_MS);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      writer.close();
    });
  } catch (error) {
    console.error("Session live stream error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to open live stream" });
    } else {
      try {
        res.write(
          `data: ${JSON.stringify({ type: "error", data: "Live stream failed" })}\n\n`,
        );
      } catch {
        // ignore
      }
      res.end();
    }
  }
});

// Get the latest session id and all messages across sessions for an agent
router.get(
  "/:agentId/latest",
  requireAgentAccess("viewer"),
  async (req: Request, res: Response) => {
    try {
      const { orgId, user } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const sessionResult = await withOrgContextQuery(
        orgId,
        `SELECT id FROM agent_chat_sessions
       WHERE agent_id = $1
         AND created_by = $2
       ORDER BY created_at DESC
       LIMIT 1`,
        [agentId, user.id],
      );

      if (sessionResult.rows.length === 0) {
        return res.json({ sessionId: null, messages: [] });
      }

      const sessionId = sessionResult.rows[0].id;
      const messagesResult = await withOrgContextQuery(
        orgId,
        `SELECT m.id, m.session_id, m.user_id, m.role, m.content, m.tool_calls, m.segments, m.sources, m.created_at
       FROM agent_chat_messages m
       WHERE m.session_id = $1
       ORDER BY m.created_at ASC`,
        [sessionId],
      );

      res.json({ sessionId, messages: messagesResult.rows });
    } catch (error) {
      console.error("Get latest chat error:", error);
      res.status(500).json({ error: "Failed to get latest chat" });
    }
  },
);

export default router;
