# No Disruptive Deployment Plan

## Problem Statement

Production deploys currently restart control-plane services in place (`mines-ai-api`, `cloud-sql-proxy`, `litellm-proxy`) on a single VM. During restart windows:

- Caddy returns `502`/`connection refused`.
- Sandbox callbacks to `/api/internal/*` fail.
- Foreground turns can error.
- Background goal runs may lose live-event delivery.
- Session manager can remain stuck in `busy` state, causing repeated `409 Conflict`.

This makes deploys user-visible and interrupts active work.

## Goals

1. Deploys do not interrupt active turns or goal runs.
2. No user-visible callback/API outage during planned deploy.
3. In-flight work resumes or completes without manual VM restart.
4. Deploy rollback is automatic when canary error budget is exceeded.

## Non-Goals

1. Migrating away from sandbox-per-agent GCE model.
2. Redesigning PI agent internals.
3. Adding token/cost budget policy.

## Root Causes To Eliminate

1. Single-node control plane restart causes hard callback outage.
2. API process crashes on DB proxy restart due unhandled pg pool errors.
3. No graceful drain before service replacement.
4. Session busy state is memory-local and can become stale after network/control-plane disruption.
5. SSE replay contract is absent, so reconnect can lose intermediate stream updates.

## Required Preconditions

### Staging environment

Before rollout, maintain a staging environment that mirrors production topology:

1. Same ingress + TLS pattern.
2. Same GCE sandbox callback path.
3. Same deploy scripts and service ordering.
4. Same DB proxy pattern.

No production rollout without staging pass.

## Target Architecture

### 1) Control plane redundancy

1. Run at least two control-plane nodes behind one HTTPS load balancer.
2. Use rolling deployment one node at a time.
3. Keep callback URL (`API_CALLBACK_URL`) pointed to LB host only.

Result: sandbox callbacks always have a healthy target.

### 2) Safe deploy lifecycle on each node

1. Set node to `draining` mode.
2. New chat requests return `503` with `Retry-After`.
3. Wait for active requests to complete.
4. Drain timeout is explicit: `90s` default (`DEPLOY_DRAIN_TIMEOUT_MS`).
5. If timeout exceeded, use escalation ladder:
   - If foreground turns remain: fail deploy by default (`DEPLOY_DRAIN_FORCE=false`).
   - If only goal runs remain: detach node from LB, keep process alive for existing in-flight client streams for goal grace period (`DEPLOY_GOAL_GRACE_MS`, default 30m).
   - If goal grace exceeded: mark running goals as `interrupted_by_deploy` and let reconciler resume on next node.
6. Stop API, then restart dependencies, then start API.
7. Rejoin LB only when readiness passes.
8. LB must use connection draining semantics so existing connections are allowed to finish; node removal from healthy pool must not hard-cut established streams.

Result: no forced termination of active requests.

### 3) Crash-proof DB/proxy behavior

1. Register `pool.on("error")` and `appPool.on("error")`.
2. Add connection validation/reacquire on transient disconnect.
3. Never terminate process only due to idle client disconnect.
4. Surface retryable DB transport errors as retriable HTTP/SSE errors.
5. Deployment ordering gate:
   - restart Cloud SQL proxy,
   - wait for DB readiness (`pg_isready` or equivalent query gate),
   - only then start API.

Result: DB proxy bounce does not crash API process.

### 4) Turn and goal continuity contract

1. Sandbox is turn executor of record.
2. API is stream relay and persistence.
3. Foreground/goal run lock has watchdogs:
   - foreground idle timeout (default `120s`)
   - foreground max timeout (default `900s`)
4. Lock heartbeat is explicit and independent of user-visible events:
   - heartbeat interval (`LOCK_HEARTBEAT_INTERVAL_MS`, default `30s`)
   - stale threshold (`LOCK_STALE_THRESHOLD_MS`, default `300s`)
5. Stale lock detection is DB-backed, not memory-only:
   - stale when no heartbeat for stale threshold.
   - on stale lock: abort run, mark failed, release lock.
6. Expose lock diagnostics in `/status` and deploy diagnostics endpoint.

Result: deploy-time blips do not leave permanent session lock.

### 5) Callback idempotency

All mutating `/api/internal/*` calls use idempotency keys:

1. `goal run start/end`: `goalId + runIndex + phase`.
2. `append-assistant`: `sessionId + runId + messageHash`.
3. `live-events`: `sessionId + runId + eventSeq`.

Server must dedupe as upsert/no-op on retries.

Result: retry storms do not duplicate state.

Callback retry contract:

1. LB retries callback `POST` on `503` to a healthy node.
2. Sandbox retries callback failures with bounded exponential backoff (1s, 2s, 4s).
3. Rolling deploy script must verify node N ready before draining node N+1.

### 6) SSE reconnect/replay

1. Emit monotonic event IDs in session live streams.
2. Support `Last-Event-ID` resume.
3. Keep replay buffer with dual bounds:
   - max duration (`SSE_REPLAY_MAX_DURATION_MS`, default 120s)
   - max size (`SSE_REPLAY_MAX_EVENTS` and/or `SSE_REPLAY_MAX_BYTES`)
4. If `Last-Event-ID` is too old (evicted), return explicit replay-miss response so client can reload full state.

Client reconnect contract:

1. Frontend stores last received SSE event ID per session.
2. Reconnect uses `Last-Event-ID` and exponential backoff.
3. UI shows explicit reconnecting state.
4. Replay-miss response triggers full session refresh.

Result: short disconnects/redeploys do not lose stream continuity.

### 7) LiteLLM availability

1. Treat LiteLLM as redundant component:
   - either sidecar per control node, or
   - independent rolling strategy with readiness gate and no shared single point restart.
2. API readiness fails if configured model backend is unreachable.

Result: deploying API nodes does not collapse model access.

## Readiness Contract (`/api/ready`)

A node is ready only when all checks pass:

1. DB connectivity check (`SELECT 1`) succeeds from both `pool` and `appPool`.
2. Required migrations are applied.
3. LiteLLM model list endpoint is reachable.
4. Node is not in `draining` mode.

## Rolling Compatibility Rule

Rolling deploy requires N/N+1 compatibility:

1. Schema changes must be backward-compatible for at least one release window.
2. Use expand-then-contract migrations (add first, remove later).
3. Prohibit breaking DDL in same release as code that depends on it (for example drop/rename columns used by live N node).

## Implementation Plan

### Phase A: Runtime resilience

1. Add pg pool error handlers and safe reconnect behavior.
2. Add structured metrics/logs and alerts:
   - callback 5xx rate,
   - sandbox `SessionBusyError` count,
   - goal run failure reasons,
   - deploy-window error rate.
3. Add foreground stale-lock watchdog + cleanup.
4. Convert sandbox 409 to explicit retriable API response (not generic 500).

Exit criteria:

- API no longer exits on transient DB disconnect.
- Stale busy lock auto-recovers without VM restart.

### Phase B: Deploy drain + readiness gates

1. Add deploy drain mode and `Retry-After`.
2. Add callback idempotency keys + dedupe for internal mutation routes.
3. Add callback retry contract (LB retry + sandbox retry backoff).
4. Add deploy quiescence gate:
   - active foreground turns,
   - active background goal runs.
5. Add explicit drain timeout behavior.
6. Enforce `/api/ready` contract before serving traffic.
7. Enforce node-by-node rollout hard gate (next node cannot drain until current node is ready + healthy for soak window).

Exit criteria:

- During rollout, no forced interruption of in-flight turns.
- Deploy fails safely if quiescence cannot be reached.

### Phase C: Multi-node rollout

1. Provision second control-plane node.
2. Place nodes behind LB.
3. Roll node-by-node with canary.
4. Keep callback and UI traffic LB-based.

Exit criteria:

- Rolling deploy with synthetic long turn + long goal shows no interruption.

### Phase D: Continuity hardening

1. Add SSE `Last-Event-ID` replay support.
2. Add frontend reconnect contract implementation.
3. Add internal endpoint for deploy/drain diagnostics.
4. Add run-state reconciliation to clear orphaned memory locks.

Exit criteria:

- No persistent “available but cannot send” state after deploy.
- Stream reconnect does not lose intermediate events within replay window.

## Validation Plan

Run in staging first, then production canary.

### Automated tests

1. integration: sandbox 409/busy recovery path.
2. integration: callback retry under temporary 502.
3. integration: deploy drain and quiescence timeout behavior.
4. integration: idempotent internal route retries.
5. e2e: active goal + reconnect with `Last-Event-ID`.
6. e2e: active foreground turn during rolling deploy.

### Manual GCP experiments

1. Start long foreground turn.
2. Start long background goal run.
3. Trigger deploy.
4. Verify:
   - no request interrupted unexpectedly,
   - no user-visible 500/502 on active sessions,
   - goal run continues/persists,
   - no stale busy lock.

## Rollback Plan

1. Keep previous release on standby.
2. Automatic rollback trigger (rate + absolute volume):
   - `/api/internal/*`: error rate > 5% AND >= 5 errors in 60s with >= 10 requests.
   - `/api/agent-chat/*`: error rate > 1% AND >= 3 errors in 30s with >= 10 requests.
3. On trigger:
   - halt rollout,
   - route traffic back to last healthy pool,
   - preserve sandbox VMs.
4. Require postmortem + error signature before reattempt.

## Operational SLOs and measurement

1. Deploy-window success rate >= 99.9% for `/api/agent-chat/*` and `/api/internal/*`.
2. Zero planned deploys causing platform-wide callback outage.
3. Zero manual sandbox VM restarts required to clear stale busy locks.

Measurement/alerting:

1. Export metrics to Cloud Monitoring (or Prometheus/Grafana equivalent).
2. Dashboard for deploy-window error budget and callback latency.
3. Pager alerts tied to rollback thresholds above.

## Ownership

1. API/runtime resilience: backend.
2. Deploy orchestrator and node drain: platform/ops.
3. Session-lock and replay continuity: sandbox runtime owner.
4. E2E continuity verification: QA + backend.

Escalation/RACI:

1. Deploy execution: Responsible `platform/ops`, Approver `backend lead`.
2. Rollback fired: Responsible `platform on-call`, Consulted `backend on-call`.
3. Stale-lock incident: Responsible `backend on-call`, Consulted `sandbox owner`.
4. Staging gate sign-off: Responsible `QA`, Approver `backend lead`.
