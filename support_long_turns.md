# Support Long Turns

## Problem

Long autonomous turns can run for a long time and emit large intermediate state.
Today this can cause:

1. Premature stream disconnects.
2. Lost in-progress output after refresh/reconnect.
3. Memory pressure from large in-memory replay buffers.

## Design (Simple Rule)

For each turn, do three things in parallel:

1. **Stream now**: send events to UI immediately.
2. **Checkpoint often**: persist partial turn state to DB every small interval/size.
3. **Trim memory**: after checkpoint, keep only a short replay tail in memory.

If reconnect happens, recover from:

1. in-memory tail (fast path), else
2. DB checkpoint + continue from last sequence.

This is the core fix. Everything else is supporting detail.

## Why This Is Simple And Elegant

1. One invariant: `turn_state = DB checkpoint + in-memory tail`.
2. One new persistence object: one checkpoint row per turn.
3. One recovery path: tail first, snapshot fallback.
4. One transport rule: backpressure-safe SSE writes.
5. Same model for foreground and background runs.

No new scheduler, no new queueing system, no Redis dependency in phase 1.

## Minimal Architecture

### 1) Turn sequence

Every streamed event gets monotonic `seq` per turn.

Ownership:

1. `seq` is assigned in API relay (`src/routes/agent-chat.ts`) as the single source of truth.
2. Sandbox emits events without `seq`.
3. API->browser and replay endpoints always use API-assigned `seq`.

### 2) Turn checkpoint row

Add one DB row per `(session_id, turn_id)` with:

1. `status` (`running|done|error|cancelled`)
2. `last_seq`
3. partial assistant state (`content`, `segments`, `tool_calls`)
4. timestamps

No event-level DB table needed.

Checkpoint cadence:

1. Every `2s`, or
2. Every `16KB` new assistant content, or
3. Turn terminal event.

### 3) Backpressure-safe SSE writes

All SSE writers must honor `res.write()` backpressure:

1. if write returns `false`, wait for `drain`,
2. stop on socket close,
3. keep heartbeats.
4. keep heartbeats on both legs:
   1. sandbox -> API
   2. API -> browser

Defaults:

1. Heartbeat interval: `15s` on both legs.

Overflow policy:

1. Keep bounded per-connection pending bytes (for example `1MB`).
2. If exceeded, end that slow connection and rely on resume (`fromSeq`) instead of unbounded buffering.
3. Never grow memory unbounded to preserve one slow client.

### 4) Timeout policy

1. No frontend hard timeout for running turns.
2. Backend uses inactivity timeout as primary guard.
3. Keep very high safety max runtime only as emergency guard.

## Implementation Steps

## Step 1: Transport hardening

Files:

1. `sandbox/src/sandbox-server.ts`
2. `src/routes/agent-chat.ts`

Changes:

1. Shared backpressure-aware SSE write helper.
2. Keep heartbeat frames during quiet periods on both streaming legs.
3. Enforce bounded per-connection write buffering with disconnect-on-overflow.

Outcome:

1. Long silent periods do not drop the stream.

Shippability:

1. Step 1 is independently shippable and should be released first.
2. It directly addresses `UND_ERR_BODY_TIMEOUT` without waiting for checkpoint features.

## Step 2: Checkpoint persistence

Files:

1. `src/db/schema.ts`
2. `src/db/migrations/*`
3. `src/routes/agent-chat.ts`

Changes:

1. Add `agent_chat_turn_checkpoints` table.
2. In `runResumableTurn`, aggregate events and flush by the cadence above.
3. Flushes must not block relay loop:
   1. run checkpoint writes async,
   2. keep a single in-flight flush guard,
   3. coalesce pending flush requests while one write is in flight.
4. Evict replay prefix only after flush commit succeeds.
5. On checkpoint DB write failure:
   1. do not evict memory,
   2. log error with turn/session ids,
   3. retry on next cadence tick.

Outcome:

1. Progress is durable before turn completion.

## Step 3: Recovery path

Files:

1. `src/routes/agent-chat.ts`
2. `client/src/lib/api.ts`
3. `client/src/components/AgentsPage.tsx`

Changes:

1. Add `GET /sessions/:sessionId/turns/:turnId/snapshot`.
2. On replay miss/too-old, client loads snapshot, renders it, then resumes from `last_seq + 1`.
3. Include running-turn partial output in `GET /sessions/:sessionId/messages`:
   1. read active checkpoint (if any),
   2. append a synthetic partial assistant message in response payload,
   3. include `turnId` metadata so client can continue the same turn.

Outcome:

1. Refresh never loses already produced output.

## Step 4: Memory bounding

Files:

1. `src/services/agent-chat/resumable-turn-store.ts`

Changes:

1. After checkpoint flush, evict flushed prefix from in-memory replay.
2. Keep only a small recent tail for fast reconnect.

Outcome:

1. Long turns no longer grow memory unbounded.

## Step 4.5: Checkpoint lifecycle cleanup

Files:

1. `src/routes/agent-chat.ts`
2. `src/services/agent-chat/resumable-turn-store.ts`
3. periodic cleanup job location used by existing maintenance tasks

Changes:

1. On successful final assistant message persistence, mark checkpoint finalized and delete it immediately (or soft-delete in same transaction if needed for audit window).
2. Add TTL cleanup for stale finished checkpoints as safety net.
3. Keep active/running checkpoints only.

Outcome:

1. No unbounded checkpoint table growth.

## Step 5: Apply same model to goal background runs

Files:

1. `sandbox/src/goal-session-manager.ts`
2. `src/routes/internal.ts`

Changes:

1. Background turns use the same checkpoint cadence.
2. Live stream remains immediate; persistence happens incrementally.

Outcome:

1. Foreground and background turns have the same reliability.

## What We Are Not Doing Now

1. Redis migration.
2. Event-sourcing every token to DB.
3. Major protocol redesign.

Redis can be added later for multi-instance fanout, but it is not required for this fix.

## Redis Decision

1. Redis does not solve oversized payloads or SSE backpressure.
2. Redis does not replace DB checkpoints for durable partial output.
3. Therefore, phase 1 does not add Redis.
4. Re-evaluate Redis only if we need multi-instance replay/fanout.

## Last-Event-ID Decision

1. We keep explicit `fromSeq` resume for turn streams (current design).
2. `Last-Event-ID` via `EventSource` is optional and can be evaluated later.
3. Not required for correctness because `fromSeq` already provides deterministic resume.

## Validation

Pass all three:

1. **Long silence test**: 30+ minutes with only heartbeat; no disconnect.
2. **Refresh test**: refresh mid-turn; output is preserved and streaming resumes.
3. **Large output test**: multi-MB turn; memory stays stable and no replay loss.
4. **Messages API test**: mid-turn `GET /sessions/:sessionId/messages` includes checkpointed partial assistant output.
5. **Flush concurrency test**: rapid stream events with slow DB writes do not block relay and do not produce out-of-order checkpoint state.

## Done Criteria

Done when:

1. Long turns no longer fail from transport inactivity.
2. Reconnect never drops already streamed content.
3. Memory remains bounded for long/high-volume turns.
4. Checkpoint storage remains bounded after turn completion.
