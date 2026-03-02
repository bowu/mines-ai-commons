# Phase 6: Agent Sandboxes

## Status

complete

## Progress Notes (2026-02-22)

- Added `sandbox/` package with `sandbox-server` chat/files endpoints and workspace jailing.
- Added API `SandboxClient`, sandbox/internal routes, VM status columns, local-mode lifecycle handling, and idle monitor.
- Implemented GCE lifecycle operations (disk/VM create, start/stop, CPU<->GPU swap, delete) in `src/services/sandbox/gce.ts`.
- Hardened internal VM auth in `src/routes/internal.ts` with GCE identity-token verification, VM token generation checks, and per-agent rate limits with `Retry-After`.
- Added local-mode synchronous delete behavior to avoid stuck `vm_status='deleting'`.
- Updated workspace API proxying to cover all required operations (`list`, `read`, `upload`, `delete`, `mkdir`, `move`, `stats`).
- Verification completed with `pnpm lint`, `pnpm typecheck:all`, `pnpm test:all`, and `pnpm test:full`.

## Depends on

- Phase 4
- Phase 5

## ARCHITECTURE.md sections

- `8 Target architecture: GCE VM sandboxes` (line 432)
- `8.4 Sandbox-server specification` (line 578)
- `9.1-9.8 API code changes for VM integration` (lines 1019-1308)
- `10.6.2 Per-VM bearer tokens` (line 1766)
- `10.6.4 API-mediated tools` (line 1939)
- `Implementation sequence -> Phase 1 and Phase 2` (lines 2575-2595)

## Tasks (with acceptance criteria)

- [x] Implement `sandbox/sandbox-server.ts` runtime and SSE chat API.
  - Acceptance criteria: session creation, streaming updates, tool calls, and conflict handling follow spec.
  - Files: `sandbox/sandbox-server.ts`, `sandbox/*`
  - ARCH ref: section 8.4 line 578 and section 8.6 line 717

- [x] Implement `SandboxClient` and GCE manager modules.
  - Acceptance criteria: local mode and GCE mode supported; VM endpoint resolution works; retries/timeouts handled.
  - Files: `src/services/sandbox/client.ts`, `src/services/sandbox/gce.ts`
  - ARCH ref: sections 9.1 and 9.2 (lines 1019, 1063)

- [x] Add internal routes for sandbox callbacks and bootstrap credentials.
  - Acceptance criteria: JWT and identity-token validation enforced, scoped to agent.
  - Files: `src/routes/internal.ts`, auth middleware for internal routes
  - ARCH ref: section 9.10 line 1346 and section 10.6.2 line 1766

- [x] Implement VM lifecycle endpoints and state transitions.
  - Acceptance criteria: create/start/stop/delete and CPU<->GPU swap work without workspace data loss.
  - Files: `src/routes/sandbox.ts`, GCE manager module, DB state updates
  - ARCH ref: sections 8.2, 8.9, and 9.3-9.7 (lines 482, 832, 1088)

- [x] Add `validateVMToken` and `generateVMToken` utilities with rotation behavior.
  - Acceptance criteria: token generation, verification, and generation invalidation are tested.
  - Files: security/auth utility module, internal route middleware
  - ARCH ref: section 10.6.2 line 1766

- [x] Add per-agent rate limiting for credential and proxy endpoints.
  - Acceptance criteria: limits and `Retry-After` header behavior match documented values.
  - Files: `src/routes/internal.ts`, shared rate-limit utility
  - ARCH ref: section 10.6.4 lines 1939-2010

## Open Issues

- Decide whether sandbox-server remains in this repo or becomes separate package before Phase 7.
- Confirm CPU/GPU image names and rollout policy for first production run.
- Validate callback ingress continuously in deployed environments (quick tunnels are ephemeral).

## Decisions

- See `plans/decisions.md` entries dated 2026-02-22.
