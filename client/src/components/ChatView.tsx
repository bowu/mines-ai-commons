import { MarkdownImage } from "@/components/MarkdownImage";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { AgentModel } from "@/lib/api";
import { PROSE_CLASSES, cn } from "@/lib/utils";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle,
  ChevronDown,
  Eye,
  FileText,
  FolderOutput,
  Globe,
  Loader2,
  Pencil,
  Search,
  Square,
  Target,
  Terminal,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/* ─── Types ─────────────────────────────────────────────── */

export interface ToolCallInfo {
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: boolean;
}

export type MessageSegment =
  | { type: "text"; content: string; blockIndex?: number }
  | { type: "thinking"; content: string; blockIndex?: number }
  | {
      type: "tool";
      name: string;
      args?: Record<string, unknown>;
      result?: unknown;
      error?: boolean;
    };

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
  segments?: MessageSegment[];
  toolCalls?: ToolCallInfo[];
  turnId?: string;
  partial?: boolean;
}

type ToolSeg = MessageSegment & { type: "tool" };

/* ─── Helpers ───────────────────────────────────────────── */

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function getSafeToolName(value: unknown): string {
  if (typeof value !== "string") return "tool";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "tool";
}

function extractBashWriteTarget(command: string): string | null {
  if (!command) return null;

  // shell redirection: > file or >> file
  const redirect = command.match(/(?:^|[\s;|&])>>?\s*["']?([^"'\s;|&]+)["']?/);
  if (redirect?.[1]) return redirect[1];

  // tee file
  const tee = command.match(
    /(?:^|[\s;|&])tee\s+(?:-a\s+)?["']?([^"'\s;|&]+)["']?/,
  );
  if (tee?.[1]) return tee[1];

  return null;
}

function getToolIcon(name: unknown) {
  const n = getSafeToolName(name).toLowerCase();
  if (n === "bash") return Terminal;
  if (
    n === "read" ||
    n === "read_pdf" ||
    n === "read_docx" ||
    n === "read_xlsx"
  )
    return Eye;
  if (n === "write" || n === "create_docx" || n === "create_xlsx")
    return FileText;
  if (n === "edit") return Pencil;
  if (n.includes("search")) return Search;
  if (n.includes("web") || n.includes("fetch")) return Globe;
  return Wrench;
}

function getToolLabel(seg: ToolSeg): { label: string; pill?: string } {
  const toolName = getSafeToolName(seg.name);
  const args = seg.args;
  const rawPath = args?.path ? String(args.path) : undefined;
  const filename = rawPath ? getFileName(rawPath) : undefined;

  switch (toolName) {
    case "bash": {
      const cmd = String(args?.command || "");
      if (!cmd) return { label: "Running command", pill: "Script" };
      const writeTarget = extractBashWriteTarget(cmd);
      if (writeTarget) {
        const outFile = getFileName(writeTarget);
        return { label: `Writing ${outFile}`, pill: outFile };
      }
      if (cmd.match(/^(pip|npm|yarn|pnpm|brew)\s+install/))
        return { label: "Install packages", pill: "Script" };
      if (cmd.match(/^(pip|npm|yarn|pnpm|brew)\s+/))
        return {
          label: cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd,
          pill: "Script",
        };
      return {
        label: cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd,
        pill: "Script",
      };
    }
    case "read":
      return { label: `Reading ${filename || "file"}`, pill: filename };
    case "read_pdf":
      return { label: `Reading PDF`, pill: filename };
    case "read_docx":
      return { label: `Reading Word document`, pill: filename };
    case "read_xlsx":
      return { label: `Reading spreadsheet`, pill: filename };
    case "write":
      return { label: `Writing ${filename || "file"}`, pill: filename };
    case "create_docx":
      return { label: "Creating Word document", pill: filename };
    case "create_xlsx":
      return { label: "Creating spreadsheet", pill: filename };
    case "edit":
      return { label: `Editing ${filename || "file"}`, pill: filename };
    case "web_search":
      return { label: String(args?.query || "Searching the web") };
    case "web_fetch": {
      const url = String(args?.url || "");
      const host = url.match(/\/\/([^/]+)/)?.[1];
      return { label: "Fetching webpage", pill: host || undefined };
    }
    default:
      return { label: toolName, pill: filename };
  }
}

function getToolCategory(seg: ToolSeg): string {
  const toolName = getSafeToolName(seg.name);
  if (toolName === "bash") {
    const cmd = String(seg.args?.command || "");
    if (extractBashWriteTarget(cmd)) return "write";
    return "command";
  }
  if (toolName.startsWith("read")) return "read";
  if (toolName === "write") return "write";
  if (toolName === "create_docx" || toolName === "create_xlsx") return "create";
  if (toolName === "edit") return "edit";
  if (
    toolName.includes("search") ||
    toolName.includes("fetch") ||
    toolName.includes("web")
  )
    return "search";
  return "other";
}

function getWriteFileNames(items: ToolSeg[]): string[] {
  const names = new Set<string>();
  for (const item of items) {
    const toolName = getSafeToolName(item.name);
    let rawPath: string | null = null;
    if (toolName === "write" && item.args?.path) {
      rawPath = String(item.args.path);
    } else if (toolName === "bash") {
      rawPath = extractBashWriteTarget(String(item.args?.command || ""));
    }
    if (!rawPath) continue;
    const file = getFileName(rawPath);
    if (file) names.add(file);
  }
  return Array.from(names);
}

function getToolGroupSummary(items: ToolSeg[]): string {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const cat = getToolCategory(item);
    counts[cat] = (counts[cat] || 0) + 1;
  }
  const parts: string[] = [];
  if (counts.search)
    parts.push(
      counts.search === 1
        ? "Searched the web"
        : `Searched ${counts.search} times`,
    );
  if (counts.read)
    parts.push(`read ${counts.read} file${counts.read > 1 ? "s" : ""}`);
  if (counts.command)
    parts.push(`ran ${counts.command} command${counts.command > 1 ? "s" : ""}`);
  if (counts.write) {
    const writeNames = getWriteFileNames(items);
    if (writeNames.length > 0) {
      const shown = writeNames.slice(0, 2).join(", ");
      const extra =
        writeNames.length > 2 ? ` +${writeNames.length - 2} more` : "";
      parts.push(`wrote ${shown}${extra}`);
    } else {
      parts.push(`wrote ${counts.write} file${counts.write > 1 ? "s" : ""}`);
    }
  }
  if (counts.create)
    parts.push(`created ${counts.create} file${counts.create > 1 ? "s" : ""}`);
  if (counts.edit)
    parts.push(`edited ${counts.edit} file${counts.edit > 1 ? "s" : ""}`);
  if (counts.other)
    parts.push(`used ${counts.other} tool${counts.other > 1 ? "s" : ""}`);
  // Capitalize first letter
  const summary = parts.join(", ");
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

function formatToolResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

const MAX_TOOL_PREVIEW_CHARS = 12_000;

function getToolPreview(seg: ToolSeg): string | null {
  const toolName = getSafeToolName(seg.name);
  let raw: unknown = null;
  if (toolName === "write") raw = seg.args?.content;
  if (toolName === "edit") raw = seg.args?.newText;
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length <= MAX_TOOL_PREVIEW_CHARS) return raw;
  return `${raw.slice(0, MAX_TOOL_PREVIEW_CHARS)}\n\n[... preview truncated for UI ...]`;
}

/** Build an ordered segment list from an AgentMessage */
function getSegments(msg: AgentMessage): MessageSegment[] {
  if (msg.segments && msg.segments.length > 0) return msg.segments;
  const segs: MessageSegment[] = [];
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      segs.push({
        type: "tool",
        name: getSafeToolName(tc.name),
        args: tc.args,
        result: tc.result,
        error: tc.error,
      });
    }
  }
  if (msg.content) {
    segs.push({ type: "text", content: msg.content });
  }
  return segs;
}

type ActivityItem =
  | { kind: "tool"; seg: ToolSeg }
  | { kind: "thinking"; content: string };

/** Group consecutive non-text segments into one collapsible activity block. */
type SegmentGroup =
  | { kind: "text"; content: string }
  | { kind: "activity"; items: ActivityItem[] };

function groupSegments(segs: MessageSegment[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (const seg of segs) {
    if (seg.type === "tool" || (seg.type === "thinking" && seg.content)) {
      const item: ActivityItem =
        seg.type === "tool"
          ? { kind: "tool", seg }
          : { kind: "thinking", content: seg.content };
      const last = groups[groups.length - 1];
      if (last && last.kind === "activity") {
        last.items.push(item);
      } else {
        groups.push({ kind: "activity", items: [item] });
      }
    } else if (seg.content) {
      groups.push({ kind: "text", content: seg.content });
    }
  }
  return groups;
}

/* ─── Timeline row (icon + line + content) ───────────────── */

function TimelineRow({
  icon,
  iconClass,
  showLine,
  children,
}: {
  icon: React.ReactNode;
  iconClass?: string;
  showLine: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex">
      {/* Icon column — icon centered, connecting line below */}
      <div className="flex flex-col items-center mr-3 shrink-0">
        <div
          className={cn(
            "w-[18px] h-[18px] rounded-full flex items-center justify-center shrink-0",
            iconClass || "bg-white border border-border",
          )}
        >
          {icon}
        </div>
        {showLine && <div className="w-px flex-1 bg-border/50 min-h-[8px]" />}
      </div>
      {/* Content */}
      <div className="flex-1 min-w-0 pb-3">{children}</div>
    </div>
  );
}

/* ─── Combined Activity Group (tools + thinking) ─────────── */

function ActivityGroup({
  group,
}: { group: SegmentGroup & { kind: "activity" } }) {
  const [collapsed, setCollapsed] = useState(true);
  const [expandedToolIdx, setExpandedToolIdx] = useState<number | null>(null);

  const toolItems = group.items.filter(
    (item): item is { kind: "tool"; seg: ToolSeg } => item.kind === "tool",
  );
  const thinkingItems = group.items.filter(
    (item): item is { kind: "thinking"; content: string } =>
      item.kind === "thinking",
  );
  const hasPending = toolItems.some(
    (item) => item.seg.result === undefined && !item.seg.error,
  );
  const lastTool = [...toolItems].reverse()[0];
  const lastToolIsError = lastTool?.seg.error === true;

  const parts: string[] = [];
  if (toolItems.length > 0) {
    const summary = getToolGroupSummary(toolItems.map((item) => item.seg));
    parts.push(summary.charAt(0).toLowerCase() + summary.slice(1));
  }
  if (thinkingItems.length > 0) {
    parts.push(
      `thinking ${thinkingItems.length} time${thinkingItems.length > 1 ? "s" : ""}`,
    );
  }
  const label =
    parts.length > 0
      ? `${parts.join(", ").charAt(0).toUpperCase()}${parts.join(", ").slice(1)}`
      : "Agent activity";

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {hasPending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
        ) : lastTool ? (
          lastToolIsError ? (
            <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
          ) : (
            <CheckCircle className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
          )
        ) : (
          <CheckCircle className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
        )}
        <span>{label}</span>
        <ChevronDown
          className={cn(
            "w-3.5 h-3.5 transition-transform duration-200",
            collapsed && "-rotate-90",
          )}
        />
      </button>

      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="overflow-hidden">
          <div className="mt-2">
            {group.items.map((item, idx) => {
              if (item.kind === "thinking") {
                return (
                  <TimelineRow
                    key={idx}
                    showLine={idx < group.items.length - 1}
                    iconClass="bg-slate-50 border border-slate-200"
                    icon={
                      <CheckCircle className="w-2.5 h-2.5 text-emerald-500" />
                    }
                  >
                    <div className="text-[12px] leading-relaxed rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600 whitespace-pre-wrap">
                      {item.content}
                    </div>
                  </TimelineRow>
                );
              }

              const seg = item.seg;
              const Icon = getToolIcon(seg.name);
              const { label: toolLabel, pill } = getToolLabel(seg);
              const isPending = seg.result === undefined && !seg.error;
              const hasResult = seg.result != null;
              const preview = getToolPreview(seg);
              const hasPreview = Boolean(preview);
              const canExpand = hasResult || hasPreview;
              const isExpanded = expandedToolIdx === idx;
              const iconClass = isPending
                ? "bg-blue-50 border border-blue-200"
                : seg.error
                  ? "bg-red-50 border border-red-200"
                  : "bg-white border border-border";

              return (
                <TimelineRow
                  key={idx}
                  showLine={idx < group.items.length - 1}
                  iconClass={iconClass}
                  icon={
                    isPending ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin text-blue-500" />
                    ) : (
                      <Icon
                        className={cn(
                          "w-2.5 h-2.5",
                          seg.error
                            ? "text-red-400"
                            : "text-muted-foreground/60",
                        )}
                      />
                    )
                  }
                >
                  <button
                    type="button"
                    onClick={() =>
                      canExpand && setExpandedToolIdx(isExpanded ? null : idx)
                    }
                    disabled={!canExpand}
                    className={cn(
                      "text-left w-full",
                      canExpand && "cursor-pointer hover:text-foreground",
                    )}
                  >
                    <div
                      className={cn(
                        "text-[13px] leading-[18px]",
                        isPending
                          ? "text-blue-600"
                          : seg.error
                            ? "text-red-500"
                            : "text-muted-foreground",
                      )}
                    >
                      {toolLabel}
                    </div>
                    {pill && (
                      <span className="inline-block mt-0.5 px-1.5 py-0 text-[10px] rounded bg-muted text-muted-foreground/70">
                        {pill}
                      </span>
                    )}
                  </button>

                  {isExpanded && canExpand && (
                    <div className="mt-1 px-2.5 py-1.5 bg-muted/40 rounded-md text-[10px] text-muted-foreground max-h-[160px] overflow-auto">
                      {hasPreview && (
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80 mb-1">
                            File content
                          </div>
                          <pre className="whitespace-pre-wrap break-words font-mono leading-relaxed">
                            {preview}
                          </pre>
                        </div>
                      )}
                      {hasResult && (
                        <div
                          className={cn(
                            hasPreview && "mt-2 pt-2 border-t border-border/60",
                          )}
                        >
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80 mb-1">
                            Tool result
                          </div>
                          <pre className="whitespace-pre-wrap break-words font-mono leading-relaxed">
                            {formatToolResult(seg.result)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </TimelineRow>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function StreamingActivityDots() {
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/80 animate-pulse [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70 animate-pulse [animation-delay:180ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/60 animate-pulse [animation-delay:360ms]" />
    </div>
  );
}

/* ─── Chat View ─────────────────────────────────────────── */

interface ChatViewProps {
  messages: AgentMessage[];
  input: string;
  isLoading: boolean;
  isGoalStreaming?: boolean;
  isHydratingSession?: boolean;
  agentName?: string;
  userName?: string;
  greeting?: string;
  outputFolder: string | null;
  goal?: {
    goal: string;
    deadline_at: string | null;
    status: "active" | "completed" | "expired" | "cancelled";
    output_folder: string;
  } | null;
  model: AgentModel;
  sandboxStatus: "ready" | "waking" | "asleep" | "error";
  sandboxMessage: string;
  onInputChange: (value: string) => void;
  onInputFocus?: () => void;
  onModelChange: (model: AgentModel) => void;
  onSend: () => void;
  onStop: () => void;
  onOutputFolderClick: () => void;
  onClearOutputFolder: () => void;
  onGoalClick: () => void;
  onStopGoalExecution: () => void;
  onFileClick?: (filePath: string) => void;
}

export function ChatView({
  messages,
  input,
  isLoading,
  isGoalStreaming = false,
  isHydratingSession = false,
  agentName,
  userName,
  greeting,
  outputFolder,
  goal,
  model,
  sandboxStatus,
  sandboxMessage,
  onInputChange,
  onInputFocus,
  onModelChange,
  onSend,
  onStop,
  onOutputFolderClick,
  onClearOutputFolder,
  onGoalClick,
  onStopGoalExecution,
  onFileClick,
}: ChatViewProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const initialConversationSnapPendingRef = useRef(true);
  const [viewportReadyTick, setViewportReadyTick] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const canSetGoal = sandboxStatus === "ready";
  const isStreaming = isLoading || isGoalStreaming;

  const activeStatusText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role !== "assistant") continue;
      if (msg.segments) {
        for (let j = msg.segments.length - 1; j >= 0; j--) {
          const seg = msg.segments[j];
          if (seg.type === "tool" && seg.result === undefined && !seg.error) {
            return getToolLabel(seg).label;
          }
        }
      }
      if (msg.toolCalls?.length) {
        const pending = msg.toolCalls.find(
          (tc) => tc.result === undefined && !tc.error,
        );
        if (pending?.name) return `Using ${pending.name}...`;
      }
    }
    return null;
  }, [messages]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport) return false;
    shouldAutoScrollRef.current = true;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    setIsAtBottom(true);
    return true;
  }, []);

  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;
    const viewport = root.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLDivElement | null;
    if (!viewport) return;
    viewportRef.current = viewport;
    setViewportReadyTick((v) => v + 1);

    const updateAtBottom = () => {
      const remaining =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const atBottom = remaining <= 24;
      shouldAutoScrollRef.current = atBottom;
      setIsAtBottom(atBottom);
    };

    updateAtBottom();
    viewport.addEventListener("scroll", updateAtBottom, { passive: true });
    window.addEventListener("resize", updateAtBottom);

    return () => {
      viewport.removeEventListener("scroll", updateAtBottom);
      window.removeEventListener("resize", updateAtBottom);
      viewportRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (initialConversationSnapPendingRef.current) {
      const snapped = scrollToBottom("auto");
      if (snapped && messages.length > 0) {
        initialConversationSnapPendingRef.current = false;
      }
      return;
    }
    if (!shouldAutoScrollRef.current) return;
    scrollToBottom(isStreaming ? "auto" : "smooth");
  }, [isStreaming, messages, scrollToBottom, viewportReadyTick]);

  useEffect(() => {
    if (!isLoading) inputRef.current?.focus();
  }, [isLoading]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const computed = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
    const padding =
      (Number.parseFloat(computed.paddingTop) || 0) +
      (Number.parseFloat(computed.paddingBottom) || 0);
    const border =
      (Number.parseFloat(computed.borderTopWidth) || 0) +
      (Number.parseFloat(computed.borderBottomWidth) || 0);
    const maxH = lineHeight * 5 + padding + border;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
  }, [input]);

  // Custom markdown components: render file:// links as clickable file chips
  const mdComponents = useMemo<Components>(
    () => ({
      a({ href, children }) {
        if (href?.startsWith("file://") && onFileClick) {
          const filePath = href.slice("file://".length);
          return (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onFileClick(filePath);
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-[11px] font-medium hover:bg-blue-100 transition-colors no-underline cursor-pointer mx-0.5"
            >
              <FileText className="w-3 h-3 shrink-0" />
              {children}
            </button>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
      img({ src, alt }) {
        return (
          <MarkdownImage
            src={src}
            alt={alt}
            className="max-w-full h-auto rounded"
            onFileClick={onFileClick}
          />
        );
      },
    }),
    [onFileClick],
  );

  // Preserve file:// links so they are not sanitized to empty href by default transform.
  const markdownUrlTransform = useMemo(
    () => (url: string) =>
      url.startsWith("file://") ? url : defaultUrlTransform(url),
    [],
  );

  return (
    <div
      data-testid="chat-view"
      className="h-full flex flex-1 flex-col min-w-0 min-h-0"
    >
      <ScrollArea ref={scrollAreaRef} className="chat-scroll-area flex-1">
        <div className="px-3 py-3 sm:px-4 md:px-6 md:py-4">
          <div className="mx-auto w-full max-w-[760px]">
            {/* Empty state */}
            {messages.length === 0 && !isHydratingSession && (
              <div className="h-full flex flex-col items-center justify-center min-h-[400px]">
                <h2 className="text-xl font-semibold text-ink tracking-tight">
                  {greeting ? `${greeting}, ${userName}` : agentName}
                </h2>
                <p className="text-sm text-ink-muted mt-1">
                  How can I help you today?
                </p>
              </div>
            )}
            {messages.length === 0 && isHydratingSession && (
              <div className="h-full flex flex-col items-center justify-center min-h-[400px]">
                <Loader2 className="h-5 w-5 animate-spin text-ink-faint" />
                <p className="mt-2 text-sm text-ink-muted">
                  Loading conversation...
                </p>
              </div>
            )}

            {/* Messages */}
            {messages.map((msg, i) => {
              if (msg.role === "user") {
                return (
                  <div key={i} className="mb-5 flex justify-end">
                    <div className="px-3.5 py-2.5 rounded-2xl rounded-br-sm bg-mines-blue text-white text-sm leading-relaxed max-w-[600px]">
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    </div>
                  </div>
                );
              }

              // Assistant message
              const segs = getSegments(msg);
              const groups = groupSegments(segs);

              if (
                groups.length === 0 &&
                isStreaming &&
                i === messages.length - 1
              ) {
                return (
                  <div key={i} className="mb-5">
                    <StreamingActivityDots />
                  </div>
                );
              }

              return (
                <div key={i} className="mb-5">
                  {groups.map((group, gi) => {
                    if (group.kind === "activity") {
                      return <ActivityGroup key={gi} group={group} />;
                    }
                    return (
                      <div
                        key={gi}
                        className="text-sm leading-[1.7] text-foreground"
                      >
                        <div
                          className={cn(
                            PROSE_CLASSES,
                            "[&_input[type=checkbox]]:mr-1.5",
                          )}
                        >
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex]}
                            components={mdComponents}
                            urlTransform={markdownUrlTransform}
                          >
                            {group.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    );
                  })}
                  {isStreaming && i === messages.length - 1 && (
                    <StreamingActivityDots />
                  )}
                </div>
              );
            })}

            {/* Loading dots when waiting for first assistant response */}
            {isStreaming &&
              messages[messages.length - 1]?.role !== "assistant" && (
                <div className="mb-5">
                  <StreamingActivityDots />
                </div>
              )}

            {/* Bottom sentinel — scrollIntoView target for initial snap */}
            <div ref={bottomRef} />
          </div>
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className="px-3 pb-4 pt-2 sm:px-4 md:px-6 md:pb-5">
        <div className="relative mx-auto w-full max-w-[760px]">
          {!isAtBottom && (
            <button
              type="button"
              onClick={() => scrollToBottom("smooth")}
              className="absolute -top-11 left-1/2 z-10 h-9 w-9 -translate-x-1/2 rounded-full border border-stroke bg-white/95 text-ink-muted shadow-md transition hover:bg-white hover:text-ink"
              aria-label="Jump to latest message"
              title="Jump to latest message"
            >
              <ArrowDown className="mx-auto h-4 w-4" />
            </button>
          )}
          {goal && goal.status === "active" ? (
            <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="inline-flex items-center gap-2 text-[12px] font-semibold text-blue-700">
                    <Target className="h-4 w-4" />
                    Goal Mode Active
                  </div>
                  <p className="mt-1 text-sm text-blue-950 break-words">
                    {goal.goal}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-blue-800">
                    <span>
                      {goal.deadline_at
                        ? `Deadline: ${new Date(goal.deadline_at).toLocaleString()}`
                        : "Deadline: none"}
                    </span>
                    <span>Output: /{goal.output_folder}</span>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-[12px] text-blue-800">
                  {isStreaming ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
                  ) : (
                    <span className="h-2 w-2 rounded-full bg-blue-500/70" />
                  )}
                  <span>
                    {isStreaming
                      ? activeStatusText || "Agent is working on this goal..."
                      : "Goal active. Waiting for next run..."}
                  </span>
                </div>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onGoalClick}
                    className="h-8 flex-1 border-blue-300 bg-white text-blue-900 hover:bg-blue-100 sm:flex-none"
                  >
                    Edit goal
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={onStopGoalExecution}
                    className="h-8 flex-1 bg-red-600 text-white hover:bg-red-700 sm:flex-none"
                  >
                    Stop goal
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div
              className={cn(
                "rounded-2xl border bg-white shadow-sm transition-all duration-200",
                isLoading
                  ? "border-stroke"
                  : "border-stroke focus-within:shadow-md focus-within:border-stroke-strong",
              )}
            >
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onFocus={onInputFocus}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (input.trim()) {
                      onSend();
                    }
                  }
                }}
                placeholder={
                  sandboxStatus === "ready"
                    ? `Ask ${agentName || "agent"}...`
                    : sandboxStatus === "waking"
                      ? sandboxMessage || "Agent is waking..."
                      : sandboxStatus === "asleep"
                        ? sandboxMessage || "Agent is asleep."
                        : sandboxMessage || "Sandbox unavailable."
                }
                rows={1}
                className="border-0 shadow-none resize-none min-h-[42px] px-4 pt-3 pb-1 text-sm text-ink placeholder:text-ink-faint focus-visible:ring-0 focus-visible:ring-offset-0 rounded-lg"
                disabled={isLoading}
                autoFocus
              />

              <div className="flex flex-wrap items-center gap-2 px-2.5 pb-2.5 pt-1 sm:px-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={onGoalClick}
                    disabled={!canSetGoal}
                    className={cn(
                      "inline-flex min-w-[84px] items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 text-[11px] transition-colors sm:min-w-[96px]",
                      canSetGoal
                        ? "text-ink-muted hover:text-ink-secondary hover:bg-stone-100"
                        : "text-ink-faint cursor-not-allowed opacity-60",
                    )}
                  >
                    <Target className="w-3.5 h-3.5" />
                    <span>
                      {goal && goal.status === "active"
                        ? "Edit goal"
                        : "Set goal"}
                    </span>
                  </button>
                  {outputFolder !== null ? (
                    <button
                      type="button"
                      onClick={onOutputFolderClick}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 py-1 pl-2 pr-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100"
                    >
                      <FolderOutput className="w-3.5 h-3.5" />
                      <span className="max-w-[120px] truncate whitespace-nowrap sm:max-w-[220px]">
                        /{outputFolder || "workspace root"}
                      </span>
                      <span
                        role="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onClearOutputFolder();
                        }}
                        className="ml-0.5 p-0.5 rounded hover:bg-amber-200 transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={onOutputFolderClick}
                      className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 text-[11px] text-ink-muted transition-colors hover:bg-stone-100 hover:text-ink-secondary"
                    >
                      <FolderOutput className="w-3.5 h-3.5" />
                      <span>Output folder</span>
                    </button>
                  )}
                </div>

                <div className="ml-auto flex items-center gap-1.5">
                  <Select
                    value={model}
                    onValueChange={(value) =>
                      onModelChange(value as AgentModel)
                    }
                    disabled={isLoading}
                  >
                    <SelectTrigger className="h-7 min-w-[120px] rounded-lg border-stroke bg-stone-50 px-2 text-[11px] text-ink-secondary sm:min-w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gemini-3.1-pro">
                        gemini 3.1 pro
                      </SelectItem>
                      <SelectItem value="sonnet-4.6">sonnet 4.6</SelectItem>
                      <SelectItem value="opus-4.6">opus 4.6</SelectItem>
                      <SelectItem value="gpt-5.2">gpt 5.2</SelectItem>
                    </SelectContent>
                  </Select>
                  {isLoading ? (
                    <button
                      type="button"
                      onClick={onStop}
                      aria-label="Stop response"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500 p-0 text-white transition-colors hover:bg-red-600"
                    >
                      <Square className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={onSend}
                      disabled={!input.trim()}
                      aria-label="Send message"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-mines-gold p-0 text-white shadow-[0_2px_8px_rgba(197,179,88,0.25)] transition-colors hover:bg-mines-gold/90 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
