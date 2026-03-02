# Plan: Phase 6 — Sandbox Runtime + VM Integration

## Context

Currently the pi-coding-agent runs **in the same Node process** as the Express API. Agent tools (`bash`, `read`, `write`, `edit`) have full access to the host filesystem, environment variables, database credentials, and network. Phase 6 moves agent execution into **dedicated GCE VMs** per agent with a `sandbox-server` HTTP server wrapping pi-coding-agent.

This is the largest phase — it creates a new `sandbox/` package, adds GCE VM lifecycle management, proxies all chat+workspace through VMs, supports owner-driven machine profile changes, and adds idle monitoring.

### What already exists
- Multi-conversation sessions (Phase 5): `agent_chat_sessions`, session CRUD, per-session chat
- Auth + ACL: org isolation via RLS, agent_access table, `requireAgentAccess()` middleware
- Pi-agent session/stream/tools in `src/services/pi-agent/` (will be relocated to sandbox)
- Workspace routes reading host filesystem in `src/routes/workspace.ts`
- Agent share endpoints: `POST /:id/share`, `GET /:id/access`, `DELETE /:id/share/:userId`

### Key architecture decisions (from ARCHITECTURE.md)
- **One VM per agent** — all conversations share the same VM and workspace
- **Two-disk model** — ephemeral boot disk + persistent data disk at `/workspace`
- **SandboxClient abstraction** — `SANDBOX_MODE=local` (localhost:8888) vs `SANDBOX_MODE=gce` (VM IP:8888)
- **Machine profile changes** — owner updates machine type/accelerator profile; reconciler applies VM reconfiguration while preserving data disk
- **Idle shutdown** — 15min CPU / 60min GPU; suspend/stop with persistent disk
- **Advisory locks** — `pg_advisory_xact_lock` per agent for VM lifecycle serialization

---

## Commit 1: sandbox-server package

Create the standalone `sandbox/` package that runs inside VMs.

### 1.1 Package structure

```
sandbox/
├── package.json          # independent deps: pi-coding-agent, express, etc.
├── tsconfig.json
└── src/
    ├── sandbox-server.ts # HTTP server on port 8888
    ├── session.ts        # relocated from src/services/pi-agent/session.ts
    ├── stream.ts         # relocated from src/services/pi-agent/stream.ts
    └── tools.ts          # relocated from src/services/pi-agent/tools.ts (minus API-mediated tools)
```

### 1.2 sandbox-server.ts endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/chat` | Multi-session chat — `Map<sessionId, session>`, per-session 409 on concurrent turns |
| GET | `/status` | `{ busy, activeSessions, gpuNeeded }` for idle monitor |
| GET | `/health` | Startup probe |
| GET | `/files` | List workspace files |
| GET | `/file?path=...` | Read file |
| POST | `/upload` | Upload file |
| DELETE | `/file?path=...` | Delete file |
| POST | `/reconfigure-denied` | Notify session that machine profile change was denied |

### 1.3 Relocated modules

Move from `src/services/pi-agent/`:
- `session.ts` → `sandbox/src/session.ts` — remove org-context DB calls, read credentials from VM metadata
- `stream.ts` → `sandbox/src/stream.ts` — unchanged SSE event protocol
- `tools.ts` → `sandbox/src/tools.ts` — keep createCodingTools; API-mediated tools (web_search, wiki) call back to API via `/api/internal/*` using VM JWT

### 1.4 Machine profile tools

Add `request_machine_profile` and `release_machine_profile` tool definitions:
- `request_machine_profile`: agent requests a stronger machine profile → sends `machine_profile_request` SSE event to browser
- `release_machine_profile`: agent no longer needs elevated profile → clears machine-profile demand flag
- Track in `machineProfileSessions: Set<sessionId>`

### 1.5 Credential management

Sandbox-server reads from VM metadata on boot:
- `agent-id`, `api-callback-url`, `vm-token` (JWT for `/api/internal/*`)
- AWS STS credentials for Bedrock
- 50-minute refresh loop: `POST /api/internal/agents/:agentId/refresh-credentials`

### Verification
```bash
cd sandbox && pnpm install && pnpm build
# Local test: start sandbox-server, curl POST /chat, verify SSE events
```

---

## Commit 2: DB schema migration — VM columns on agents

### 2.1 Schema changes

**File:** `src/db/schema.ts` — add to `agents` table:

```typescript
machine_type: text("machine_type").default("e2-medium"),
vm_status: text("vm_status").default("stopped"),  // creating|running|starting|stopping|stopped|upgrading
vm_name: text("vm_name"),
vm_ip: text("vm_ip"),
vm_zone: text("vm_zone"),
data_disk_name: text("data_disk_name"),
vm_token_generation: integer("vm_token_generation").default(0),
last_activity_at: timestamp("last_activity_at", { mode: "date" }).defaultNow(),
```

### 2.2 Config additions

**File:** `src/config.ts`:
- `sandboxMode`: `optional("SANDBOX_MODE", "local")` — `"local"` | `"gce"`
- `gcpProjectId`, `gcpZone`, `vmTokenSecret`, `bedrockRoleArn`
- `sandboxLocalUrl`: `optional("SANDBOX_LOCAL_URL", "http://localhost:8888")`

### Verification
```bash
pnpm db:generate && pnpm db:migrate
pnpm lint && pnpm typecheck:all
```

---

## Commit 3: SandboxClient + GCE manager

### 3.1 GCE manager

**New file:** `src/services/sandbox/gce.ts`
- `createDataDisk(agentId, sizeGb)` — persistent disk `workspace-<agentId>`
- `createVM(agentId, machineType)` — from base image, attach data disk
- `startVM(agentId)` — start/resume stopped VM
- `stopVM(agentId)` — suspend when possible; stop fallback
- `deleteVM(agentId)`, `deleteDataDisk(agentId)`
- Uses `@google-cloud/compute` SDK
- In local mode: all functions are no-ops (sandbox-server runs locally)

### 3.2 SandboxClient

**New file:** `src/services/sandbox/client.ts`
- Mode switching: `SANDBOX_MODE=local` → `localhost:8888`, `SANDBOX_MODE=gce` → VM IP from DB
- Methods: `ensure(agentId)`, `chatStream(agentId, sessionId, req)`, `listFiles(agentId)`, `readFile(agentId, path)`, `uploadFile(agentId, path, data)`, `deleteFile(agentId, path)`, `status(agentId)`
- In local mode: all methods hit `http://localhost:8888` directly (no VM management)

### 3.3 Advisory lock utility

**New file:** `src/services/sandbox/lock.ts`
- `withAgentLock<T>(agentId, fn)` — `pg_advisory_xact_lock` from UUID hex halves
- Used by sandbox routes and idle monitor for per-agent serialization

### Verification
```bash
pnpm lint && pnpm typecheck:all
# Integration test: SandboxClient in local mode hits sandbox-server
```

---

## Commit 4: Sandbox routes + idle monitor

### 4.1 Sandbox routes

**New file:** `src/routes/sandbox.ts`

| Method | Path | Lock | Purpose |
|--------|------|------|---------|
| POST | `/:agentId/ensure` | Yes | Ensure VM running, create if needed |
| POST | `/:agentId/heartbeat` | No | Update `last_activity_at` |
| POST | `/:agentId/release` | No | Start idle timer immediately |
| POST | `/:agentId/machine-profile` | Yes | Trigger machine profile reconfiguration |


Register in `src/index.ts`: `app.use("/api/sandbox", sandboxRouter)`

### 4.2 Internal routes (VM callbacks)

**New file:** `src/routes/internal.ts`

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/agents/:agentId/wiki/search` | VM JWT | BookStack search proxy |
| GET | `/agents/:agentId/wiki/page/:id` | VM JWT | Read wiki page |
| POST | `/agents/:agentId/brave/search` | VM JWT | Brave search proxy (rate-limited) |
| POST | `/agents/:agentId/refresh-credentials` | VM JWT | STS + JWT refresh |

Middleware: `validateVMToken` — checks JWT signature, agentId match, `vm_status` in running/upgrading, `vm_token_generation` match.

Register in `src/index.ts`: `app.use("/api/internal", internalRouter)`

### 4.3 Idle monitor

**New file:** `src/services/sandbox/idle-monitor.ts`
- Background loop every 60s
- Leader election: `pg_try_advisory_lock(0)` — only one pod runs checks
- For each running agent idle > threshold: check `/status`, then suspend/stop/downgrade
- Idle thresholds: 15min CPU, 60min GPU
- All VM-mutating ops use `withAgentLock`

Start in `src/index.ts`: `startIdleMonitor()`

### Verification
```bash
pnpm lint && pnpm typecheck:all
pnpm test:integration  # test sandbox routes, advisory locks
```

---

## Commit 5: Modify existing routes to proxy through SandboxClient

### 5.1 agent-chat.ts changes

**File:** `src/routes/agent-chat.ts`
- Remove in-process pi-agent calls (`getPiSession`, `streamPiAgent`)
- New flow: `SandboxClient.ensure(agentId)` → `SandboxClient.chatStream(agentId, sessionId, { message, systemPrompt, skills, chatHistory })`
- Pipe SSE events from sandbox-server to browser (same event protocol)
- Keep: message persistence, session management, auto-title, file link sanitization
- Add: handle `machine_profile_request` event type → forward to browser SSE
- Add: handle `vm_starting` 503 → return retry hint to frontend

### 5.2 workspace.ts changes

**File:** `src/routes/workspace.ts`
- Replace host filesystem reads with `SandboxClient.listFiles()`, `readFile()`, `uploadFile()`, `deleteFile()`
- Add VM readiness check: `SandboxClient.ensure()` before each operation
- Return 503 with `retryAfterMs` if VM is starting
- Response shape unchanged — frontend doesn't change

### 5.3 agents.ts changes

**File:** `src/routes/agents.ts`
- `POST /api/agents` (create): after DB insert, call `gce.createDataDisk()` + `gce.createVM()` (in GCE mode)
- `DELETE /api/agents/:id` (delete): increment `vm_token_generation`, call `gce.deleteVM()` + `gce.deleteDataDisk()` (in GCE mode)
- In local mode: no VM lifecycle calls (sandbox-server is external)

### 5.4 Keep pi-agent files in API (Phase 8 removal)

`src/services/pi-agent/` stays in the API package for now — the sandbox package has its own copy. Full removal is Phase 8 cleanup.

### Verification
```bash
pnpm lint && pnpm typecheck:all
pnpm test:integration
# Manual: pnpm dev (SANDBOX_MODE=local, sandbox-server running) → create agent → chat → verify proxy works
```

---

## Commit 6: Frontend — VM status + machine profile selection

### 6.1 VM status indicator

**File:** `client/src/components/AgentsPage.tsx`
- Call `POST /api/sandbox/:agentId/ensure` on agent page mount
- Show spinner during VM startup (vm_status = starting/creating)
- Heartbeat interval: `POST /api/sandbox/:agentId/heartbeat` every 60s while page is active
- Handle 503 `vm_starting` responses: show "Agent is starting up..." with retry

### 6.2 Machine profile dialog

**File:** `client/src/components/AgentMachineProfileDialog.tsx` (new)
- Handle `machine_profile_request` SSE event in chat stream
- Show dialog: reason, suggested machine profile, estimated impact
- Apply change → `PUT /api/agents/:agentId` with machine profile fields
- Deny → dismiss dialog and keep current machine profile
- Show "Applying machine profile..." progress during VM reconfiguration

### 6.3 Machine profile badge

- Show machine profile badge on agent based on `machine_type` and accelerator flags
- Agent list includes `vm_status` and machine profile fields

### 6.4 API client additions

**File:** `client/src/lib/api.ts`
- `ensureSandbox(agentId)` → POST `/api/sandbox/:agentId/ensure`
- `sandboxHeartbeat(agentId)` → POST `/api/sandbox/:agentId/heartbeat`
- `updateAgentMachineProfile(agentId, payload)` -> PUT `/api/agents/:agentId`


### Verification
```bash
pnpm lint && pnpm typecheck:all && pnpm test
pnpm dev  # verify:
```
- Agent page shows VM status indicator
- Chat works through sandbox proxy
- Machine profile dialog appears on `machine_profile_request` event
- Heartbeat keeps VM alive during active use

---

## Files Summary

| Action | File | Commit |
|--------|------|--------|
| Create | `sandbox/package.json` | 1 |
| Create | `sandbox/tsconfig.json` | 1 |
| Create | `sandbox/src/sandbox-server.ts` | 1 |
| Create | `sandbox/src/session.ts` (relocated) | 1 |
| Create | `sandbox/src/stream.ts` (relocated) | 1 |
| Create | `sandbox/src/tools.ts` (relocated, modified) | 1 |
| Modify | `src/db/schema.ts` — VM columns on agents | 2 |
| Generate | `src/db/migrations/0007_*.sql` | 2 |
| Modify | `src/config.ts` — sandbox config vars | 2 |
| Create | `src/services/sandbox/gce.ts` | 3 |
| Create | `src/services/sandbox/client.ts` | 3 |
| Create | `src/services/sandbox/lock.ts` | 3 |
| Create | `src/routes/sandbox.ts` | 4 |
| Create | `src/routes/internal.ts` | 4 |
| Create | `src/services/sandbox/idle-monitor.ts` | 4 |
| Modify | `src/index.ts` — register new routes + idle monitor | 4 |
| Modify | `src/routes/agent-chat.ts` — proxy to sandbox | 5 |
| Modify | `src/routes/workspace.ts` — proxy to sandbox | 5 |
| Modify | `src/routes/agents.ts` — VM lifecycle on create/delete | 5 |
| Modify | `client/src/components/AgentsPage.tsx` — VM status + ensure | 6 |
| Create | `client/src/components/AgentMachineProfileDialog.tsx` | 6 |
| Modify | `client/src/lib/api.ts` — sandbox API functions | 6 |

**No changes to:** SkillsPage, WikiPage, AppSidebar, ChatView, WorkspaceView (response shapes unchanged).

---

## Local Development Flow

With `SANDBOX_MODE=local` (default):
1. Start sandbox-server separately: `cd sandbox && pnpm dev` (port 8888)
2. Start API + frontend: `pnpm dev` (port 3001 + 5173)
3. SandboxClient hits `localhost:8888` directly — no GCE calls
4. `ensure()` is a no-op in local mode (returns `{ status: 'ready' }`)
5. VM columns in DB exist but are ignored (vm_status stays 'stopped')

---

## Future (Phase 7+)

- Production single-VM control-plane deployment with real GCE sandboxes
- Cloud SQL, Memorystore Redis for session store + shared session pub/sub
- Golden VM images with machine-profile variants
- Cloud Monitoring alerts
- CI/CD pipeline
