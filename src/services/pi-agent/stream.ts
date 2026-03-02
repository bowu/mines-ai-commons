/**
 * Stream handler for pi-coding-agent sessions.
 * Subscribes to agent events and maps them to SSE-compatible events.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { config } from "../../config.js";
export { buildSystemPrompt } from "../../shared/agent-system-prompt.js";

export interface StreamEvent {
  type:
    | "session"
    | "text"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "error"
    | "done";
  data?: unknown;
  sessionId?: string;
}

interface ReplaceTextPayload {
  mode: "replace";
  text: string;
  blockIndex: number;
}

interface AssistantMessageLike {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

const AGENT_END_GRACE_MS = 1500;
const DEFAULT_MAX_AGENT_RUNTIME_MS = 5 * 60 * 60 * 1000;
const ABORT_GRACE_MS = 4_000;
const THINKING_EMIT_MIN_INTERVAL_MS = 150;
const THINKING_EMIT_MIN_GROWTH_CHARS = 80;
const MAX_STREAM_TOOL_RESULT_CHARS = 20_000;
const MAX_AGENT_RUNTIME_MS =
  config.piAgentMaxRuntimeMs || DEFAULT_MAX_AGENT_RUNTIME_MS;

function extractAssistantTextBlocks(
  message: AssistantMessageLike | undefined,
): string[] {
  if (
    !message ||
    message.role !== "assistant" ||
    !Array.isArray(message.content)
  ) {
    return [];
  }

  const blocks: string[] = [];
  for (const block of message.content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      const text = (block as { text?: unknown }).text;
      blocks.push(typeof text === "string" ? text : "");
    }
  }
  return blocks;
}

function extractAssistantThinkingBlocks(
  message: AssistantMessageLike | undefined,
): string[] {
  if (
    !message ||
    message.role !== "assistant" ||
    !Array.isArray(message.content)
  ) {
    return [];
  }

  const blocks: string[] = [];
  for (const block of message.content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "thinking"
    ) {
      const thinking = (block as { thinking?: unknown }).thinking;
      blocks.push(typeof thinking === "string" ? thinking : "");
    }
  }
  return blocks;
}

function appendChangedBlocksWithVirtualIndexes(
  queue: StreamEvent[],
  snapshots: string[],
  localBlocks: string[],
  localToVirtual: number[],
  nextVirtualIndexRef: { value: number },
  rotateBeforeAppend: boolean,
): void {
  if (rotateBeforeAppend) {
    localToVirtual.length = 0;
  }

  for (let localIndex = 0; localIndex < localBlocks.length; localIndex++) {
    let virtualIndex = localToVirtual[localIndex];
    if (virtualIndex === undefined) {
      virtualIndex = nextVirtualIndexRef.value;
      nextVirtualIndexRef.value += 1;
      localToVirtual[localIndex] = virtualIndex;
    }

    const text = localBlocks[localIndex];
    if ((snapshots[virtualIndex] ?? "") !== text) {
      snapshots[virtualIndex] = text;
      const payload: ReplaceTextPayload = {
        mode: "replace",
        text,
        blockIndex: virtualIndex,
      };
      queue.push({ type: "text", data: payload });
    }
  }
}

function appendChangedThinkingBlocksWithVirtualIndexes(
  queue: StreamEvent[],
  snapshots: string[],
  localBlocks: string[],
  localToVirtual: number[],
  nextVirtualIndexRef: { value: number },
  lastEmitAtMs: number[],
  nowMs: number,
  rotateBeforeAppend: boolean,
  force = false,
): void {
  if (rotateBeforeAppend) {
    localToVirtual.length = 0;
  }

  for (let localIndex = 0; localIndex < localBlocks.length; localIndex++) {
    let virtualIndex = localToVirtual[localIndex];
    if (virtualIndex === undefined) {
      virtualIndex = nextVirtualIndexRef.value;
      nextVirtualIndexRef.value += 1;
      localToVirtual[localIndex] = virtualIndex;
    }

    const text = localBlocks[localIndex];
    const prev = snapshots[virtualIndex] ?? "";
    if (prev === text) continue;

    if (!force) {
      const elapsed = nowMs - (lastEmitAtMs[virtualIndex] ?? 0);
      const growth = text.length - prev.length;
      if (
        elapsed < THINKING_EMIT_MIN_INTERVAL_MS &&
        growth < THINKING_EMIT_MIN_GROWTH_CHARS
      ) {
        continue;
      }
    }

    snapshots[virtualIndex] = text;
    lastEmitAtMs[virtualIndex] = nowMs;
    const payload: ReplaceTextPayload = {
      mode: "replace",
      text,
      blockIndex: virtualIndex,
    };
    queue.push({ type: "thinking", data: payload });
  }
}

function truncateToolResultForStream(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) return result;

  let remaining = MAX_STREAM_TOOL_RESULT_CHARS;
  const nextContent = content.map((item) => {
    if (!item || typeof item !== "object") return item;
    const block = item as Record<string, unknown>;
    if (block.type !== "text" || typeof block.text !== "string") return item;
    if (remaining <= 0) {
      return {
        ...block,
        text: "[... tool output truncated for UI stream ...]",
      };
    }
    const text = block.text;
    if (text.length <= remaining) {
      remaining -= text.length;
      return item;
    }
    const head = text.slice(0, remaining);
    remaining = 0;
    return {
      ...block,
      text: `${head}\n\n[... tool output truncated for UI stream ...]`,
    };
  });

  return { ...record, content: nextContent };
}

/**
 * Run a prompt through the pi-coding-agent session and yield SSE events.
 */
export async function* streamPiAgent(
  session: AgentSession,
  userMessage: string,
  systemPrompt: string,
): AsyncGenerator<StreamEvent> {
  // Collect events
  const events: StreamEvent[] = [];
  let resolveWait: (() => void) | null = null;
  let done = false;
  let promptSettledAt: number | null = null;
  let promptError: unknown = null;
  const textSnapshots: string[] = [];
  const thinkingSnapshots: string[] = [];
  const thinkingLastEmitAtMs: number[] = [];
  const textLocalToVirtual: number[] = [];
  const thinkingLocalToVirtual: number[] = [];
  const nextTextVirtualIndex = { value: 0 };
  const nextThinkingVirtualIndex = { value: 0 };
  let rotateTextOnNextUpdate = false;
  let rotateThinkingOnNextUpdate = false;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const notify = () => {
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  };

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_start": {
        const startedMessage = event.message as
          | AssistantMessageLike
          | undefined;
        if (startedMessage?.role === "assistant") {
          // Only treat explicit assistant message boundaries as a new block.
          // Some providers mutate message.timestamp during streaming updates.
          textLocalToVirtual.length = 0;
          thinkingLocalToVirtual.length = 0;
          rotateTextOnNextUpdate = false;
          rotateThinkingOnNextUpdate = false;
        }
        break;
      }
      case "message_update": {
        const thinkingBlocks = extractAssistantThinkingBlocks(event.message);
        appendChangedThinkingBlocksWithVirtualIndexes(
          events,
          thinkingSnapshots,
          thinkingBlocks,
          thinkingLocalToVirtual,
          nextThinkingVirtualIndex,
          thinkingLastEmitAtMs,
          Date.now(),
          rotateThinkingOnNextUpdate,
        );
        if (thinkingBlocks.length > 0) {
          rotateThinkingOnNextUpdate = false;
        }

        const textBlocks = extractAssistantTextBlocks(event.message);
        appendChangedBlocksWithVirtualIndexes(
          events,
          textSnapshots,
          textBlocks,
          textLocalToVirtual,
          nextTextVirtualIndex,
          rotateTextOnNextUpdate,
        );
        if (textBlocks.length > 0) {
          rotateTextOnNextUpdate = false;
        }
        break;
      }
      case "tool_execution_start": {
        // Preserve chronology: next assistant updates should append after this tool call.
        rotateTextOnNextUpdate = true;
        rotateThinkingOnNextUpdate = true;
        events.push({
          type: "tool_call",
          data: {
            name: event.toolName,
            args: event.args,
          },
        });
        break;
      }
      case "tool_execution_end": {
        events.push({
          type: "tool_result",
          data: {
            name: event.toolName,
            error: event.isError,
            result: truncateToolResultForStream(event.result),
          },
        });
        break;
      }
      case "agent_end": {
        const lastAssistant = [...(event.messages ?? [])]
          .reverse()
          .find(
            (msg) =>
              msg &&
              typeof msg === "object" &&
              (msg as { role?: unknown }).role === "assistant",
          ) as AssistantMessageLike | undefined;
        const finalThinkingBlocks =
          extractAssistantThinkingBlocks(lastAssistant);
        appendChangedThinkingBlocksWithVirtualIndexes(
          events,
          thinkingSnapshots,
          finalThinkingBlocks,
          thinkingLocalToVirtual,
          nextThinkingVirtualIndex,
          thinkingLastEmitAtMs,
          Date.now(),
          rotateThinkingOnNextUpdate,
          true,
        );
        if (finalThinkingBlocks.length > 0) {
          rotateThinkingOnNextUpdate = false;
        }
        const finalBlocks = extractAssistantTextBlocks(lastAssistant);
        appendChangedBlocksWithVirtualIndexes(
          events,
          textSnapshots,
          finalBlocks,
          textLocalToVirtual,
          nextTextVirtualIndex,
          rotateTextOnNextUpdate,
        );
        if (finalBlocks.length > 0) {
          rotateTextOnNextUpdate = false;
        }

        if (finalBlocks.length === 0 && lastAssistant?.stopReason === "error") {
          const errorMessage =
            typeof lastAssistant.errorMessage === "string"
              ? lastAssistant.errorMessage.trim()
              : "";
          if (errorMessage) {
            events.push({
              type: "error",
              data: `Agent error: ${errorMessage}`,
            });
          }
        }
        done = true;
        break;
      }
    }
    notify();
  });

  try {
    // If session is still streaming from a previous request, abort it first
    if (session.isStreaming) {
      const abortTimedOut = await Promise.race([
        session
          .abort()
          .then(() => false)
          .catch(() => false),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(true), ABORT_GRACE_MS),
        ),
      ]);
      if (abortTimedOut || session.isStreaming) {
        throw new Error("Previous run did not stop in time. Please retry.");
      }
    }

    // Send the prompt (non-blocking — events come through subscription)
    const promptPromise = session
      .prompt(userMessage)
      .catch((err) => {
        promptError = err;
      })
      .finally(() => {
        promptSettledAt = Date.now();
        notify();
      });

    timeoutHandle = setTimeout(() => {
      if (done) return;
      events.push({
        type: "error",
        data: `Agent timed out after ${Math.round(MAX_AGENT_RUNTIME_MS / 1000)}s. Please narrow the task or ask for a phased plan.`,
      });
      done = true;
      void session.abort().catch(() => {
        // Ignore abort errors during timeout cleanup.
      });
      notify();
    }, MAX_AGENT_RUNTIME_MS);

    const emitFromSessionState = () => {
      const stateMessages = ((
        session as unknown as {
          agent?: { state?: { messages?: unknown[] } };
        }
      ).agent?.state?.messages ?? []) as unknown[];
      const lastAssistant = [...stateMessages]
        .reverse()
        .find(
          (msg) =>
            msg &&
            typeof msg === "object" &&
            (msg as { role?: unknown }).role === "assistant",
        ) as AssistantMessageLike | undefined;

      const finalBlocks = extractAssistantTextBlocks(lastAssistant);
      appendChangedThinkingBlocksWithVirtualIndexes(
        events,
        thinkingSnapshots,
        extractAssistantThinkingBlocks(lastAssistant),
        thinkingLocalToVirtual,
        nextThinkingVirtualIndex,
        thinkingLastEmitAtMs,
        Date.now(),
        rotateThinkingOnNextUpdate,
        true,
      );
      appendChangedBlocksWithVirtualIndexes(
        events,
        textSnapshots,
        finalBlocks,
        textLocalToVirtual,
        nextTextVirtualIndex,
        rotateTextOnNextUpdate,
      );
      rotateThinkingOnNextUpdate = false;
      rotateTextOnNextUpdate = false;

      if (finalBlocks.length === 0 && lastAssistant?.stopReason === "error") {
        const errorMessage =
          typeof lastAssistant.errorMessage === "string"
            ? lastAssistant.errorMessage.trim()
            : "";
        if (errorMessage) {
          events.push({ type: "error", data: `Agent error: ${errorMessage}` });
        }
      }
    };

    const waitForEventOrTimeout = async (timeoutMs: number) => {
      if (events.length > 0 || done) return;
      await new Promise<void>((resolve) => {
        let timeoutHandle: NodeJS.Timeout | null = null;
        resolveWait = () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve();
        };
        timeoutHandle = setTimeout(() => {
          if (resolveWait) resolveWait = null;
          resolve();
        }, timeoutMs);
      });
    };

    // Yield events as they come
    while (true) {
      if (events.length === 0 && !done) {
        if (promptSettledAt === null) {
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
        } else {
          const elapsed = Date.now() - promptSettledAt;
          const remainingGrace = AGENT_END_GRACE_MS - elapsed;
          if (remainingGrace > 0) {
            await waitForEventOrTimeout(remainingGrace);
          } else {
            // Some runs settle prompt without emitting agent_end/message updates.
            // Flush final assistant state once before ending.
            emitFromSessionState();
            done = true;
          }
        }
      }

      // Drain collected events
      while (events.length > 0) {
        const event = events.shift()!;
        yield event;
      }

      if (done) {
        break;
      }
    }

    // Wait for prompt to fully complete
    await promptPromise;
    if (promptError) {
      throw promptError;
    }

    yield { type: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "error", data: `Agent error: ${message}` };
    yield { type: "done" };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    unsubscribe();
  }
}
