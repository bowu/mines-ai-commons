import { useAgents } from "@/contexts/AgentsContext";
import { useAuth } from "@/contexts/AuthContext";
import {
  type AgentChatEvent,
  type AgentModel,
  type AgentSkill,
  type SessionGoal,
  type WorkspaceFile,
  cancelSessionGoal,
  cancelSessionTurn,
  ensureSandbox,
  getAgent,
  getSessionGoal,
  getSessionMessages,
  getSessionRunningTurn,
  installAgentSkill,
  listWorkspaceFiles,
  streamAgentChat,
  streamAgentTurn,
  subscribeSessionLiveEvents,
  uninstallAgentSkill,
  updateSession as updateChatSession,
  upsertSessionGoal,
} from "@/lib/api";
import { canonicalizeWorkspacePath } from "@/lib/file-utils";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  FlaskConical,
  Loader2,
  Moon,
  Power,
  Target,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AgentSkillsDrawer } from "./AgentSkillsDrawer";
import {
  type AgentMessage,
  ChatView,
  type MessageSegment,
  type ToolCallInfo,
} from "./ChatView";
import { FilePreviewOverlay } from "./FilePreviewOverlay";
import { FolderPickerModal } from "./FolderPickerModal";
import { WorkspaceView } from "./WorkspaceView";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

type ViewMode = "chat" | "workspace";
const DEFAULT_AGENT_MODEL: AgentModel = "gemini-3.1-pro";
const WAKE_TRACE_LOGS = import.meta.env.VITE_WAKE_TRACE_LOGS === "true";
const RESUMABLE_TURN_KEY_PREFIX = "resumableTurn:";
const SUPPRESSED_TURN_KEY_PREFIX = "suppressedTurn:";
type MachineProfileId = string;
interface MachineProfileOption {
  id: MachineProfileId;
  label: string;
  machineType: string;
}
const MACHINE_PROFILE_OPTIONS: readonly MachineProfileOption[] = [
  {
    id: "e2-medium",
    label: "CPU (e2-medium)",
    machineType: "e2-medium",
  },
  {
    id: "a2-highgpu-1g",
    label: "A100 x1",
    machineType: "a2-highgpu-1g",
  },
  {
    id: "a2-highgpu-2g",
    label: "A100 x2",
    machineType: "a2-highgpu-2g",
  },
  {
    id: "a2-highgpu-4g",
    label: "A100 x4",
    machineType: "a2-highgpu-4g",
  },
  {
    id: "a2-highgpu-8g",
    label: "A100 x8",
    machineType: "a2-highgpu-8g",
  },
];
const DEFAULT_MACHINE_TYPE = "e2-medium";

interface StoredResumableTurn {
  turnId: string;
  lastSeq: number;
  source?: "foreground" | "goal_background";
}

/** Per-agent chat state persisted across agent switches */
interface PerAgentState {
  messages: AgentMessage[];
  sessionId: string | undefined;
  isLoading: boolean;
  isGoalStreaming: boolean;
  activeResumeTurnId: string | null;
  liveGoalTurnId: string | null;
  liveGoalTurnOpen: boolean;
  input: string;
  model: AgentModel;
  outputFolder: string | null;
  goal: SessionGoal | null;
  abortController: AbortController | null;
  loaded: boolean; // whether chat history was loaded from DB
}

function flattenWorkspaceFilePaths(items: WorkspaceFile[]): string[] {
  const paths: string[] = [];
  const walk = (nodes: WorkspaceFile[]) => {
    for (const node of nodes) {
      if (node.type === "file") {
        paths.push(node.path);
      } else if (node.children?.length) {
        walk(node.children);
      }
    }
  };
  walk(items);
  return paths;
}

async function filterExistingWorkspacePaths(
  agentId: string,
  candidatePaths: string[],
): Promise<string[]> {
  const unique = Array.from(new Set(candidatePaths));
  if (unique.length === 0) return [];
  try {
    const data = await listWorkspaceFiles(agentId, {
      recursive: true,
      includeStats: false,
    });
    const existing = new Set(flattenWorkspaceFilePaths(data.files));
    return unique.filter((p) => existing.has(p));
  } catch {
    return [];
  }
}

function getParentDir(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "" : filePath.slice(0, idx);
}

function getExtension(filePath: string): string {
  const last = filePath.split("/").pop() || "";
  const dot = last.lastIndexOf(".");
  return dot === -1 ? "" : last.slice(dot + 1).toLowerCase();
}

function areAgentMessagesEqual(a: AgentMessage[], b: AgentMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left.role !== right.role) return false;
    if (left.content !== right.content) return false;
    if ((left.turnId || null) !== (right.turnId || null)) return false;
    if (Boolean(left.partial) !== Boolean(right.partial)) return false;
    if (
      JSON.stringify(left.segments || []) !==
      JSON.stringify(right.segments || [])
    ) {
      return false;
    }
    if (
      JSON.stringify(left.toolCalls || []) !==
      JSON.stringify(right.toolCalls || [])
    ) {
      return false;
    }
  }
  return true;
}

function applyToolResultToMessage(
  message: AgentMessage,
  data: { name?: unknown; result?: unknown; error?: unknown },
): AgentMessage {
  const toolName =
    typeof data.name === "string" && data.name.trim().length > 0
      ? data.name
      : null;
  const normalizedResult = data.result === undefined ? null : data.result;
  const normalizedError = Boolean(data.error);

  let segUpdated = false;
  const segments = (message.segments || []).map((seg) => {
    if (
      segUpdated ||
      seg.type !== "tool" ||
      seg.result !== undefined ||
      seg.error
    ) {
      return seg;
    }
    if (toolName && seg.name !== toolName) {
      return seg;
    }
    segUpdated = true;
    return {
      ...seg,
      result: normalizedResult,
      error: normalizedError,
    };
  });

  let tcUpdated = false;
  const toolCalls = (message.toolCalls || []).map((tc) => {
    if (tcUpdated || tc.result !== undefined || tc.error) {
      return tc;
    }
    if (toolName && tc.name !== toolName) {
      return tc;
    }
    tcUpdated = true;
    return {
      ...tc,
      result: normalizedResult,
      error: normalizedError,
    };
  });

  return {
    ...message,
    segments,
    toolCalls,
  };
}

interface ParsedStreamingTextPayload {
  replaceText: string | null;
  textChunk: string;
  blockIndex?: number;
}

type StreamSegmentType = "text" | "thinking";

function parseStreamingTextPayload(
  payload: unknown,
): ParsedStreamingTextPayload {
  const isReplace =
    payload &&
    typeof payload === "object" &&
    (payload as { mode?: string }).mode === "replace" &&
    typeof (payload as { text?: unknown }).text === "string";
  const blockIndex =
    isReplace &&
    typeof (payload as { blockIndex?: unknown }).blockIndex === "number"
      ? (payload as { blockIndex: number }).blockIndex
      : undefined;
  const replaceText = isReplace
    ? String((payload as { text: string }).text)
    : null;
  return {
    replaceText,
    textChunk: replaceText ?? String(payload ?? ""),
    blockIndex,
  };
}

function buildStreamSegment(
  segmentType: StreamSegmentType,
  content: string,
  blockIndex?: number,
): MessageSegment {
  if (segmentType === "text") {
    return { type: "text", content, blockIndex };
  }
  return { type: "thinking", content, blockIndex };
}

function upsertIndexedStreamSegment(
  currentSegments: MessageSegment[],
  segmentType: StreamSegmentType,
  blockIndex: number,
  content: string,
): MessageSegment[] {
  const nextSegments = [...currentSegments];
  const indexedIdx = nextSegments.findIndex(
    (segment) =>
      segment.type === segmentType && segment.blockIndex === blockIndex,
  );
  if (indexedIdx >= 0) {
    nextSegments[indexedIdx] = buildStreamSegment(
      segmentType,
      content,
      blockIndex,
    );
    return nextSegments;
  }

  // First indexed replace after restored legacy content: upgrade one existing
  // unindexed segment in-place so streaming never drops previously rendered text.
  const hasIndexedForType = nextSegments.some(
    (segment) =>
      segment.type === segmentType && typeof segment.blockIndex === "number",
  );
  if (!hasIndexedForType) {
    const legacyIndices = nextSegments
      .map((segment, idx) => ({ segment, idx }))
      .filter(
        ({ segment }) =>
          segment.type === segmentType && segment.blockIndex === undefined,
      )
      .map(({ idx }) => idx);
    const legacyIdx = legacyIndices[blockIndex] ?? legacyIndices[0];
    if (legacyIdx !== undefined) {
      nextSegments[legacyIdx] = buildStreamSegment(
        segmentType,
        content,
        blockIndex,
      );
      return nextSegments;
    }
  }

  nextSegments.push(buildStreamSegment(segmentType, content, blockIndex));
  return nextSegments;
}

function appendStreamingChunk(
  currentSegments: MessageSegment[],
  segmentType: StreamSegmentType,
  textChunk: string,
): MessageSegment[] {
  const nextSegments = [...currentSegments];
  const lastSegment = nextSegments[nextSegments.length - 1];
  if (
    lastSegment &&
    lastSegment.type === segmentType &&
    lastSegment.blockIndex === undefined
  ) {
    nextSegments[nextSegments.length - 1] = {
      ...lastSegment,
      content: lastSegment.content + textChunk,
    };
    return nextSegments;
  }
  nextSegments.push(buildStreamSegment(segmentType, textChunk));
  return nextSegments;
}

function flattenTextSegments(segments: MessageSegment[]): string {
  return segments
    .filter((segment) => segment.type === "text")
    .map((segment) => (segment as { type: "text"; content: string }).content)
    .join("\n\n");
}

function applyStreamingTextUpdate(
  message: AgentMessage,
  payload: unknown,
): AgentMessage {
  const { replaceText, textChunk, blockIndex } =
    parseStreamingTextPayload(payload);

  if (replaceText !== null && blockIndex !== undefined) {
    const segments = upsertIndexedStreamSegment(
      message.segments || [],
      "text",
      blockIndex,
      replaceText,
    );
    return {
      ...message,
      content: flattenTextSegments(segments),
      segments,
    };
  }

  if (replaceText !== null) {
    const toolSegments = (message.segments || []).filter(
      (segment) => segment.type === "tool",
    );
    const segments: MessageSegment[] = [...toolSegments];
    if (replaceText.length > 0) {
      segments.push({ type: "text", content: replaceText });
    }
    return {
      ...message,
      content: replaceText,
      segments,
    };
  }

  const segments = appendStreamingChunk(
    message.segments || [],
    "text",
    textChunk,
  );
  return {
    ...message,
    content: (message.content || "") + textChunk,
    segments,
  };
}

function applyStreamingThinkingUpdate(
  message: AgentMessage,
  payload: unknown,
): AgentMessage {
  const { replaceText, textChunk, blockIndex } =
    parseStreamingTextPayload(payload);

  if (replaceText !== null && blockIndex !== undefined) {
    return {
      ...message,
      segments: upsertIndexedStreamSegment(
        message.segments || [],
        "thinking",
        blockIndex,
        replaceText,
      ),
    };
  }

  return {
    ...message,
    segments: appendStreamingChunk(
      message.segments || [],
      "thinking",
      textChunk,
    ),
  };
}

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

function getCommandBaseDir(command: string): string {
  const match = command.match(/^\s*cd\s+(['"]?)([^'"&;|]+)\1\s*&&/);
  if (!match) return "";
  const dir = normalizePathCandidate(match[2]) || "";
  return dir.replace(/\/+$/, "");
}

function extractPathsFromText(text: string, baseDir = ""): string[] {
  const matches = new Set<string>();
  const add = (candidate: string) => {
    const normalized = normalizePathCandidate(candidate, baseDir);
    if (normalized) matches.add(normalized);
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

  return Array.from(matches);
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
        const parsed = JSON.parse(trimmed);
        collectPathsFromUnknown(parsed, baseDir, out);
      } catch {
        // Not JSON; continue with text extraction.
      }
    }
    for (const p of extractPathsFromText(value, baseDir)) out.add(p);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPathsFromUnknown(item, baseDir, out);
    return;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
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
      if (typeof record[key] === "string") {
        const normalized = normalizePathCandidate(
          record[key] as string,
          baseDir,
        );
        if (normalized) out.add(normalized);
      }
    }
    for (const nested of Object.values(record)) {
      collectPathsFromUnknown(nested, baseDir, out);
    }
  }
}

function extractProducedPathsFromToolResult(
  toolName: string,
  args: Record<string, unknown> | undefined,
  result: unknown,
  error: boolean | undefined,
): string[] {
  if (error) return [];

  const output = new Set<string>();
  const baseDir =
    toolName === "bash" && typeof args?.command === "string"
      ? getCommandBaseDir(args.command)
      : "";

  if (typeof args?.path === "string") {
    const argPath = normalizePathCandidate(args.path, baseDir);
    if (argPath) output.add(argPath);
  }

  collectPathsFromUnknown(result, baseDir, output);
  return Array.from(output);
}

function pickLinkableProducedFiles(
  paths: string[],
  outputFolder?: string | null,
): string[] {
  const unique = Array.from(new Set(paths));
  const filtered = unique.filter((p) => {
    const ext = getExtension(p);
    return (
      ext.length > 0 &&
      !NOISY_FILE_EXTENSIONS.has(ext) &&
      RESEARCH_DELIVERABLE_EXTENSIONS.has(ext)
    );
  });

  const preferredOutputPrefix = (outputFolder || "").replace(/^\/+|\/+$/g, "");
  const inPreferredOutput = (p: string) =>
    preferredOutputPrefix
      ? p === preferredOutputPrefix || p.startsWith(`${preferredOutputPrefix}/`)
      : false;

  const preferredOrder = [
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
  const rank = new Map(preferredOrder.map((ext, idx) => [ext, idx]));
  filtered.sort((a, b) => {
    const aInOutput = inPreferredOutput(a);
    const bInOutput = inPreferredOutput(b);
    if (aInOutput !== bInOutput) return aInOutput ? -1 : 1;
    const ra = rank.get(getExtension(a)) ?? 999;
    const rb = rank.get(getExtension(b)) ?? 999;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  return filtered.slice(0, 6);
}

function encodeFileLinkPath(relativePath: string): string {
  return relativePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function buildProducedFilesMessage(paths: string[]): string {
  if (paths.length === 1) {
    const p = paths[0];
    const name = p.split("/").pop() || p;
    return `Created file: [${name}](file://${encodeFileLinkPath(p)})`;
  }

  const items = paths
    .map((p) => {
      const name = p.split("/").pop() || p;
      return `- [${name}](file://${encodeFileLinkPath(p)})`;
    })
    .join("\n");
  return `Created files:\n\n${items}`;
}

/** Parse /agents/:agentId/c/:sessionId from pathname */
function parseAgentParams(pathname: string): {
  agentId?: string;
  sessionId?: string;
} {
  const m = pathname.match(
    /\/agents\/([0-9a-f-]{36})(?:\/c\/([0-9a-f-]{36}))?/,
  );
  if (!m) return {};
  return { agentId: m[1], sessionId: m[2] };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoToLocalDatetimeInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const tzOffsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

function localDatetimeInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

const GOAL_ACCEPTANCE_HEADER = "Acceptance criteria:";
const GOAL_ADDITIONAL_GUIDANCE_HEADER = "Additional guidance:";

function parseGoalGuidance(rawGuidance: string | null | undefined): {
  acceptanceCriteria: string;
  guidance: string;
} {
  const raw = String(rawGuidance || "").trim();
  if (!raw) {
    return { acceptanceCriteria: "", guidance: "" };
  }
  const normalized = raw.replace(/\r\n/g, "\n");
  const acceptanceMatch = normalized.match(
    /^Acceptance criteria:\s*\n([\s\S]*?)(?:\n{2,}Additional guidance:\s*\n([\s\S]*))?$/i,
  );
  if (acceptanceMatch) {
    return {
      acceptanceCriteria: String(acceptanceMatch[1] || "").trim(),
      guidance: String(acceptanceMatch[2] || "").trim(),
    };
  }
  return { acceptanceCriteria: raw, guidance: "" };
}

function buildStoredGoalGuidance(options: {
  acceptanceCriteria: string;
  guidance: string;
}): string {
  const acceptance = options.acceptanceCriteria.trim();
  const guidance = options.guidance.trim();
  const lines = [GOAL_ACCEPTANCE_HEADER, acceptance];
  if (guidance) {
    lines.push("", GOAL_ADDITIONAL_GUIDANCE_HEADER, guidance);
  }
  return lines.join("\n");
}

function buildGoalStartMessage(options: {
  goal: string;
  acceptanceCriteria: string;
  guidance: string;
  deadlineIso: string | null;
  outputFolder: string;
}): string {
  const lines = [
    "Start goal mode for this conversation.",
    `Goal: ${options.goal}`,
    `Acceptance criteria: ${options.acceptanceCriteria}`,
    options.guidance
      ? `Additional guidance: ${options.guidance}`
      : "Additional guidance: none",
    options.deadlineIso ? `Deadline: ${options.deadlineIso}` : "Deadline: none",
    `Output folder: /${options.outputFolder}`,
    "Begin now. Keep producing meaningful intermediate artifacts and updating progress until complete.",
  ];
  return lines.join("\n");
}

function wakeTraceClient(event: string, details: Record<string, unknown> = {}) {
  if (!WAKE_TRACE_LOGS) return;
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...details,
  };
  console.info("[wake_trace_client]", payload);
}

function formatSandboxStatusMessage(reason?: string): string {
  switch (reason) {
    case "vm_creating":
      return "Sandbox VM is being created...";
    case "vm_deleting":
      return "Sandbox VM is being deleted...";
    case "vm_stopping":
      return "Sandbox VM is stopping...";
    case "vm_upgrading":
      return "Sandbox VM is upgrading...";
    case "vm_error_retrying":
      return "Sandbox hit an error and is retrying...";
    case "vm_starting":
      return "Sandbox is starting...";
    default:
      return "Starting sandbox...";
  }
}

function vmStatusToEnsureReason(
  vmStatus?: string | null,
):
  | "vm_creating"
  | "vm_starting"
  | "vm_stopping"
  | "vm_deleting"
  | "vm_upgrading"
  | "vm_error_retrying"
  | undefined {
  switch (vmStatus) {
    case "creating":
      return "vm_creating";
    case "deleting":
      return "vm_deleting";
    case "stopping":
      return "vm_stopping";
    case "upgrading":
      return "vm_upgrading";
    case "starting":
      return "vm_starting";
    case "error":
      return "vm_error_retrying";
    default:
      return undefined;
  }
}

function parseGpuFallbackProvisionError(message: string | null | undefined): {
  requestedMachineType: string;
  fallbackMachineType: string;
} | null {
  const text = (message || "").trim();
  if (!text) return null;
  const match = text.match(
    /Requested machine type '([^']+)' failed to allocate\. Falling back to '([^']+)'/i,
  );
  if (!match) return null;
  const requestedMachineType = (match[1] || "").trim();
  const fallbackMachineType = (match[2] || "").trim();
  if (!requestedMachineType || !fallbackMachineType) return null;
  if (!/gpu/i.test(requestedMachineType)) return null;
  return { requestedMachineType, fallbackMachineType };
}

function resumableTurnStorageKey(sessionId: string): string {
  return `${RESUMABLE_TURN_KEY_PREFIX}${sessionId}`;
}

function readStoredResumableTurn(
  sessionId: string,
): StoredResumableTurn | null {
  try {
    const raw = sessionStorage.getItem(resumableTurnStorageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      turnId?: unknown;
      lastSeq?: unknown;
      source?: unknown;
    };
    if (typeof parsed.turnId !== "string" || !parsed.turnId.trim()) return null;
    const lastSeq =
      typeof parsed.lastSeq === "number" && Number.isFinite(parsed.lastSeq)
        ? parsed.lastSeq
        : 0;
    const source =
      parsed.source === "goal_background" || parsed.source === "foreground"
        ? parsed.source
        : undefined;
    return { turnId: parsed.turnId, lastSeq: Math.max(0, lastSeq), source };
  } catch {
    return null;
  }
}

function writeStoredResumableTurn(
  sessionId: string,
  state: StoredResumableTurn,
): void {
  try {
    sessionStorage.setItem(
      resumableTurnStorageKey(sessionId),
      JSON.stringify(state),
    );
  } catch {
    // ignore sessionStorage failures
  }
}

function clearStoredResumableTurn(sessionId: string): void {
  try {
    sessionStorage.removeItem(resumableTurnStorageKey(sessionId));
  } catch {
    // ignore sessionStorage failures
  }
}

function suppressedTurnStorageKey(sessionId: string): string {
  return `${SUPPRESSED_TURN_KEY_PREFIX}${sessionId}`;
}

function readSuppressedTurn(sessionId: string): string | null {
  try {
    const raw = sessionStorage.getItem(suppressedTurnStorageKey(sessionId));
    if (!raw) return null;
    const turnId = raw.trim();
    return turnId.length > 0 ? turnId : null;
  } catch {
    return null;
  }
}

function writeSuppressedTurn(sessionId: string, turnId: string): void {
  try {
    sessionStorage.setItem(suppressedTurnStorageKey(sessionId), turnId);
  } catch {
    // ignore sessionStorage failures
  }
}

function clearSuppressedTurn(sessionId: string): void {
  try {
    sessionStorage.removeItem(suppressedTurnStorageKey(sessionId));
  } catch {
    // ignore sessionStorage failures
  }
}

export function AgentsPage() {
  const { pathname } = useLocation();
  const { agentId: urlAgentId, sessionId: urlSessionId } = useMemo(
    () => parseAgentParams(pathname),
    [pathname],
  );
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    agents,
    markBusy,
    clearBusy,
    touchAgent,
    loadAgents,
    sessions,
    loadSessions,
    createNewSession,
    touchSession,
    setSessionTitle,
    setSessionModel,
    updateAgent,
  } = useAgents();
  const { user } = useAuth();

  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<AgentModel>(DEFAULT_AGENT_MODEL);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoalStreaming, setIsGoalStreaming] = useState(false);
  const [isSessionHydrating, setIsSessionHydrating] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [showSkills, setShowSkills] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    searchParams.get("view") === "workspace" || searchParams.get("wsFile")
      ? "workspace"
      : "chat",
  );
  const [outputFolder, setOutputFolder] = useState<string | null>(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [goal, setGoal] = useState<SessionGoal | null>(null);
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [showGoalFolderPicker, setShowGoalFolderPicker] = useState(false);
  const [goalDraft, setGoalDraft] = useState({
    goal: "",
    acceptanceCriteria: "",
    guidance: "",
    deadlineAt: "",
    outputFolder: "",
  });
  const goalDraftDeadlineIso = useMemo(
    () => localDatetimeInputToIso(goalDraft.deadlineAt),
    [goalDraft.deadlineAt],
  );
  const goalDraftHasPastDeadline = useMemo(() => {
    if (!goalDraftDeadlineIso) return false;
    const deadlineMs = Date.parse(goalDraftDeadlineIso);
    if (!Number.isFinite(deadlineMs)) return false;
    return deadlineMs <= Date.now();
  }, [goalDraftDeadlineIso]);
  const [sandboxState, setSandboxState] = useState<
    "ready" | "waking" | "asleep" | "error"
  >("ready");
  const [sandboxMessage, setSandboxMessage] = useState("");
  const [pendingMachineProfileId, setPendingMachineProfileId] =
    useState<MachineProfileId | null>(null);
  const [showMachineTransitionDialog, setShowMachineTransitionDialog] =
    useState(false);
  const [machineTransitionLoading, setMachineTransitionLoading] =
    useState(false);
  const [showUpgradeRiskDialog, setShowUpgradeRiskDialog] = useState(false);
  const [showGpuFallbackDialog, setShowGpuFallbackDialog] = useState(false);
  const [gpuFallbackInfo, setGpuFallbackInfo] = useState<{
    requestedMachineType: string;
    fallbackMachineType: string;
  } | null>(null);
  const runningTurnProbeRef = useRef<Set<string>>(new Set());
  const suppressedTurnBySessionRef = useRef<Map<string, string>>(new Map());
  const seenGpuFallbackNoticeRef = useRef<Set<string>>(new Set());
  const filePreviewResolveSeqRef = useRef(0);
  const [upgradeRiskMessage, setUpgradeRiskMessage] = useState<string | null>(
    null,
  );

  // Per-session state ref (source of truth — survives agent/session switches)
  // Keys are `${agentId}:${sessionId}`
  const agentStatesRef = useRef<Map<string, PerAgentState>>(new Map());
  const selectedIdRef = useRef<string | null>(null); // agentId
  const selectedSessionRef = useRef<string | null>(null); // sessionId
  const searchParamsRef = useRef(searchParams);
  const ensureRunIdRef = useRef(0);
  const handleSendRef = useRef<(() => Promise<void>) | null>(null);
  const sessionLoadInFlightRef = useRef<Set<string>>(new Set());

  // Keep ref in sync so callbacks can read current search params without closure staleness
  searchParamsRef.current = searchParams;

  // Derive selected agent/session from URL params
  const selectedAgentId = urlAgentId || null;
  const selectedSessionId = urlSessionId || null;
  const agentIdsKey = useMemo(
    () => agents.map((agent) => agent.id).join(","),
    [agents],
  );

  // File preview/workspace selection from search params
  const previewFileRaw = searchParams.get("file");
  const workspaceFileRaw = searchParams.get("wsFile");
  const previewFile = canonicalizeWorkspacePath(previewFileRaw);
  const workspaceFile = canonicalizeWorkspacePath(workspaceFileRaw);
  const workspaceViewRequested =
    searchParams.get("view") === "workspace" || Boolean(workspaceFile);

  useEffect(() => {
    let changed = false;
    const next = new URLSearchParams(searchParams);

    const rawPreview = searchParams.get("file");
    if (rawPreview) {
      const normalized = canonicalizeWorkspacePath(rawPreview);
      if (normalized) {
        if (normalized !== rawPreview) {
          next.set("file", normalized);
          changed = true;
        }
      } else {
        next.delete("file");
        changed = true;
      }
    }

    const rawWorkspace = searchParams.get("wsFile");
    if (rawWorkspace) {
      const normalized = canonicalizeWorkspacePath(rawWorkspace);
      if (normalized) {
        if (normalized !== rawWorkspace) {
          next.set("wsFile", normalized);
          changed = true;
        }
      } else {
        next.delete("wsFile");
        changed = true;
      }
    }

    if (changed) {
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const updateSearchParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        return next;
      });
    },
    [setSearchParams],
  );

  useEffect(() => {
    const nextMode: ViewMode = workspaceViewRequested ? "workspace" : "chat";
    setViewMode((prev) => (prev === nextMode ? prev : nextMode));
  }, [workspaceViewRequested]);

  const getStateKey = useCallback(
    (agentId: string, sessId?: string | null) =>
      sessId ? `${agentId}:${sessId}` : agentId,
    [],
  );

  const getOrCreateState = useCallback(
    (agentId: string, sessId?: string | null): PerAgentState => {
      const key = sessId ? `${agentId}:${sessId}` : agentId;
      let state = agentStatesRef.current.get(key);
      if (!state) {
        state = {
          messages: [],
          sessionId: sessId || undefined,
          isLoading: false,
          isGoalStreaming: false,
          activeResumeTurnId: null,
          liveGoalTurnId: null,
          liveGoalTurnOpen: false,
          input: "",
          model: DEFAULT_AGENT_MODEL,
          outputFolder: null,
          goal: null,
          abortController: null,
          loaded: false,
        };
        agentStatesRef.current.set(key, state);
      }
      return state;
    },
    [],
  );

  const getSuppressedTurn = useCallback((sessId: string): string | null => {
    const fromRef = suppressedTurnBySessionRef.current.get(sessId);
    if (fromRef) return fromRef;
    const fromStorage = readSuppressedTurn(sessId);
    if (fromStorage) {
      suppressedTurnBySessionRef.current.set(sessId, fromStorage);
      return fromStorage;
    }
    return null;
  }, []);

  const setSuppressedTurn = useCallback((sessId: string, turnId: string) => {
    suppressedTurnBySessionRef.current.set(sessId, turnId);
    writeSuppressedTurn(sessId, turnId);
  }, []);

  const clearSuppressedTurnForSession = useCallback((sessId: string) => {
    suppressedTurnBySessionRef.current.delete(sessId);
    clearSuppressedTurn(sessId);
  }, []);

  // When URL agentId/sessionId or agents list changes, sync state
  useEffect(() => {
    if (agents.length === 0) return;

    if (!urlAgentId) {
      navigate(`/agents/${agents[0].id}`, { replace: true });
      return;
    }

    const agentExists = agents.some((a) => a.id === urlAgentId);
    if (!agentExists) {
      navigate(`/agents/${agents[0].id}`, { replace: true });
      return;
    }

    void switchToSession(urlAgentId, urlSessionId || null);
  }, [urlAgentId, urlSessionId, agentIdsKey]);

  const ensureSandboxReady = useCallback(
    async (
      agentId: string,
      initialReason?: string,
      preserveCurrentState = false,
    ) => {
      const runId = ++ensureRunIdRef.current;
      wakeTraceClient("ensure.loop.begin", {
        agentId,
        runId,
        initialReason: initialReason || null,
        preserveCurrentState,
      });
      if (!preserveCurrentState) {
        setSandboxState("waking");
        setSandboxMessage(formatSandboxStatusMessage(initialReason));
      }

      for (let i = 0; i < 60; i++) {
        try {
          const result = await ensureSandbox(agentId, { touchActivity: false });
          if (runId !== ensureRunIdRef.current) {
            return;
          }

          if (result.status === "ready") {
            setSandboxState("ready");
            setSandboxMessage("");
            wakeTraceClient("ensure.loop.ready", {
              agentId,
              runId,
              attempt: i + 1,
            });
            return;
          }

          const retryAfter = result.retryAfterMs || 5000;
          setSandboxState("waking");
          setSandboxMessage(formatSandboxStatusMessage(result.reason));
          await waitMs(retryAfter);
        } catch (error) {
          if (runId !== ensureRunIdRef.current) {
            return;
          }
          wakeTraceClient("ensure.loop.error", {
            agentId,
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
          setSandboxState("error");
          setSandboxMessage(
            error instanceof Error ? error.message : "Failed to start sandbox",
          );
          return;
        }
      }

      if (runId === ensureRunIdRef.current) {
        wakeTraceClient("ensure.loop.timeout", { agentId, runId });
        setSandboxState("error");
        setSandboxMessage("VM is taking too long to start. Please retry.");
      }
    },
    [],
  );

  useEffect(() => {
    const agentId = selectedAgentId;
    if (!agentId) return;

    const fromList = agents.find((a) => a.id === agentId);
    const desiredRunning = fromList?.desired_vm_state === "running";
    const observedStatus = fromList?.vm_status;
    const isStartingLike =
      observedStatus === "starting" ||
      observedStatus === "creating" ||
      observedStatus === "upgrading" ||
      observedStatus === "stopping" ||
      observedStatus === "deleting";
    const isWakePending =
      desiredRunning &&
      observedStatus !== "running" &&
      observedStatus !== "error";

    if (fromList?.vm_status === "running") {
      // DB says VM is running: keep chat usable.
      // We intentionally avoid calling ensure here to prevent unnecessary
      // restart transitions from transient health-probe misses.
      setSandboxState("ready");
      setSandboxMessage("");
    } else if (fromList?.vm_status === "error") {
      setSandboxState("error");
      setSandboxMessage(
        fromList.last_provision_error ||
          fromList.vm_provision_error ||
          "Sandbox provisioning failed.",
      );
    } else if (isStartingLike || isWakePending) {
      const reason = vmStatusToEnsureReason(observedStatus);
      setSandboxState("waking");
      setSandboxMessage(formatSandboxStatusMessage(reason));
    } else {
      setSandboxState("asleep");
      setSandboxMessage("Agent is asleep.");
    }
  }, [selectedAgentId, agents]);

  useEffect(() => {
    return () => {
      ensureRunIdRef.current += 1;
    };
  }, [selectedAgentId]);

  useEffect(() => {
    wakeTraceClient("ui.sandbox_state", {
      agentId: selectedAgentId,
      sandboxState,
      sandboxMessage,
    });
  }, [selectedAgentId, sandboxState, sandboxMessage]);

  useEffect(() => {
    if (!selectedAgentId) return;

    const refresh = () => {
      void loadAgents();
    };

    // Keep vm_status reasonably fresh so the chat status indicator tracks
    // backend state changes. Poll faster while waking so "ready" appears
    // promptly after VM/sandbox come up.
    const refreshIntervalMs = sandboxState === "waking" ? 2_000 : 15_000;
    const interval = setInterval(refresh, refreshIntervalMs);

    const onVisibility = () => {
      if (!document.hidden) {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [selectedAgentId, loadAgents, sandboxState]);

  /** Restore messages from DB into AgentMessage[] */
  const restoreMessages = useCallback(
    (
      dbMessages: Array<{
        role: string;
        content: string;
        tool_calls: any[];
        segments?: any[] | null;
        turn_id?: string | null;
        partial?: boolean;
      }>,
    ): AgentMessage[] =>
      dbMessages.map((m) => {
        const toolCalls =
          Array.isArray(m.tool_calls) && m.tool_calls.length > 0
            ? (m.tool_calls as ToolCallInfo[]).map((tc) => ({
                ...tc,
                result: tc.result ?? "done",
              }))
            : undefined;

        let segments: MessageSegment[] | undefined;
        if (m.role === "assistant") {
          if (Array.isArray(m.segments) && m.segments.length > 0) {
            segments = m.segments.map((seg: any) => {
              if (seg.type === "text") {
                return {
                  type: "text" as const,
                  content: seg.content || "",
                  blockIndex:
                    typeof seg.blockIndex === "number"
                      ? seg.blockIndex
                      : undefined,
                };
              }
              if (seg.type === "thinking") {
                return {
                  type: "thinking" as const,
                  content: seg.content || "",
                  blockIndex:
                    typeof seg.blockIndex === "number"
                      ? seg.blockIndex
                      : undefined,
                };
              }
              return {
                type: "tool" as const,
                name: seg.name || "",
                args: seg.args,
                result: seg.result ?? "done",
                error: seg.error,
              };
            });
          } else {
            segments = [];
            if (toolCalls) {
              for (const tc of toolCalls) {
                segments.push({
                  type: "tool",
                  name: tc.name,
                  args: tc.args,
                  result: tc.result,
                  error: tc.error,
                });
              }
            }
            if (m.content) {
              segments.push({ type: "text", content: m.content });
            }
          }
        }
        return {
          role: m.role as "user" | "assistant",
          content: m.content,
          toolCalls,
          segments,
          turnId: typeof m.turn_id === "string" ? m.turn_id : undefined,
          partial: Boolean(m.partial),
        };
      }),
    [],
  );

  const refreshSessionFromBackend = useCallback(
    async (
      agentId: string,
      sessId: string,
      options?: { skipIfLoading?: boolean; skipMessages?: boolean },
    ) => {
      const key = getStateKey(agentId, sessId);
      const currentState = agentStatesRef.current.get(key);
      if (options?.skipIfLoading && currentState?.isLoading) {
        return;
      }

      try {
        const liveState = getOrCreateState(agentId, sessId);
        const [nextGoal, dbMessages] = await Promise.all([
          getSessionGoal(sessId),
          options?.skipMessages
            ? Promise.resolve(null)
            : getSessionMessages(sessId),
        ]);

        if (dbMessages) {
          const refreshedMessages = restoreMessages(dbMessages.messages);
          if (!areAgentMessagesEqual(liveState.messages, refreshedMessages)) {
            liveState.messages = refreshedMessages;
            if (
              selectedIdRef.current === agentId &&
              selectedSessionRef.current === sessId
            ) {
              setMessages(refreshedMessages);
            }
          }
        }

        liveState.goal = nextGoal;
        if (nextGoal?.status !== "active") {
          liveState.isGoalStreaming = false;
          if (
            selectedIdRef.current === agentId &&
            selectedSessionRef.current === sessId
          ) {
            setIsGoalStreaming(false);
          }
        }
        if (
          selectedIdRef.current === agentId &&
          selectedSessionRef.current === sessId
        ) {
          setGoal(nextGoal);
        }

        if (nextGoal?.status === "active") {
          if (liveState.outputFolder !== nextGoal.output_folder) {
            liveState.outputFolder = nextGoal.output_folder;
            if (
              selectedIdRef.current === agentId &&
              selectedSessionRef.current === sessId
            ) {
              setOutputFolder(nextGoal.output_folder);
            }
          }
        }
      } catch (error) {
        console.error("Failed to refresh session state from backend:", error);
      }
    },
    [getOrCreateState, getStateKey, restoreMessages],
  );

  useEffect(() => {
    const agentId = selectedIdRef.current;
    const sessId = selectedSessionRef.current;
    if (!agentId || !sessId) return;
    if (!goal || goal.status !== "active") return;

    let cancelled = false;

    const refreshActiveGoalSession = async () => {
      const currentAgentId = selectedIdRef.current;
      const currentSessionId = selectedSessionRef.current;
      if (!currentAgentId || !currentSessionId) return;
      await refreshSessionFromBackend(currentAgentId, currentSessionId, {
        skipIfLoading: true,
        skipMessages: true,
      });
      if (cancelled) return;
    };

    void refreshActiveGoalSession();
    const timer = setInterval(() => {
      void refreshActiveGoalSession();
    }, 2500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [goal?.id, goal?.status, refreshSessionFromBackend]);

  const handleLiveGoalStreamEvent = useCallback(
    (agentId: string, sessId: string, event: AgentChatEvent) => {
      if (event.source !== "goal_background") return;

      const state = getOrCreateState(agentId, sessId);
      if (!state.goal || state.goal.status !== "active") return;
      if (state.isLoading) return;
      const eventTurnId =
        typeof event.turnId === "string" && event.turnId.trim().length > 0
          ? event.turnId
          : null;
      if (eventTurnId) {
        state.liveGoalTurnId = eventTurnId;
      }

      const isSelected =
        selectedIdRef.current === agentId &&
        selectedSessionRef.current === sessId;
      state.isGoalStreaming = true;
      if (isSelected) setIsGoalStreaming(true);

      const ensureLiveAssistantIndex = () => {
        if (eventTurnId) {
          for (let i = state.messages.length - 1; i >= 0; i -= 1) {
            const candidate = state.messages[i];
            if (
              candidate?.role === "assistant" &&
              candidate.turnId === eventTurnId
            ) {
              state.liveGoalTurnOpen = true;
              return i;
            }
          }
        }
        const lastIdx = state.messages.length - 1;
        const last = state.messages[lastIdx];
        if (
          state.liveGoalTurnOpen &&
          last?.role === "assistant" &&
          (!state.liveGoalTurnId || last.turnId === state.liveGoalTurnId)
        ) {
          return lastIdx;
        }
        state.messages.push({
          role: "assistant",
          content: "",
          segments: [],
          toolCalls: [],
          turnId: eventTurnId || undefined,
          partial: true,
        });
        state.liveGoalTurnOpen = true;
        state.liveGoalTurnId = eventTurnId;
        return state.messages.length - 1;
      };

      if (event.type === "done") {
        state.liveGoalTurnOpen = false;
        state.liveGoalTurnId = null;
        state.isGoalStreaming = false;
        if (isSelected) setIsGoalStreaming(false);
        void refreshSessionFromBackend(agentId, sessId, {
          skipIfLoading: true,
        });
        return;
      }

      if (event.type === "error") {
        const idx = ensureLiveAssistantIndex();
        const last = state.messages[idx];
        const errorText = `Error: ${String(event.data || "Goal run failed")}`;
        state.messages[idx] = {
          ...last,
          content: (
            (last.content || "") +
            (last.content ? "\n\n" : "") +
            errorText
          ).trim(),
          segments: [
            ...(last.segments || []),
            { type: "text", content: errorText },
          ],
          turnId: eventTurnId || last.turnId,
          partial: true,
        };
        state.isGoalStreaming = false;
        state.liveGoalTurnId = null;
        if (isSelected) setIsGoalStreaming(false);
        if (isSelected) setMessages([...state.messages]);
        return;
      }

      if (event.type === "tool_call") {
        const idx = ensureLiveAssistantIndex();
        const last = state.messages[idx];
        const data = (event.data || {}) as { name?: unknown; args?: unknown };
        const args =
          data.args && typeof data.args === "object"
            ? (data.args as Record<string, unknown>)
            : undefined;
        const toolSeg: MessageSegment = {
          type: "tool",
          name: String(data.name || ""),
          args,
        };
        const toolCall: ToolCallInfo = {
          name: String(data.name || ""),
          args,
        };
        state.messages[idx] = {
          ...last,
          segments: [...(last.segments || []), toolSeg],
          toolCalls: [...(last.toolCalls || []), toolCall],
          turnId: eventTurnId || last.turnId,
          partial: true,
        };
        if (isSelected) setMessages([...state.messages]);
        return;
      }

      if (event.type === "tool_result") {
        const idx = ensureLiveAssistantIndex();
        const last = state.messages[idx];
        const data = (event.data || {}) as {
          name?: unknown;
          result?: unknown;
          error?: unknown;
        };
        state.messages[idx] = {
          ...applyToolResultToMessage(last, data),
          turnId: eventTurnId || last.turnId,
          partial: true,
        };
        if (isSelected) setMessages([...state.messages]);
        return;
      }

      if (event.type === "text") {
        const idx = ensureLiveAssistantIndex();
        const last = state.messages[idx];
        state.messages[idx] = {
          ...applyStreamingTextUpdate(last, event.data),
          turnId: eventTurnId || last.turnId,
          partial: true,
        };
        if (isSelected) setMessages([...state.messages]);
        return;
      }

      if (event.type === "thinking") {
        const idx = ensureLiveAssistantIndex();
        const last = state.messages[idx];
        state.messages[idx] = {
          ...applyStreamingThinkingUpdate(last, event.data),
          turnId: eventTurnId || last.turnId,
          partial: true,
        };
        if (isSelected) setMessages([...state.messages]);
      }
    },
    [getOrCreateState, refreshSessionFromBackend],
  );

  useEffect(() => {
    if (!selectedAgentId || !selectedSessionId) return;

    const state = getOrCreateState(selectedAgentId, selectedSessionId);
    state.liveGoalTurnOpen = false;
    state.liveGoalTurnId = null;
    state.isGoalStreaming = false;
    setIsGoalStreaming(false);

    const unsubscribe = subscribeSessionLiveEvents(
      selectedSessionId,
      (event) => {
        handleLiveGoalStreamEvent(selectedAgentId, selectedSessionId, event);
      },
      () => {
        // Keep background processing alive even when the tab stream reconnects.
      },
    );

    return () => {
      state.liveGoalTurnOpen = false;
      state.liveGoalTurnId = null;
      state.isGoalStreaming = false;
      unsubscribe();
    };
  }, [
    getOrCreateState,
    handleLiveGoalStreamEvent,
    selectedAgentId,
    selectedSessionId,
  ]);

  const loadAgentSkills = useCallback(async (agentId: string) => {
    try {
      const agentData = await getAgent(agentId);
      if (selectedIdRef.current === agentId) {
        setAgentSkills(agentData.skills);
      }
    } catch (error) {
      console.error("Failed to load agent:", error);
    }
  }, []);

  useEffect(() => {
    if (!selectedAgentId) {
      setAgentSkills([]);
      return;
    }
    void loadAgentSkills(selectedAgentId);
  }, [loadAgentSkills, selectedAgentId]);

  const switchToSession = async (agentId: string, sessId: string | null) => {
    const isSameAgent = agentId === selectedIdRef.current;
    const isSameSession = sessId === selectedSessionRef.current;
    if (isSameAgent && isSameSession) {
      if (!sessId) return;
      const existing = agentStatesRef.current.get(getStateKey(agentId, sessId));
      if (existing?.loaded) return;
    }

    const hydrationKey = sessId ? getStateKey(agentId, sessId) : null;
    if (hydrationKey && sessionLoadInFlightRef.current.has(hydrationKey)) {
      return;
    }

    // Save current messages/sessionId.
    // NOTE: input, model, and outputFolder are already kept in sync by their
    // respective change handlers (handleInputChange, handleModelChange,
    // handleOutputFolderChange). Saving them here from the closure would risk
    // overwriting the ref with a stale closure value.
    const prevAgent = selectedIdRef.current;
    const prevSession = selectedSessionRef.current;
    if (prevAgent) {
      const prevKey = getStateKey(prevAgent, prevSession);
      const prev = agentStatesRef.current.get(prevKey);
      if (prev && !prev.isLoading) {
        prev.messages = messages;
        prev.sessionId = sessionId;
        prev.goal = goal;
        prev.isGoalStreaming = isGoalStreaming;
      }
    }

    selectedIdRef.current = agentId;
    selectedSessionRef.current = sessId;
    const keepWorkspace =
      searchParamsRef.current.get("view") === "workspace" ||
      Boolean(searchParamsRef.current.get("wsFile"));
    setViewMode(keepWorkspace ? "workspace" : "chat");
    setIsSessionHydrating(Boolean(sessId));

    // Eagerly restore cached state before any async work so the UI updates
    // immediately while background revalidation runs.
    if (sessId) {
      const key = getStateKey(agentId, sessId);
      const cached = agentStatesRef.current.get(key);
      if (cached?.loaded) {
        setMessages([...cached.messages]);
        setIsLoading(cached.isLoading);
        setIsGoalStreaming(cached.isGoalStreaming);
        setIsSessionHydrating(false);
        setSessionId(cached.sessionId);
        setInput(cached.input);
        setModel(cached.model);
        setOutputFolder(cached.outputFolder);
        setGoal(cached.goal || null);
        return;
      }
    }

    // If no session specified, load sessions and redirect to latest
    if (!sessId) {
      setIsSessionHydrating(false);
      try {
        const agentSessions = await loadSessions(agentId, { force: true });
        if (selectedIdRef.current !== agentId) return;
        const configSuffix =
          searchParamsRef.current.get("config") === "true"
            ? "?config=true"
            : "";
        if (agentSessions.length > 0) {
          navigate(
            `/agents/${agentId}/c/${agentSessions[0].id}${configSuffix}`,
            { replace: true },
          );
          return;
        }
        // No sessions — create one
        const newSess = await createNewSession(agentId);
        if (selectedIdRef.current !== agentId) return;
        navigate(`/agents/${agentId}/c/${newSess.id}${configSuffix}`, {
          replace: true,
        });
      } catch (err) {
        console.error("Failed to load/create session:", err);
      }
      return;
    }

    if (
      selectedIdRef.current !== agentId ||
      selectedSessionRef.current !== sessId
    ) {
      return;
    }

    // We have a specific session that wasn't cached — fresh load
    const state = getOrCreateState(agentId, sessId);
    const cachedSessions = sessions.get(agentId) || [];
    const cachedSession = cachedSessions.find(
      (session) => session.id === sessId,
    );
    const sessionModel: AgentModel =
      cachedSession?.model || DEFAULT_AGENT_MODEL;
    state.loaded = false;
    state.sessionId = sessId;
    state.messages = [];
    state.isLoading = false;
    state.isGoalStreaming = false;
    state.model = sessionModel;
    state.goal = null;
    state.outputFolder = null;
    setMessages([]);
    setIsLoading(false);
    setIsGoalStreaming(false);
    setSessionId(sessId);
    setInput("");
    setModel(sessionModel);
    setOutputFolder(null);
    setGoal(null);

    try {
      if (hydrationKey) {
        sessionLoadInFlightRef.current.add(hydrationKey);
      }
      const dbPayload = await getSessionMessages(sessId);
      if (
        selectedIdRef.current !== agentId ||
        selectedSessionRef.current !== sessId
      )
        return;
      const restored = restoreMessages(dbPayload.messages);
      state.messages = restored;
      setMessages(restored);

      // On hard refresh, in-memory streamed chunks are gone; pin resume to
      // checkpoint-backed seq to avoid skipping uncheckpointed chunks.
      if (dbPayload.runningTurnId) {
        const checkpointRow = dbPayload.messages.find(
          (message) =>
            message.partial &&
            typeof message.turn_id === "string" &&
            message.turn_id === dbPayload.runningTurnId,
        );
        const checkpointSeq =
          typeof checkpointRow?.last_seq === "number" &&
          Number.isFinite(checkpointRow.last_seq)
            ? Math.max(0, Math.floor(checkpointRow.last_seq))
            : 0;
        const existingStored = readStoredResumableTurn(sessId);
        writeStoredResumableTurn(sessId, {
          turnId: dbPayload.runningTurnId,
          lastSeq: checkpointSeq,
          source: existingStored?.source,
        });
      }
    } catch (err) {
      console.error("Failed to load session messages:", err);
    } finally {
      if (hydrationKey) {
        sessionLoadInFlightRef.current.delete(hydrationKey);
      }
      state.loaded = true;
      if (
        selectedIdRef.current === agentId &&
        selectedSessionRef.current === sessId
      ) {
        setIsSessionHydrating(false);
      }
    }

    const backgroundWork: Promise<unknown>[] = [
      getSessionGoal(sessId).then((goalData) => {
        if (
          selectedIdRef.current !== agentId ||
          selectedSessionRef.current !== sessId
        ) {
          return;
        }
        state.goal = goalData;
        setGoal(goalData);
        if (goalData?.status === "active") {
          state.outputFolder = goalData.output_folder;
          setOutputFolder(goalData.output_folder);
        }
      }),
    ];

    if (!cachedSession?.model) {
      const shouldForceSessionRefresh = !cachedSession;
      backgroundWork.push(
        loadSessions(
          agentId,
          shouldForceSessionRefresh ? { force: true } : {},
        ).then((loadedSessions) => {
          if (
            selectedIdRef.current !== agentId ||
            selectedSessionRef.current !== sessId
          ) {
            return;
          }
          const loadedSession = loadedSessions.find(
            (session) => session.id === sessId,
          );
          if (!loadedSession?.model) return;
          // Preserve explicit user changes from this tab.
          if (state.model !== DEFAULT_AGENT_MODEL) return;
          state.model = loadedSession.model;
          setModel(loadedSession.model);
        }),
      );
    }

    void Promise.allSettled(backgroundWork).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Background session fetch failed:", result.reason);
        }
      }
    });
  };

  const handleRemoveSkill = async (skillId: string) => {
    if (!selectedAgentId) return;
    try {
      await uninstallAgentSkill(selectedAgentId, skillId);
      setAgentSkills((prev) =>
        prev.map((s) =>
          s.id === skillId
            ? { ...s, installed: false, enabled: false, install_path: null }
            : s,
        ),
      );
    } catch (err) {
      console.error("Failed to uninstall skill:", err);
    }
  };

  const handleInstallSkills = async (skillIds: string[]) => {
    if (!selectedAgentId || skillIds.length === 0) return;
    try {
      const installResults = await Promise.all(
        skillIds.map((skillId) => installAgentSkill(selectedAgentId, skillId)),
      );
      const installPathBySkillId = new Map<string, string>();
      skillIds.forEach((skillId, index) => {
        installPathBySkillId.set(skillId, installResults[index].installPath);
      });
      setAgentSkills((prev) =>
        prev.map((s) =>
          skillIds.includes(s.id)
            ? {
                ...s,
                installed: true,
                enabled: true,
                install_path:
                  installPathBySkillId.get(s.id) || s.install_path || null,
              }
            : s,
        ),
      );
    } catch (err) {
      console.error("Failed to install skills:", err);
    }
  };

  // Keep input in sync with the per-session ref
  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    const agentId = selectedIdRef.current;
    const sessId = selectedSessionRef.current;
    if (agentId) {
      const key = sessId ? `${agentId}:${sessId}` : agentId;
      const s = agentStatesRef.current.get(key);
      if (s) s.input = value;
    }
  }, []);

  const handleModelChange = useCallback(
    (nextModel: AgentModel) => {
      setModel(nextModel);
      const agentId = selectedIdRef.current;
      const sessId = selectedSessionRef.current;
      if (agentId) {
        const key = sessId ? `${agentId}:${sessId}` : agentId;
        const s = agentStatesRef.current.get(key);
        if (s) s.model = nextModel;
        if (sessId) {
          setSessionModel(agentId, sessId, nextModel);
          void updateChatSession(sessId, { model: nextModel }).catch(
            (error) => {
              console.error("Failed to persist session model:", error);
            },
          );
        }
      }
    },
    [setSessionModel],
  );

  // Keep outputFolder in sync with the per-session ref
  const handleOutputFolderChange = useCallback((folder: string | null) => {
    setOutputFolder(folder);
    const agentId = selectedIdRef.current;
    const sessId = selectedSessionRef.current;
    if (agentId) {
      const key = sessId ? `${agentId}:${sessId}` : agentId;
      const s = agentStatesRef.current.get(key);
      if (s) s.outputFolder = folder;
    }
  }, []);

  const handleGoalChange = useCallback((nextGoal: SessionGoal | null) => {
    setGoal(nextGoal);
    const agentId = selectedIdRef.current;
    const sessId = selectedSessionRef.current;
    if (!agentId) return;
    const key = sessId ? `${agentId}:${sessId}` : agentId;
    const state = agentStatesRef.current.get(key);
    if (state) {
      state.goal = nextGoal;
      if (nextGoal?.status !== "active") {
        state.isGoalStreaming = false;
      }
    }
    if (!nextGoal || nextGoal.status !== "active") {
      setIsGoalStreaming(false);
    }
  }, []);

  const openGoalModal = useCallback(() => {
    const parsedGuidance = parseGoalGuidance(goal?.guidance || "");
    setGoalDraft({
      goal: goal?.goal || "",
      acceptanceCriteria: parsedGuidance.acceptanceCriteria,
      guidance: parsedGuidance.guidance,
      deadlineAt: isoToLocalDatetimeInput(goal?.deadline_at || null),
      outputFolder: goal?.output_folder ?? outputFolder ?? "",
    });
    setShowGoalModal(true);
  }, [goal, outputFolder]);

  const openGoalFolderPicker = useCallback(() => {
    // Avoid nested modal focus traps: close goal dialog while folder picker is open.
    setShowGoalModal(false);
    setShowGoalFolderPicker(true);
  }, []);

  const closeGoalFolderPicker = useCallback(() => {
    setShowGoalFolderPicker(false);
    setShowGoalModal(true);
  }, []);

  const handleSelectGoalFolder = useCallback((folder: string | null) => {
    setGoalDraft((prev) => ({ ...prev, outputFolder: folder ?? "" }));
  }, []);

  const triggerGoalStartTurn = useCallback(
    async (agentId: string, sessId: string, startMessage: string) => {
      const state = getOrCreateState(agentId, sessId);
      if (state.isLoading || state.goal?.status !== "active") {
        return;
      }
      state.input = startMessage;
      if (
        selectedIdRef.current === agentId &&
        selectedSessionRef.current === sessId
      ) {
        setInput(startMessage);
      }
      await handleSendRef.current?.();
    },
    [getOrCreateState],
  );

  const handleStartGoal = useCallback(async () => {
    const sessId = selectedSessionRef.current;
    if (!sessId) return;
    if (sandboxState !== "ready") return;
    const goalText = goalDraft.goal.trim();
    const acceptanceCriteriaText = goalDraft.acceptanceCriteria.trim();
    const guidanceText = goalDraft.guidance.trim();
    const folder = goalDraft.outputFolder.trim().replace(/^\/+|\/+$/g, "");
    if (!goalText || !acceptanceCriteriaText) return;
    const deadlineIso = localDatetimeInputToIso(goalDraft.deadlineAt);
    if (deadlineIso) {
      const deadlineMs = Date.parse(deadlineIso);
      if (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()) {
        return;
      }
    }

    try {
      const saved = await upsertSessionGoal(sessId, {
        goal: goalText,
        guidance: buildStoredGoalGuidance({
          acceptanceCriteria: acceptanceCriteriaText,
          guidance: guidanceText,
        }),
        deadlineAt: deadlineIso,
        outputFolder: folder,
      });
      handleGoalChange(saved);
      handleOutputFolderChange(saved?.output_folder || folder);
      setShowGoalModal(false);
      const agentId = selectedIdRef.current;
      if (agentId) {
        const startMessage = buildGoalStartMessage({
          goal: goalText,
          acceptanceCriteria: acceptanceCriteriaText,
          guidance: guidanceText,
          deadlineIso,
          outputFolder: folder,
        });
        await triggerGoalStartTurn(agentId, sessId, startMessage);
      }
    } catch (error) {
      console.error("Failed to start goal:", error);
    }
  }, [
    goalDraft,
    handleGoalChange,
    handleOutputFolderChange,
    sandboxState,
    triggerGoalStartTurn,
  ]);

  const finalizePendingTools = useCallback(
    (agentId: string, sessionId: string | null, reason: string) => {
      let state: PerAgentState | undefined;
      if (sessionId) {
        state = agentStatesRef.current.get(getStateKey(agentId, sessionId));
      }
      if (!state) {
        const selectedSession =
          selectedIdRef.current === agentId ? selectedSessionRef.current : null;
        if (selectedSession) {
          state = agentStatesRef.current.get(
            getStateKey(agentId, selectedSession),
          );
        }
      }
      if (!state || state.messages.length === 0) return;

      const nextMessages = [...state.messages];
      let changed = false;

      for (let i = nextMessages.length - 1; i >= 0; i--) {
        const msg = nextMessages[i];
        if (msg.role !== "assistant") continue;

        let segChanged = false;
        const segments = (msg.segments || []).map((seg) => {
          if (seg.type === "tool" && seg.result === undefined && !seg.error) {
            segChanged = true;
            changed = true;
            return { ...seg, error: true, result: reason };
          }
          return seg;
        });

        let tcChanged = false;
        const toolCalls = (msg.toolCalls || []).map((tc) => {
          if (tc.result === undefined && !tc.error) {
            tcChanged = true;
            changed = true;
            return { ...tc, error: true, result: reason };
          }
          return tc;
        });

        if (segChanged || tcChanged) {
          nextMessages[i] = {
            ...msg,
            segments,
            toolCalls,
          };
        }
      }

      if (!changed) return;
      state.messages = nextMessages;
      if (
        selectedIdRef.current === agentId &&
        (sessionId == null || selectedSessionRef.current === sessionId)
      ) {
        setMessages([...nextMessages]);
      }
    },
    [getStateKey],
  );

  // On unmount: nullify the selection refs so any in-flight switchToSession
  // calls bail out at their `selectedIdRef.current !== agentId` guards instead
  // of calling navigate() after the component has unmounted (which would snap
  // the URL back to /agents/... when the user navigates to /skills).
  useEffect(() => {
    return () => {
      selectedIdRef.current = null;
      selectedSessionRef.current = null;
    };
  }, []);

  const handleSend = useCallback(async () => {
    const agentId = selectedIdRef.current;
    const sessId = selectedSessionRef.current;
    if (!agentId || !sessId) return;
    const agentState = getOrCreateState(agentId, sessId);
    const msg = agentState.input.trim();
    if (!msg || agentState.isLoading) return;

    // Authoritative readiness preflight before sending prevents stale "ready"
    // UI state from dispatching chat while the VM is suspending/starting.
    let preflight: Awaited<ReturnType<typeof ensureSandbox>>;
    try {
      wakeTraceClient("chat.preflight.begin", { agentId });
      preflight = await ensureSandbox(agentId, { touchActivity: true });
      wakeTraceClient("chat.preflight.result", {
        agentId,
        status: preflight.status,
        reason:
          preflight.status === "starting" ? preflight.reason || null : null,
        retryAfterMs:
          preflight.status === "starting"
            ? preflight.retryAfterMs || null
            : null,
      });
    } catch {
      wakeTraceClient("chat.preflight.error", { agentId });
      setSandboxState("error");
      setSandboxMessage("Failed to ensure sandbox");
      const text = "Sandbox is unavailable.";
      agentState.messages = [
        ...agentState.messages,
        {
          role: "assistant",
          content: text,
          segments: [{ type: "text", content: text }],
        },
      ];
      if (selectedIdRef.current === agentId) {
        setMessages([...agentState.messages]);
      }
      return;
    }

    if (preflight.status !== "ready") {
      const reason = preflight.reason || "vm_starting";
      setSandboxState("waking");
      setSandboxMessage(formatSandboxStatusMessage(reason));
      void ensureSandboxReady(agentId, reason, true);
      const text = "Sandbox is still starting. Please retry in a few seconds.";
      agentState.messages = [
        ...agentState.messages,
        {
          role: "assistant",
          content: text,
          segments: [{ type: "text", content: text }],
        },
      ];
      if (selectedIdRef.current === agentId) {
        setMessages([...agentState.messages]);
      }
      return;
    }

    setSandboxState("ready");
    setSandboxMessage("");

    const abortController = new AbortController();
    agentState.input = "";
    agentState.isLoading = true;
    agentState.isGoalStreaming = false;
    agentState.abortController = abortController;
    agentState.messages = [
      ...agentState.messages,
      { role: "user", content: msg },
    ];
    const assistantTurnStart = agentState.messages.length;
    const producedFilesInTurn = new Set<string>();
    let activeTurnId: string | null = null;

    const isSelected = () =>
      selectedIdRef.current === agentId &&
      selectedSessionRef.current === sessId;

    // Sync initial state to React
    setInput("");
    setIsLoading(true);
    setIsGoalStreaming(false);
    setMessages([...agentState.messages]);
    markBusy(agentId);
    touchSession(agentId, sessId);
    touchAgent(agentId);

    try {
      let doneReceived = false;
      let sawErrorEvent = false;
      const busyFromSeq = (() => {
        const stored = readStoredResumableTurn(sessId);
        if (!stored) return 1;
        return Math.max(1, Math.floor(stored.lastSeq) + 1);
      })();

      for await (const event of streamAgentChat(
        agentId,
        msg,
        sessId,
        abortController.signal,
        agentState.outputFolder,
        agentState.model,
        busyFromSeq,
      )) {
        if (event.type === "turn") {
          const turnId =
            typeof event.turnId === "string" && event.turnId.trim().length > 0
              ? event.turnId
              : typeof event.data?.turnId === "string"
                ? String(event.data.turnId)
                : null;
          const eventSessionId =
            (typeof event.sessionId === "string" && event.sessionId) ||
            (typeof event.data?.sessionId === "string"
              ? String(event.data.sessionId)
              : null) ||
            sessId;
          if (turnId && eventSessionId) {
            activeTurnId = turnId;
            clearSuppressedTurnForSession(eventSessionId);
            writeStoredResumableTurn(eventSessionId, {
              turnId,
              lastSeq: 0,
              source: "foreground",
            });
          }
          continue;
        }
        if (
          typeof event.seq === "number" &&
          Number.isFinite(event.seq) &&
          activeTurnId
        ) {
          writeStoredResumableTurn(sessId, {
            turnId: activeTurnId,
            lastSeq: Math.max(0, Math.floor(event.seq)),
            source: "foreground",
          });
        }
        if (event.type === "done") {
          doneReceived = true;
          clearStoredResumableTurn(sessId);
        }
        if (event.type === "session" && event.sessionId) {
          agentState.sessionId = event.sessionId;
          if (isSelected()) setSessionId(event.sessionId);
        }
        if (event.type === "session_update" && event.data?.title && agentId) {
          setSessionTitle(agentId, sessId, event.data.title);
        }
        if (event.type === "vm_starting") {
          const reason =
            typeof event.data?.reason === "string"
              ? event.data.reason
              : "vm_starting";
          setSandboxState("waking");
          setSandboxMessage(formatSandboxStatusMessage(reason));
          void ensureSandboxReady(agentId, reason);
          continue;
        }
        if (event.type === "tool_call") {
          const toolSeg: MessageSegment = {
            type: "tool",
            name: event.data.name,
            args: event.data.args,
          };
          const tc: ToolCallInfo = {
            name: event.data.name,
            args: event.data.args,
          };
          const last = agentState.messages[agentState.messages.length - 1];
          if (last?.role === "assistant") {
            agentState.messages[agentState.messages.length - 1] = {
              ...last,
              segments: [...(last.segments || []), toolSeg],
              toolCalls: [...(last.toolCalls || []), tc],
            };
          } else {
            agentState.messages.push({
              role: "assistant",
              content: "",
              segments: [toolSeg],
              toolCalls: [tc],
            });
          }
          if (isSelected()) setMessages([...agentState.messages]);
        }
        if (event.type === "tool_result") {
          for (const p of extractProducedPathsFromToolResult(
            String(event.data?.name || ""),
            event.data?.args as Record<string, unknown> | undefined,
            event.data?.result,
            Boolean(event.data?.error),
          )) {
            producedFilesInTurn.add(p);
          }

          const last = agentState.messages[agentState.messages.length - 1];
          if (last?.role === "assistant") {
            agentState.messages[agentState.messages.length - 1] =
              applyToolResultToMessage(last, event.data || {});
          }
          if (isSelected()) setMessages([...agentState.messages]);
        }
        if (event.type === "text") {
          const last = agentState.messages[agentState.messages.length - 1];
          if (last?.role === "assistant") {
            agentState.messages[agentState.messages.length - 1] =
              applyStreamingTextUpdate(last, event.data);
          } else {
            const nextAssistant = applyStreamingTextUpdate(
              {
                role: "assistant",
                content: "",
                segments: [],
              },
              event.data,
            );
            agentState.messages.push({
              ...nextAssistant,
              role: "assistant",
            });
          }
          if (isSelected()) setMessages([...agentState.messages]);
        }
        if (event.type === "thinking") {
          const last = agentState.messages[agentState.messages.length - 1];
          if (last?.role === "assistant") {
            agentState.messages[agentState.messages.length - 1] = {
              ...applyStreamingThinkingUpdate(last, event.data),
            };
          } else {
            const nextAssistant = applyStreamingThinkingUpdate(
              {
                role: "assistant",
                content: "",
                segments: [],
              },
              event.data,
            );
            agentState.messages.push({
              ...nextAssistant,
              role: "assistant",
            });
          }
          if (isSelected()) setMessages([...agentState.messages]);
        }
        if (event.type === "error") {
          sawErrorEvent = true;
          clearStoredResumableTurn(sessId);
          finalizePendingTools(
            agentId,
            sessId,
            String(event.data || "Agent error"),
          );
          agentState.messages.push({
            role: "assistant",
            content: `Error: ${event.data}`,
            segments: [{ type: "text", content: `Error: ${event.data}` }],
          });
          if (isSelected()) setMessages([...agentState.messages]);
        }
      }

      if (!doneReceived && !sawErrorEvent) {
        finalizePendingTools(
          agentId,
          sessId,
          "Connection closed before tool completed",
        );
      }

      const assistantMessagesThisTurn = agentState.messages
        .slice(assistantTurnStart)
        .filter((m) => m.role === "assistant");

      const hasAssistantText = assistantMessagesThisTurn.some((m) => {
        if ((m.content || "").trim()) return true;
        return (m.segments || []).some(
          (seg) => seg.type === "text" && seg.content.trim().length > 0,
        );
      });

      const hadToolActivity = assistantMessagesThisTurn.some(
        (m) =>
          (m.toolCalls && m.toolCalls.length > 0) ||
          (m.segments || []).some((seg) => seg.type === "tool"),
      );

      if (!hasAssistantText && hadToolActivity) {
        const existingProducedPaths = await filterExistingWorkspacePaths(
          agentId,
          Array.from(producedFilesInTurn),
        );
        const linkableFiles = pickLinkableProducedFiles(
          existingProducedPaths,
          agentState.outputFolder,
        );
        if (linkableFiles.length > 0) {
          const fallback = buildProducedFilesMessage(linkableFiles);
          agentState.messages.push({
            role: "assistant",
            content: fallback,
            segments: [{ type: "text", content: fallback }],
          });
          if (isSelected()) setMessages([...agentState.messages]);
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      finalizePendingTools(agentId, sessId, "Failed to get response");
      agentState.messages.push({
        role: "assistant",
        content: "Failed to get response.",
        segments: [{ type: "text", content: "Failed to get response." }],
      });
      if (isSelected()) setMessages([...agentState.messages]);
    } finally {
      agentState.isLoading = false;
      agentState.abortController = null;
      if (isSelected()) setIsLoading(false);
      clearBusy(agentId);
      if (agentState.goal) {
        void refreshSessionFromBackend(agentId, sessId);
      }
    }
  }, [
    clearBusy,
    finalizePendingTools,
    getOrCreateState,
    markBusy,
    ensureSandboxReady,
    touchSession,
    setSessionTitle,
    refreshSessionFromBackend,
    clearSuppressedTurnForSession,
  ]);

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  const resumeStoredTurnStream = useCallback(
    async (
      agentId: string,
      sessId: string,
      stored: StoredResumableTurn,
      startFromSeq?: number,
    ) => {
      const state = getOrCreateState(agentId, sessId);
      if (state.isLoading) return;
      if (state.activeResumeTurnId === stored.turnId) return;
      if (
        state.activeResumeTurnId &&
        state.activeResumeTurnId !== stored.turnId
      )
        return;
      const isBackgroundTurn = stored.source === "goal_background";
      state.activeResumeTurnId = stored.turnId;
      if (isBackgroundTurn) {
        state.isGoalStreaming = true;
      }

      const abortController = new AbortController();
      if (!isBackgroundTurn) {
        state.isLoading = true;
        state.abortController = abortController;
      }
      const isSelected = () =>
        selectedIdRef.current === agentId &&
        selectedSessionRef.current === sessId;

      if (!isBackgroundTurn && isSelected()) setIsLoading(true);
      if (isBackgroundTurn && isSelected()) setIsGoalStreaming(true);
      if (!isBackgroundTurn) markBusy(agentId);

      try {
        let fromSeq = Math.max(1, startFromSeq ?? stored.lastSeq + 1);
        let shouldExit = false;
        let turnAssistantIndex = -1;

        const ensureTurnAssistantIndex = () => {
          if (turnAssistantIndex >= 0) {
            const existing = state.messages[turnAssistantIndex];
            if (
              existing?.role === "assistant" &&
              existing.turnId === stored.turnId
            ) {
              return turnAssistantIndex;
            }
          }

          const lastIdx = state.messages.length - 1;
          const last = state.messages[lastIdx];
          if (last?.role === "assistant" && last.turnId === stored.turnId) {
            turnAssistantIndex = lastIdx;
            return turnAssistantIndex;
          }

          state.messages.push({
            role: "assistant",
            content: "",
            segments: [],
            toolCalls: [],
            turnId: stored.turnId,
            partial: true,
          });
          turnAssistantIndex = state.messages.length - 1;
          return turnAssistantIndex;
        };

        while (!abortController.signal.aborted && !shouldExit) {
          let doneReceived = false;
          let sawErrorEvent = false;

          for await (const event of streamAgentTurn(
            sessId,
            stored.turnId,
            fromSeq,
            abortController.signal,
          )) {
            if (typeof event.seq === "number" && Number.isFinite(event.seq)) {
              const seq = Math.max(0, Math.floor(event.seq));
              writeStoredResumableTurn(sessId, {
                turnId: stored.turnId,
                lastSeq: seq,
                source: stored.source,
              });
              fromSeq = Math.max(fromSeq, seq + 1);
            }

            if (event.type === "done") {
              doneReceived = true;
              clearStoredResumableTurn(sessId);
            }

            if (event.type === "session_update" && event.data?.title) {
              setSessionTitle(agentId, sessId, event.data.title);
            }

            if (event.type === "vm_starting") {
              const reason =
                typeof event.data?.reason === "string"
                  ? event.data.reason
                  : "vm_starting";
              setSandboxState("waking");
              setSandboxMessage(formatSandboxStatusMessage(reason));
              void ensureSandboxReady(agentId, reason);
              continue;
            }

            if (event.type === "tool_call") {
              const idx = ensureTurnAssistantIndex();
              const toolSeg: MessageSegment = {
                type: "tool",
                name: event.data.name,
                args: event.data.args,
              };
              const tc: ToolCallInfo = {
                name: event.data.name,
                args: event.data.args,
              };
              const last = state.messages[idx];
              state.messages[idx] = {
                ...last,
                segments: [...(last.segments || []), toolSeg],
                toolCalls: [...(last.toolCalls || []), tc],
                turnId: stored.turnId,
                partial: true,
              };
              if (isSelected()) setMessages([...state.messages]);
            }

            if (event.type === "tool_result") {
              const idx = ensureTurnAssistantIndex();
              const last = state.messages[idx];
              state.messages[idx] = {
                ...applyToolResultToMessage(last, event.data || {}),
                turnId: stored.turnId,
                partial: true,
              };
              if (isSelected()) setMessages([...state.messages]);
            }

            if (event.type === "text") {
              const idx = ensureTurnAssistantIndex();
              const last = state.messages[idx];
              if (last?.role === "assistant") {
                state.messages[idx] = {
                  ...applyStreamingTextUpdate(last, event.data),
                  turnId: stored.turnId,
                  partial: true,
                };
              }
              if (isSelected()) setMessages([...state.messages]);
            }

            if (event.type === "thinking") {
              const idx = ensureTurnAssistantIndex();
              const last = state.messages[idx];
              if (last?.role === "assistant") {
                state.messages[idx] = {
                  ...applyStreamingThinkingUpdate(last, event.data),
                  turnId: stored.turnId,
                  partial: true,
                };
              }
              if (isSelected()) setMessages([...state.messages]);
            }

            if (event.type === "error") {
              clearStoredResumableTurn(sessId);
              const errText = String(event.data || "Agent error");
              if (errText.toLowerCase().includes("no longer available")) {
                void refreshSessionFromBackend(agentId, sessId);
                sawErrorEvent = true;
                continue;
              }
              sawErrorEvent = true;
              finalizePendingTools(agentId, sessId, errText);
              const idx = ensureTurnAssistantIndex();
              const last = state.messages[idx];
              const errorText = `Error: ${event.data}`;
              state.messages[idx] = {
                ...last,
                content: (
                  (last.content || "") +
                  (last.content ? "\n\n" : "") +
                  errorText
                ).trim(),
                segments: [
                  ...(last.segments || []),
                  { type: "text", content: errorText },
                ],
                turnId: stored.turnId,
                partial: true,
              };
              if (isSelected()) setMessages([...state.messages]);
            }
          }

          if (doneReceived || sawErrorEvent) {
            if (isBackgroundTurn) {
              void refreshSessionFromBackend(agentId, sessId, {
                skipIfLoading: true,
              });
            }
            shouldExit = true;
            break;
          }

          const running = await getSessionRunningTurn(sessId);
          if (!running.turnId || running.turnId !== stored.turnId) {
            clearStoredResumableTurn(sessId);
            shouldExit = true;
            break;
          }

          const latest = readStoredResumableTurn(sessId);
          const candidateFromSeq = Math.max(
            1,
            (latest?.lastSeq ?? Math.max(0, fromSeq - 1)) + 1,
          );
          fromSeq = Math.max(fromSeq, candidateFromSeq);
          await waitMs(300);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          if (!isBackgroundTurn) {
            finalizePendingTools(agentId, sessId, "Failed to resume stream");
          }
          if (isSelected()) {
            setMessages([...state.messages]);
          }
        }
      } finally {
        if (state.activeResumeTurnId === stored.turnId) {
          state.activeResumeTurnId = null;
        }
        if (isBackgroundTurn) {
          state.isGoalStreaming = false;
          if (isSelected()) setIsGoalStreaming(false);
        }
        if (!isBackgroundTurn) {
          state.isLoading = false;
          state.abortController = null;
          if (isSelected()) setIsLoading(false);
          clearBusy(agentId);
        }
      }
    },
    [
      clearBusy,
      ensureSandboxReady,
      finalizePendingTools,
      getOrCreateState,
      markBusy,
      refreshSessionFromBackend,
      setSessionTitle,
    ],
  );

  useEffect(() => {
    if (!selectedAgentId || !selectedSessionId) return;
    // Keep selection refs in sync on hard refresh before async switch logic catches up.
    selectedIdRef.current = selectedAgentId;
    selectedSessionRef.current = selectedSessionId;

    const state = getOrCreateState(selectedAgentId, selectedSessionId);
    if (!state.loaded) return;
    if (state.isLoading || isLoading) return;

    const stored = readStoredResumableTurn(selectedSessionId);
    if (stored) {
      const suppressed = getSuppressedTurn(selectedSessionId);
      if (suppressed && suppressed === stored.turnId) {
        return;
      }
      const shouldReplayFromStart =
        state.messages.length === 0 ||
        state.messages[state.messages.length - 1]?.role !== "assistant";
      void resumeStoredTurnStream(
        selectedAgentId,
        selectedSessionId,
        stored,
        shouldReplayFromStart ? 1 : undefined,
      );
      return;
    }

    if (runningTurnProbeRef.current.has(selectedSessionId)) {
      return;
    }
    runningTurnProbeRef.current.add(selectedSessionId);
    let cancelled = false;
    void (async () => {
      try {
        const running = await getSessionRunningTurn(selectedSessionId);
        if (
          cancelled ||
          !running.turnId ||
          selectedIdRef.current !== selectedAgentId ||
          selectedSessionRef.current !== selectedSessionId
        ) {
          if (!running.turnId) {
            clearSuppressedTurnForSession(selectedSessionId);
          }
          return;
        }

        const suppressed = getSuppressedTurn(selectedSessionId);
        if (suppressed && suppressed === running.turnId) {
          return;
        }
        if (suppressed && suppressed !== running.turnId) {
          clearSuppressedTurnForSession(selectedSessionId);
        }
        const recovered: StoredResumableTurn = {
          turnId: running.turnId,
          lastSeq: 0,
          source:
            running.source === "goal_background"
              ? "goal_background"
              : "foreground",
        };
        writeStoredResumableTurn(selectedSessionId, recovered);
        void resumeStoredTurnStream(
          selectedAgentId,
          selectedSessionId,
          recovered,
          1,
        );
      } catch {
        // Ignore probe failures; normal polling/refresh paths still apply.
      } finally {
        runningTurnProbeRef.current.delete(selectedSessionId);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    getOrCreateState,
    isLoading,
    resumeStoredTurnStream,
    selectedAgentId,
    selectedSessionId,
    getSuppressedTurn,
    clearSuppressedTurnForSession,
  ]);

  useEffect(() => {
    if (!selectedAgentId || !selectedSessionId) return;
    // Keep selection refs in sync on hard refresh before async switch logic catches up.
    selectedIdRef.current = selectedAgentId;
    selectedSessionRef.current = selectedSessionId;

    let cancelled = false;
    const agentId = selectedAgentId;
    const sessId = selectedSessionId;

    const tick = async () => {
      if (cancelled) return;
      const state = getOrCreateState(agentId, sessId);
      if (!state.loaded) return;
      if (state.isLoading || isLoading) return;
      if (runningTurnProbeRef.current.has(sessId)) return;

      try {
        const running = await getSessionRunningTurn(sessId);
        if (
          cancelled ||
          !running.turnId ||
          selectedIdRef.current !== agentId ||
          selectedSessionRef.current !== sessId
        ) {
          if (!running.turnId) {
            clearSuppressedTurnForSession(sessId);
          }
          return;
        }

        const suppressed = getSuppressedTurn(sessId);
        if (suppressed && suppressed === running.turnId) {
          return;
        }
        if (suppressed && suppressed !== running.turnId) {
          clearSuppressedTurnForSession(sessId);
        }

        const stored = readStoredResumableTurn(sessId);
        const recovered =
          stored && stored.turnId === running.turnId
            ? stored
            : ({
                turnId: running.turnId,
                lastSeq: 0,
                source:
                  running.source === "goal_background"
                    ? "goal_background"
                    : "foreground",
              } satisfies StoredResumableTurn);
        writeStoredResumableTurn(sessId, recovered);

        const shouldReplayFromStart =
          state.messages.length === 0 ||
          state.messages[state.messages.length - 1]?.role !== "assistant";
        void resumeStoredTurnStream(
          agentId,
          sessId,
          recovered,
          shouldReplayFromStart ? 1 : undefined,
        );
      } catch {
        // best-effort watchdog; ignore transient probe failures
      }
    };

    const interval = window.setInterval(() => {
      void tick();
    }, 2000);
    void tick();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    getOrCreateState,
    isLoading,
    resumeStoredTurnStream,
    selectedAgentId,
    selectedSessionId,
    getSuppressedTurn,
    clearSuppressedTurnForSession,
  ]);

  const handleStop = useCallback(() => {
    const agentId = selectedIdRef.current;
    const sessId = selectedSessionRef.current;
    if (!agentId) return;
    let turnIdToCancel: string | null = null;

    if (sessId) {
      const stored = readStoredResumableTurn(sessId);
      if (stored?.turnId) {
        turnIdToCancel = stored.turnId;
        setSuppressedTurn(sessId, stored.turnId);
      }
      clearStoredResumableTurn(sessId);
    }

    finalizePendingTools(agentId, sessId, "Stopped by user");
    const key = sessId ? `${agentId}:${sessId}` : agentId;
    const state = agentStatesRef.current.get(key);
    if (state) {
      state.abortController?.abort();
      state.abortController = null;
      state.isLoading = false;
      state.isGoalStreaming = false;
      state.activeResumeTurnId = null;
    }
    setIsLoading(false);
    setIsGoalStreaming(false);
    clearBusy(agentId);

    if (!sessId) return;
    void (async () => {
      try {
        let targetTurnId = turnIdToCancel;
        if (!targetTurnId) {
          const running = await getSessionRunningTurn(sessId);
          targetTurnId = running.turnId;
          if (targetTurnId) {
            setSuppressedTurn(sessId, targetTurnId);
          }
        }
        if (!targetTurnId) return;
        await cancelSessionTurn(sessId, targetTurnId);
      } catch {
        // Best effort. Suppression still prevents immediate UI reattachment.
      }
    })();
  }, [clearBusy, finalizePendingTools, setSuppressedTurn]);

  const handleStopGoalExecution = useCallback(async () => {
    const sessId = selectedSessionRef.current;
    if (!sessId) return;
    handleStop();
    try {
      await cancelSessionGoal(sessId);
      handleGoalChange(null);
    } catch (error) {
      console.error("Failed to stop goal execution:", error);
    }
  }, [handleGoalChange, handleStop]);

  const handleFileClick = useCallback(
    async (filePath: string) => {
      const agentId = selectedIdRef.current;
      const decodedPath = canonicalizeWorkspacePath(filePath);
      if (!decodedPath) {
        return;
      }
      const resolveSeq = ++filePreviewResolveSeqRef.current;

      // Open preview immediately; resolve ambiguous paths in the background.
      updateSearchParams((next) => {
        next.set("file", decodedPath);
      });

      if (!agentId) {
        return;
      }

      try {
        const data = await listWorkspaceFiles(agentId, {
          recursive: true,
          includeStats: false,
        });
        const allPaths = flattenWorkspaceFilePaths(data.files);
        const pathSet = new Set(allPaths);

        const candidates: string[] = [decodedPath];
        if (outputFolder) {
          const cleanOutput = outputFolder.replace(/^\/+|\/+$/g, "");
          if (cleanOutput && !decodedPath.startsWith(`${cleanOutput}/`)) {
            candidates.push(`${cleanOutput}/${decodedPath}`);
          }
        }

        const basename = decodedPath.split("/").pop() || "";
        if (basename) {
          const basenameMatches = allPaths.filter(
            (p) => (p.split("/").pop() || "") === basename,
          );
          if (basenameMatches.length === 1) {
            candidates.push(basenameMatches[0]);
          }
        }

        // If model guessed a wrong filename, recover by finding a unique file
        // with the same extension in the same directory.
        const requestedDir = getParentDir(decodedPath);
        const requestedExt = getExtension(decodedPath);
        if (requestedExt) {
          const sameDirExtMatches = allPaths.filter(
            (p) =>
              getParentDir(p) === requestedDir &&
              getExtension(p) === requestedExt,
          );
          if (sameDirExtMatches.length === 1) {
            candidates.push(sameDirExtMatches[0]);
          }
        }

        const resolvedPath = candidates.find((candidate) =>
          pathSet.has(candidate),
        );
        if (!resolvedPath) {
          console.warn("File link target not found in workspace:", decodedPath);
          return;
        }
        if (resolveSeq !== filePreviewResolveSeqRef.current) {
          return;
        }
        if (resolvedPath === decodedPath) {
          return;
        }
        updateSearchParams((next) => {
          next.set("file", resolvedPath);
        });
      } catch {
        // Keep optimistic path when resolver fails.
      }
    },
    [outputFolder, updateSearchParams],
  );

  const closePreview = useCallback(() => {
    updateSearchParams((next) => {
      next.delete("file");
    });
  }, [updateSearchParams]);

  const openInWorkspace = useCallback(() => {
    setViewMode("workspace");
    updateSearchParams((next) => {
      if (previewFile) {
        next.set("wsFile", previewFile);
      }
      next.set("view", "workspace");
      next.delete("file");
    });
  }, [previewFile, updateSearchParams]);

  const handleWorkspaceSelectedFilePathChange = useCallback(
    (filePath: string | null) => {
      if ((workspaceFile ?? null) === (filePath ?? null)) {
        return;
      }
      updateSearchParams((next) => {
        if (filePath) {
          next.set("wsFile", filePath);
          next.set("view", "workspace");
        } else {
          next.delete("wsFile");
        }
      });
    },
    [updateSearchParams, workspaceFile],
  );

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  useEffect(() => {
    if (!selectedAgent) return;
    const fallback = parseGpuFallbackProvisionError(
      selectedAgent.last_provision_error || selectedAgent.vm_provision_error,
    );
    if (!fallback) return;
    const marker =
      selectedAgent.last_provision_error_at ||
      selectedAgent.last_provision_error ||
      selectedAgent.vm_provision_error ||
      "";
    const noticeKey = `${selectedAgent.id}:${marker}`;
    if (seenGpuFallbackNoticeRef.current.has(noticeKey)) return;
    seenGpuFallbackNoticeRef.current.add(noticeKey);
    setGpuFallbackInfo(fallback);
    setShowGpuFallbackDialog(true);
  }, [
    selectedAgent?.id,
    selectedAgent?.last_provision_error,
    selectedAgent?.last_provision_error_at,
    selectedAgent?.vm_provision_error,
  ]);
  const machineProfileOptions = useMemo(() => {
    const currentType = selectedAgent?.machine_type || "";
    if (!currentType) return MACHINE_PROFILE_OPTIONS;
    if (
      MACHINE_PROFILE_OPTIONS.some(
        (option) => option.machineType === currentType,
      )
    ) {
      return MACHINE_PROFILE_OPTIONS;
    }
    return [
      ...MACHINE_PROFILE_OPTIONS,
      {
        id: currentType,
        machineType: currentType,
        label: `Custom (${currentType})`,
      },
    ] as const;
  }, [selectedAgent?.machine_type]);
  const isAgentOwner = selectedAgent?.access_role === "owner";
  const isAgentLive = sandboxState === "ready";
  const currentMachineProfileId: MachineProfileId = (() => {
    if (!selectedAgent?.machine_type) return DEFAULT_MACHINE_TYPE;
    const matched = machineProfileOptions.find(
      (option) => option.machineType === selectedAgent.machine_type,
    );
    return matched?.id || DEFAULT_MACHINE_TYPE;
  })();
  const pendingMachineProfile = pendingMachineProfileId
    ? machineProfileOptions.find(
        (option) => option.id === pendingMachineProfileId,
      ) || null
    : null;
  const currentMachineProfileLabel =
    machineProfileOptions.find(
      (option) => option.id === currentMachineProfileId,
    )?.label || "CPU (e2-medium)";

  const handleMachineProfileSelect = useCallback(
    (nextValue: string) => {
      if (!isAgentOwner || !isAgentLive) {
        return;
      }
      const nextProfile = nextValue as MachineProfileId;
      if (nextProfile === currentMachineProfileId) {
        return;
      }
      setPendingMachineProfileId(nextProfile);
      setShowMachineTransitionDialog(true);
    },
    [currentMachineProfileId, isAgentOwner, isAgentLive],
  );

  const handleConfirmMachineTransition = useCallback(
    async (confirmUpgradeRisk = false) => {
      if (!selectedAgent || !pendingMachineProfile) return;

      let keepPendingSelection = false;
      if (selectedAgent.upgrade_risk_detected && !confirmUpgradeRisk) {
        setShowMachineTransitionDialog(false);
        setUpgradeRiskMessage(selectedAgent.upgrade_risk_message || null);
        setShowUpgradeRiskDialog(true);
        return;
      }

      setMachineTransitionLoading(true);
      setShowMachineTransitionDialog(false);
      setShowUpgradeRiskDialog(false);

      try {
        setSandboxState("waking");
        setSandboxMessage(`Switching to ${pendingMachineProfile.label}...`);
        await updateAgent(selectedAgent.id, {
          machine_type: pendingMachineProfile.machineType,
          confirm_upgrade_risk: confirmUpgradeRisk || undefined,
        });
        await loadAgents();
      } catch (error) {
        const errorWithCode = error as Error & {
          code?: string;
          upgradeRiskMessage?: string;
        };
        if (
          errorWithCode.code === "upgrade_risk_confirmation_required" &&
          !confirmUpgradeRisk
        ) {
          keepPendingSelection = true;
          setUpgradeRiskMessage(
            errorWithCode.upgradeRiskMessage ||
              selectedAgent.upgrade_risk_message ||
              null,
          );
          setShowUpgradeRiskDialog(true);
          return;
        }
        console.error("Failed to transition machine type:", error);
        setSandboxState("error");
        setSandboxMessage(
          error instanceof Error
            ? error.message
            : "Failed to switch machine profile",
        );
      } finally {
        setMachineTransitionLoading(false);
        if (!keepPendingSelection) {
          setPendingMachineProfileId(null);
        }
      }
    },
    [selectedAgent, pendingMachineProfile, updateAgent, loadAgents],
  );

  const firstName = user.name.split(/\s+/)[0] || "there";
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();

  return (
    <div
      data-testid="agents-page"
      className="flex h-full min-w-0 flex-1 flex-col bg-page animate-fade-in"
    >
      {/* Main content area */}
      {selectedAgent ? (
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Minimal header */}
          <div className="relative px-3 py-2 sm:px-4 md:px-5 md:py-3">
            <div className="flex min-w-0 items-center gap-2">
              {isAgentOwner ? (
                <Select
                  value={currentMachineProfileId}
                  onValueChange={handleMachineProfileSelect}
                  disabled={machineTransitionLoading || !isAgentLive}
                >
                  <SelectTrigger className="h-8 w-full max-w-[280px] min-w-0 rounded-lg border-stroke bg-white px-2.5 text-[13px] font-semibold text-ink md:w-auto md:min-w-[220px]">
                    <SelectValue placeholder="Select machine type" />
                  </SelectTrigger>
                  <SelectContent>
                    {machineProfileOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="inline-flex h-8 w-full max-w-[280px] min-w-0 items-center rounded-lg border border-stroke bg-white px-2.5 text-[13px] font-semibold text-ink md:w-auto">
                  {currentMachineProfileLabel}
                </span>
              )}
              {/* Status dot — green=ready, amber=starting (pulse), red=error */}
              <span
                title={
                  sandboxState !== "ready" ? sandboxMessage : "Sandbox ready"
                }
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  sandboxState === "ready" && "bg-green-500",
                  sandboxState === "waking" && "bg-amber-400",
                  sandboxState === "asleep" && "bg-slate-400",
                  sandboxState === "error" && "bg-red-500",
                )}
              />
              <button
                type="button"
                onClick={() => setShowSkills(!showSkills)}
                disabled={!isAgentLive}
                className={cn(
                  "ml-auto hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 md:inline-flex",
                  showSkills
                    ? "bg-mines-blue text-white"
                    : "text-ink-secondary hover:text-ink",
                )}
              >
                <FlaskConical className="h-3.5 w-3.5" />
                Skills
              </button>
            </div>
            <div className="pointer-events-none absolute inset-x-0 top-1/2 hidden -translate-y-1/2 justify-center md:flex">
              <div className="pointer-events-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    updateSearchParams((next) => {
                      next.delete("view");
                      next.delete("wsFile");
                    });
                  }}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                    viewMode === "chat"
                      ? "bg-white text-ink shadow-sm ring-1 ring-black/[0.04]"
                      : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Chat
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateSearchParams((next) => {
                      next.set("view", "workspace");
                    })
                  }
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                    viewMode === "workspace"
                      ? "bg-white text-ink shadow-sm ring-1 ring-black/[0.04]"
                      : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Workspace
                </button>
              </div>
            </div>

            <div className="mt-2 flex items-center gap-2 md:hidden">
              <div className="inline-flex flex-1 items-center gap-1 rounded-lg border border-stroke bg-white p-0.5">
                <button
                  type="button"
                  onClick={() => {
                    updateSearchParams((next) => {
                      next.delete("view");
                      next.delete("wsFile");
                    });
                  }}
                  className={cn(
                    "flex-1 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors",
                    viewMode === "chat"
                      ? "bg-white text-ink shadow-sm ring-1 ring-black/[0.04]"
                      : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Chat
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateSearchParams((next) => {
                      next.set("view", "workspace");
                    })
                  }
                  className={cn(
                    "flex-1 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors",
                    viewMode === "workspace"
                      ? "bg-white text-ink shadow-sm ring-1 ring-black/[0.04]"
                      : "text-ink-secondary hover:text-ink",
                  )}
                >
                  Workspace
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowSkills(!showSkills)}
                disabled={!isAgentLive}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  showSkills
                    ? "bg-mines-blue text-white"
                    : "text-ink-secondary hover:text-ink",
                )}
              >
                <FlaskConical className="h-3.5 w-3.5" />
                Skills
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 flex overflow-hidden min-h-0">
            {sandboxState !== "ready" && !isLoading ? (
              <div className="flex-1 grid place-items-center px-6">
                <div className="w-full max-w-md rounded-2xl border border-stroke bg-white/95 shadow-sm p-8 text-center">
                  {sandboxState === "waking" ? (
                    <div className="flex flex-col items-center gap-4">
                      <div className="relative">
                        <span className="absolute inset-0 rounded-full bg-amber-200/40 blur-md animate-pulse" />
                        <span className="relative inline-flex h-16 w-16 items-center justify-center rounded-full border border-amber-300 bg-amber-50">
                          <Loader2 className="h-7 w-7 text-amber-600 animate-spin" />
                        </span>
                      </div>
                      <div>
                        <h3 className="text-lg font-semibold text-ink">
                          Waking agent
                        </h3>
                        <p className="mt-1 text-sm text-ink-muted">
                          This takes 20-30 seconds...
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-4">
                      <span className="inline-flex h-16 w-16 items-center justify-center rounded-full border border-slate-300 bg-slate-50">
                        {sandboxState === "error" ? (
                          <Power className="h-7 w-7 text-red-500" />
                        ) : (
                          <Moon className="h-7 w-7 text-slate-500" />
                        )}
                      </span>
                      <div>
                        <h3 className="text-lg font-semibold text-ink">
                          {sandboxState === "error"
                            ? "Sandbox unavailable"
                            : "Agent asleep"}
                        </h3>
                        <p className="mt-1 text-sm text-ink-muted">
                          {sandboxState === "error"
                            ? sandboxMessage || "The sandbox hit an error."
                            : "Wake this agent to start chatting."}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          wakeTraceClient("ui.wake_click", {
                            agentId: selectedAgent.id,
                            sandboxState,
                          });
                          void ensureSandboxReady(
                            selectedAgent.id,
                            sandboxState === "error"
                              ? "vm_error_retrying"
                              : "vm_starting",
                          );
                        }}
                        className="inline-flex items-center gap-2 rounded-lg bg-mines-blue px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
                      >
                        <Power className="h-4 w-4" />
                        Wake Agent
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div
                  className={cn(
                    "min-h-0 flex-1",
                    viewMode === "chat" ? "flex" : "hidden",
                  )}
                  aria-hidden={viewMode !== "chat"}
                >
                  <ChatView
                    key={`${selectedAgent.id}:${selectedSessionId || ""}`}
                    messages={messages}
                    input={input}
                    isLoading={isLoading}
                    isGoalStreaming={isGoalStreaming}
                    isHydratingSession={isSessionHydrating}
                    agentName={selectedAgent.name}
                    userName={firstName}
                    greeting={greeting}
                    outputFolder={outputFolder}
                    goal={goal}
                    model={model}
                    sandboxStatus={sandboxState}
                    sandboxMessage={sandboxMessage}
                    onInputChange={handleInputChange}
                    onModelChange={handleModelChange}
                    onSend={handleSend}
                    onStop={handleStop}
                    onStopGoalExecution={handleStopGoalExecution}
                    onGoalClick={openGoalModal}
                    onOutputFolderClick={() => setShowFolderPicker(true)}
                    onClearOutputFolder={() => handleOutputFolderChange(null)}
                    onFileClick={handleFileClick}
                  />
                </div>
                {viewMode === "workspace" ? (
                  <div
                    className="flex min-h-0 flex-1 overflow-hidden"
                    aria-hidden={false}
                  >
                    <WorkspaceView
                      agentId={selectedAgent.id}
                      agentName={selectedAgent.name}
                      selectedFilePath={workspaceFile}
                      onSelectedFilePathChange={
                        handleWorkspaceSelectedFilePathChange
                      }
                    />
                  </div>
                ) : null}
              </>
            )}

            {/* Skills drawer */}
            {showSkills && (
              <AgentSkillsDrawer
                agentSkills={agentSkills}
                onRemoveSkill={handleRemoveSkill}
                onInstallSkills={handleInstallSkills}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="mb-5">
            <img
              src="/donkey.png"
              alt="Mines AI"
              className="h-14 w-14 rounded-2xl object-cover shadow-sm"
            />
          </div>
          <h2 className="mb-1.5 text-xl font-semibold tracking-tight text-ink">
            {greeting}, {firstName}
          </h2>
          <p className="max-w-sm text-center text-sm text-ink-muted">
            Select an agent from the sidebar to start a conversation, or create
            a new one to get started.
          </p>
        </div>
      )}
      {/* Folder picker modal */}
      {showFolderPicker && selectedAgentId && (
        <FolderPickerModal
          agentId={selectedAgentId}
          currentFolder={outputFolder}
          onSelect={(folder) => handleOutputFolderChange(folder)}
          onClose={() => setShowFolderPicker(false)}
        />
      )}
      {showGoalFolderPicker && selectedAgentId && (
        <FolderPickerModal
          agentId={selectedAgentId}
          currentFolder={goalDraft.outputFolder || null}
          onSelect={handleSelectGoalFolder}
          onClose={closeGoalFolderPicker}
        />
      )}
      <Dialog open={showGoalModal} onOpenChange={setShowGoalModal}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="inline-flex items-center gap-2">
              <Target className="h-4 w-4 text-blue-600" />
              {goal && goal.status === "active"
                ? "Edit goal mode"
                : "Set goal mode"}
            </DialogTitle>
            <DialogDescription>
              Define a persistent objective. The agent will keep working toward
              it and update progress artifacts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-sm font-medium text-foreground">
              Goal
            </label>
            <textarea
              value={goalDraft.goal}
              onChange={(event) =>
                setGoalDraft((prev) => ({ ...prev, goal: event.target.value }))
              }
              placeholder="What should the agent achieve?"
              className="min-h-[84px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <label className="block text-sm font-medium text-foreground">
              Acceptance criteria
            </label>
            <textarea
              value={goalDraft.acceptanceCriteria}
              onChange={(event) =>
                setGoalDraft((prev) => ({
                  ...prev,
                  acceptanceCriteria: event.target.value,
                }))
              }
              placeholder="Required: objective conditions that define done"
              className="min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <label className="block text-sm font-medium text-foreground">
              Additional guidance
            </label>
            <textarea
              value={goalDraft.guidance}
              onChange={(event) =>
                setGoalDraft((prev) => ({
                  ...prev,
                  guidance: event.target.value,
                }))
              }
              placeholder="Optional constraints, style preferences, or evaluation criteria"
              className="min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <label className="block text-sm font-medium text-foreground">
              Deadline
            </label>
            <input
              type="datetime-local"
              value={goalDraft.deadlineAt}
              onChange={(event) =>
                setGoalDraft((prev) => ({
                  ...prev,
                  deadlineAt: event.target.value,
                }))
              }
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            />
            {goalDraftHasPastDeadline ? (
              <p className="text-xs text-red-600">
                Deadline must be in the future.
              </p>
            ) : null}
            <label className="block text-sm font-medium text-foreground">
              Output folder
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openGoalFolderPicker}
                className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent"
              >
                Select folder
              </button>
              <span className="truncate text-xs text-muted-foreground">
                {goalDraft.outputFolder
                  ? `/${goalDraft.outputFolder}`
                  : "/ (workspace root)"}
              </span>
            </div>
          </div>
          <DialogFooter className="flex items-center justify-end gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowGoalModal(false)}
                className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleStartGoal()}
                disabled={
                  sandboxState !== "ready" ||
                  !goalDraft.goal.trim() ||
                  !goalDraft.acceptanceCriteria.trim() ||
                  goalDraftHasPastDeadline
                }
                className="inline-flex h-9 items-center justify-center rounded-md bg-mines-blue px-4 text-sm font-medium text-white hover:bg-mines-blue/90 disabled:opacity-60"
              >
                Start goal
              </button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* File preview overlay */}
      {previewFile && selectedAgentId && (
        <FilePreviewOverlay
          agentId={selectedAgentId}
          filePath={previewFile}
          onClose={closePreview}
          onOpenInWorkspace={openInWorkspace}
        />
      )}
      <Dialog
        open={showMachineTransitionDialog}
        onOpenChange={(open) => {
          setShowMachineTransitionDialog(open);
          if (!open && !machineTransitionLoading) {
            setPendingMachineProfileId(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Change machine type?</DialogTitle>
            <DialogDescription>
              {pendingMachineProfile
                ? `Switch this agent to ${pendingMachineProfile.label}. The sandbox will restart during the transition.`
                : "Switching machine type will restart the sandbox."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => {
                setShowMachineTransitionDialog(false);
                setPendingMachineProfileId(null);
              }}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent"
              disabled={machineTransitionLoading}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmMachineTransition()}
              className="inline-flex h-9 items-center justify-center rounded-md bg-mines-blue px-4 text-sm font-medium text-white hover:bg-mines-blue/90 disabled:opacity-60"
              disabled={machineTransitionLoading}
            >
              {machineTransitionLoading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Switching...
                </span>
              ) : (
                "Confirm"
              )}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showUpgradeRiskDialog}
        onOpenChange={(open) => {
          setShowUpgradeRiskDialog(open);
          if (!open && !machineTransitionLoading) {
            setPendingMachineProfileId(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="inline-flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Confirm VM recreation
            </DialogTitle>
            <DialogDescription>
              This agent appears to have system-level installs outside
              /workspace. Recreating or changing machine type can remove those
              installs.
            </DialogDescription>
          </DialogHeader>
          {upgradeRiskMessage ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {upgradeRiskMessage}
            </div>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              onClick={() => {
                setShowUpgradeRiskDialog(false);
                setPendingMachineProfileId(null);
              }}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent"
              disabled={machineTransitionLoading}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmMachineTransition(true)}
              className="inline-flex h-9 items-center justify-center rounded-md bg-mines-blue px-4 text-sm font-medium text-white hover:bg-mines-blue/90 disabled:opacity-60"
              disabled={machineTransitionLoading}
            >
              {machineTransitionLoading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Confirming...
                </span>
              ) : (
                "I understand, continue"
              )}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showGpuFallbackDialog}
        onOpenChange={(open) => {
          setShowGpuFallbackDialog(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="inline-flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              GPU currently unavailable
            </DialogTitle>
            <DialogDescription>
              No GPUs are available right now. This agent was automatically
              switched to CPU so you can keep working. Please try GPU again
              later.
            </DialogDescription>
          </DialogHeader>
          {gpuFallbackInfo ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Requested: <code>{gpuFallbackInfo.requestedMachineType}</code>
              <br />
              Current: <code>{gpuFallbackInfo.fallbackMachineType}</code>
            </div>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              onClick={() => setShowGpuFallbackDialog(false)}
              className="inline-flex h-9 items-center justify-center rounded-md bg-mines-blue px-4 text-sm font-medium text-white hover:bg-mines-blue/90"
            >
              OK
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
