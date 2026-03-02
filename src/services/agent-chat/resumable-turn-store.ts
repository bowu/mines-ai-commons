import { randomUUID } from "node:crypto";

export type ResumableTurnStatus = "running" | "done" | "error";

export interface ResumableEventInput {
  type: string;
  data?: unknown;
  source?: string;
}

export interface ResumableEvent {
  sessionId: string;
  turnId: string;
  seq: number;
  type: string;
  data?: unknown;
  source?: string;
  truncated?: boolean;
  truncated_bytes?: number;
}

interface TurnState {
  turnId: string;
  sessionId: string;
  status: ResumableTurnStatus;
  createdAtMs: number;
  updatedAtMs: number;
  closedAtMs: number | null;
  nextSeq: number;
  minSeq: number;
  bytesUsed: number;
  events: ResumableEvent[];
  eventBytes: number[];
  subscribers: Set<(event: ResumableEvent) => void>;
}

export interface ResumableTurnStoreOptions {
  maxEventBytes: number;
  maxEventsPerTurn: number;
  maxTurnBytes: number;
  maxActiveTurns: number;
  ttlAfterCloseMs: number;
}

export interface CreateTurnResult {
  ok: boolean;
  turnId?: string;
  reason?: "already_running" | "capacity_exhausted";
}

export interface ReplaySlice {
  status: "ok" | "not_found" | "seq_too_old";
  events: ResumableEvent[];
  turnStatus?: ResumableTurnStatus;
  minSeq?: number;
  nextSeq?: number;
}

function truncatedEventPayload(
  type: string,
  rawData: unknown,
  preview: string,
): unknown {
  if (!rawData || typeof rawData !== "object") {
    return {
      preview: `${preview}...`,
      note: "event payload truncated for replay",
    };
  }

  const source = rawData as Record<string, unknown>;
  const payload: Record<string, unknown> = {
    preview: `${preview}...`,
    note: "event payload truncated for replay",
  };

  if (typeof source.name === "string" && source.name.trim().length > 0) {
    payload.name = source.name;
  }
  if (typeof source.error === "boolean") {
    payload.error = source.error;
  }
  if (
    typeof source.blockIndex === "number" &&
    Number.isFinite(source.blockIndex)
  ) {
    payload.blockIndex = source.blockIndex;
  }
  if (type === "tool_result") {
    payload.result_truncated = true;
  }

  return payload;
}

export class InMemoryResumableTurnStore {
  private readonly options: ResumableTurnStoreOptions;
  private readonly turnsById = new Map<string, TurnState>();
  private readonly runningTurnBySession = new Map<string, string>();
  private readonly gcTimer: NodeJS.Timeout;

  constructor(options: ResumableTurnStoreOptions) {
    this.options = options;
    this.gcTimer = setInterval(() => {
      this.garbageCollect();
    }, 60_000);
    this.gcTimer.unref();
  }

  shutdown(): void {
    clearInterval(this.gcTimer);
  }

  getRunningTurnId(sessionId: string): string | null {
    const id = this.runningTurnBySession.get(sessionId);
    if (!id) return null;
    const turn = this.turnsById.get(id);
    if (!turn || turn.status !== "running") {
      this.runningTurnBySession.delete(sessionId);
      return null;
    }
    return id;
  }

  createTurn(sessionId: string): CreateTurnResult {
    const running = this.getRunningTurnId(sessionId);
    if (running) {
      return { ok: false, reason: "already_running", turnId: running };
    }

    this.evictClosedTurnsForCapacity();
    if (this.turnsById.size >= this.options.maxActiveTurns) {
      return { ok: false, reason: "capacity_exhausted" };
    }

    const now = Date.now();
    const turnId = randomUUID();
    const state: TurnState = {
      turnId,
      sessionId,
      status: "running",
      createdAtMs: now,
      updatedAtMs: now,
      closedAtMs: null,
      nextSeq: 1,
      minSeq: 1,
      bytesUsed: 0,
      events: [],
      eventBytes: [],
      subscribers: new Set(),
    };
    this.turnsById.set(turnId, state);
    this.runningTurnBySession.set(sessionId, turnId);
    return { ok: true, turnId };
  }

  appendEvent(
    turnId: string,
    event: ResumableEventInput,
  ): ResumableEvent | null {
    const turn = this.turnsById.get(turnId);
    if (!turn) return null;

    const prepared = this.prepareEventData(event, this.options.maxEventBytes);
    const next: ResumableEvent = {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      seq: turn.nextSeq,
      type: prepared.type,
      data: prepared.data,
      source: prepared.source,
      truncated: prepared.truncated || undefined,
      truncated_bytes: prepared.truncatedBytes || undefined,
    };

    const eventBytes = Buffer.byteLength(JSON.stringify(next), "utf8");
    turn.nextSeq += 1;
    turn.updatedAtMs = Date.now();
    turn.events.push(next);
    turn.eventBytes.push(eventBytes);
    turn.bytesUsed += eventBytes;

    this.enforceTurnCaps(turn);

    for (const subscriber of turn.subscribers) {
      try {
        subscriber(next);
      } catch {
        // Ignore subscriber failures; route handlers clean up on disconnect.
      }
    }

    if (next.type === "done" || next.type === "error") {
      this.closeTurn(turn, next.type);
    }

    return next;
  }

  readFromSeq(sessionId: string, turnId: string, fromSeq: number): ReplaySlice {
    const turn = this.turnsById.get(turnId);
    if (!turn || turn.sessionId !== sessionId) {
      return { status: "not_found", events: [] };
    }

    if (fromSeq < turn.minSeq) {
      return {
        status: "seq_too_old",
        events: [],
        turnStatus: turn.status,
        minSeq: turn.minSeq,
        nextSeq: turn.nextSeq,
      };
    }

    const events = turn.events.filter((event) => event.seq >= fromSeq);
    return {
      status: "ok",
      events,
      turnStatus: turn.status,
      minSeq: turn.minSeq,
      nextSeq: turn.nextSeq,
    };
  }

  subscribe(
    sessionId: string,
    turnId: string,
    listener: (event: ResumableEvent) => void,
  ): () => void {
    const turn = this.turnsById.get(turnId);
    if (!turn || turn.sessionId !== sessionId) {
      return () => {};
    }
    turn.subscribers.add(listener);
    return () => {
      const current = this.turnsById.get(turnId);
      current?.subscribers.delete(listener);
    };
  }

  closeTurnIfRunning(turnId: string, status: ResumableTurnStatus): void {
    const turn = this.turnsById.get(turnId);
    if (!turn || turn.status !== "running") return;
    this.closeTurn(turn, status);
  }

  trimBeforeSeq(turnId: string, keepFromSeq: number): void {
    const turn = this.turnsById.get(turnId);
    if (!turn) return;
    if (!Number.isFinite(keepFromSeq)) return;

    let target = Math.max(1, Math.floor(keepFromSeq));
    // Never trim away events that have not been assigned yet.
    target = Math.min(target, turn.nextSeq);
    if (target <= turn.minSeq) return;

    while (turn.events.length > 0) {
      const first = turn.events[0];
      if (!first || first.seq >= target) break;
      const removed = turn.events.shift();
      const removedBytes = turn.eventBytes.shift() || 0;
      turn.bytesUsed = Math.max(0, turn.bytesUsed - removedBytes);
      if (removed) {
        turn.minSeq = Math.max(turn.minSeq, removed.seq + 1);
      }
    }
    turn.minSeq = Math.max(turn.minSeq, target);
  }

  private closeTurn(turn: TurnState, status: ResumableTurnStatus): void {
    if (turn.status !== "running") return;
    turn.status = status;
    turn.closedAtMs = Date.now();
    turn.updatedAtMs = turn.closedAtMs;
    const running = this.runningTurnBySession.get(turn.sessionId);
    if (running === turn.turnId) {
      this.runningTurnBySession.delete(turn.sessionId);
    }
  }

  private enforceTurnCaps(turn: TurnState): void {
    while (
      turn.events.length > this.options.maxEventsPerTurn ||
      turn.bytesUsed > this.options.maxTurnBytes
    ) {
      const removed = turn.events.shift();
      const removedBytes = turn.eventBytes.shift() || 0;
      turn.bytesUsed = Math.max(0, turn.bytesUsed - removedBytes);
      if (removed) {
        turn.minSeq = Math.max(turn.minSeq, removed.seq + 1);
      }
    }
  }

  private evictClosedTurnsForCapacity(): void {
    if (this.turnsById.size < this.options.maxActiveTurns) return;

    const closedTurns = Array.from(this.turnsById.values())
      .filter((turn) => turn.status !== "running")
      .sort((a, b) => {
        const aClosed = a.closedAtMs ?? Number.MAX_SAFE_INTEGER;
        const bClosed = b.closedAtMs ?? Number.MAX_SAFE_INTEGER;
        return aClosed - bClosed;
      });

    for (const turn of closedTurns) {
      if (this.turnsById.size < this.options.maxActiveTurns) break;
      this.turnsById.delete(turn.turnId);
    }
  }

  private garbageCollect(): void {
    const cutoff = Date.now() - this.options.ttlAfterCloseMs;
    for (const turn of this.turnsById.values()) {
      if (turn.status === "running") continue;
      if (!turn.closedAtMs || turn.closedAtMs > cutoff) continue;
      this.turnsById.delete(turn.turnId);
    }
    this.evictClosedTurnsForCapacity();
  }

  private prepareEventData(
    event: ResumableEventInput,
    maxBytes: number,
  ): {
    type: string;
    data?: unknown;
    source?: string;
    truncated: boolean;
    truncatedBytes: number;
  } {
    const type = String(event.type || "unknown");
    const source = event.source;
    const rawData = event.data;

    if (rawData === undefined) {
      return {
        type,
        data: undefined,
        source,
        truncated: false,
        truncatedBytes: 0,
      };
    }

    const serialized = JSON.stringify(rawData);
    const totalBytes = Buffer.byteLength(serialized, "utf8");
    if (totalBytes <= maxBytes) {
      return {
        type,
        data: rawData,
        source,
        truncated: false,
        truncatedBytes: 0,
      };
    }

    const budget = Math.max(128, maxBytes - 64);
    const truncatedText = serialized.slice(0, budget);
    return {
      type,
      source,
      data: truncatedEventPayload(type, rawData, truncatedText),
      truncated: true,
      truncatedBytes: totalBytes - budget,
    };
  }
}
