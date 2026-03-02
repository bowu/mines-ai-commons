# Phase Plans

## Scope
This plan covers the remaining execution work from the current sandbox/reconciler architecture to stable single-VM production operations.

## Problems To Solve
1. VM lifecycle must be reliable, low-latency, and understandable for users.
2. Machine type transitions (CPU/GPU) must converge correctly without manual intervention.
3. Production deployment must be simple: one control-plane VM, TLS, automated deploy/rollback.
4. CI/CD must produce reproducible sandbox images and safe promotions.
5. Operations must have clear backup, restore, monitoring, and incident runbooks.

## Phase Summary
| Phase | Name | Status |
|---|---|---|
| A | Lifecycle foundation stabilization | Done |
| B | Machine-profile simplification + legacy GPU cleanup | Done |
| C | Single-VM runtime stack (API + UI + reverse proxy/TLS) | Done |
| D | Single-VM CI/CD deploy + rollback automation | Done |
| E | Data + operational reliability | Planned |
| F | Security and secret-hardening pass | Planned |
| G | Production cutover + soak + cleanup | Planned |

---

## Phase A: Lifecycle Foundation Stabilization
### Goals
- Make reconciler the clear owner of VM lifecycle decisions.
- Eliminate stuck-state and lock-stall behavior.
- Ensure user activity correctly prevents idle stop.

### Completed Outcomes
- Reconciler path active and legacy competing lifecycle paths removed from runtime flow.
- Per-agent processing bounded and non-blocking to avoid global reconcile stalls.
- Activity/lease behavior aligned with idle stop logic.

### Exit Criteria
- No manual DB status edits required during normal operation.
- Reconcile loop continues processing unaffected agents during single-agent failures.

---

## Phase B: Machine-Profile Simplification + Legacy GPU Cleanup
### Goals
- Make `machine_type` the single user-facing lever for compute profile.
- Remove obsolete GPU approval/state model.
- Ensure profile changes recreate VMs when required and preserve workspace disk.

### Completed Outcomes
- Removed legacy GPU approval route/model usage.
- Dropped dead GPU columns via migration.
- Reconciler detects actual-vs-desired machine profile mismatch and forces recreate.
- VM create path supports accelerator provisioning from machine-profile intent.
- `vm_status` dual-write alignment maintained for compatibility during transitions.

### Exit Criteria
- CPU -> GPU -> CPU transitions verified against real GCE instances.
- No stale legacy GPU flow in route/service paths.

---

## Phase C: Single-VM Runtime Stack (API + UI + Reverse Proxy/TLS)
### Decision
- Reverse proxy: **Caddy** (not Nginx) for automatic TLS and simpler ops.
- Production callback endpoint uses `API_CALLBACK_URL=https://mines-ai.com`.
- Cloudflare tunnel is dev-only and not part of production runtime.
- Cloud SQL Auth Proxy uses the VM-attached service account identity (no key file required).

### Goals
- Run control plane on one VM with deterministic boot and restart behavior.
- Serve frontend and API behind one TLS endpoint.
- Keep sandbox callback and public API domains stable.

### Implementation
1. Provision one production VM (Ubuntu 22.04 LTS) for control plane.
2. Install runtime: Node 22, pnpm, Docker (if needed for local deps), Caddy.
3. Build/release layout:
   - `/opt/mines-ai/releases/<sha>/` app release
   - `/opt/mines-ai/current` symlink
   - `/opt/mines-ai/shared/.env` shared environment
4. Systemd units:
   - `mines-ai-api.service` (server)
   - `cloud-sql-proxy.service` (database proxy)
   - `mines-ai-client.service` (if serving via Vite preview/Node static wrapper) or static build served directly by Caddy
   - `caddy.service`
5. Caddy config:
   - `mines-ai.com` and optional `www.mines-ai.com`
   - `/api/*` reverse proxy to `127.0.0.1:3001`
   - frontend static/site fallback for SPA routes
   - managed TLS via Let’s Encrypt
6. Health endpoints:
   - API: `/api/health`
   - Frontend: `/`
   - Optional ops endpoint for reconciler heartbeat

### Exit Criteria
- Fresh VM bootstrap reaches healthy state without manual edits.
- HTTPS cert auto-issues/renews.
- API and frontend available through one domain.
- Env validation fails fast with explicit missing variable errors before restart.

---

## Phase D: Single-VM CI/CD Deploy + Rollback Automation
### Goals
- Keep sandbox image pipeline and add automated app deployment to single VM.
- Make rollback one command/workflow, not manual patching.

### Implementation
1. Keep sandbox image workflows as source of truth:
   - build candidate
   - promote
   - rollback promote
   - retention cleanup
2. Add deploy workflow (`deploy-single-vm.yml`):
   - Trigger: push to `main` (or manual dispatch with SHA)
   - Steps: checkout -> lint/typecheck/tests -> package -> upload -> switch symlink -> restart services -> health check
3. Add rollback workflow (`rollback-single-vm.yml`):
   - Select previous release SHA
   - Repoint symlink
   - Restart services
   - Health check + confirm
4. Secrets/variables contract:
   - SSH private key / host / user
   - `GCP_PROJECT_ID`, `GCP_ZONE`, image vars
   - runtime env values injected from GH secrets

### Exit Criteria
- Main-to-prod deployment is automated and reproducible.
- Rollback completes in minutes and restores healthy service.

---

## Phase E: Data + Operational Reliability
### Goals
- Ensure recoverability and basic operational observability.

### Implementation
1. Database operations:
   - Scheduled backups
   - Tested restore procedure
   - Migration runbook for deploy pipeline
2. Runtime logs:
   - API + reconciler logs centralized (journald export or cloud logging)
   - Caddy access/error logs retained with rotation
3. Alerts:
   - API health failure
   - Reconciler repeated failures/backoff spikes
   - VM lifecycle failure rates (start/create/delete)
4. Runbooks:
   - “Agent stuck starting”
   - “VM recreate loop”
   - “Callback auth failures”

### Exit Criteria
- Backup/restore drill succeeds.
- Alert paths tested and routed.

---

## Phase F: Security and Secret Hardening
### Goals
- Minimize blast radius of leaked credentials.
- Remove unnecessary long-lived secrets from VM/runtime paths.

### Implementation
1. Secret inventory and ownership map.
2. Replace broad credentials with scoped identities where possible.
3. Rotate:
   - `VM_TOKEN_SECRET`
   - `VM_BOOTSTRAP_SECRET`
   - deploy keys/tokens
4. Enforce environment validation at startup (fail fast on missing critical vars).
5. Audit callback/internal routes for strict auth + rate limiting.

### Exit Criteria
- Rotation playbook tested in staging.
- No undocumented production secret dependencies.

---

## Phase G: Production Cutover + Soak + Cleanup
### Goals
- Cut over safely and remove temporary compatibility logic after stability window.

### Implementation
1. Staging soak with real workloads and idle/wake cycles.
2. Production cutover window with rollback checkpoint.
3. Post-cutover monitoring window (7+ days).
4. Remove temporary compatibility/dead code only after zero-drift evidence.

### Exit Criteria
- Stable uptime through soak window.
- No unresolved P1/P2 lifecycle incidents.
- Cleanup PR merged (legacy compatibility paths removed where still present).

---

## Test Gates (Every Phase)
1. `pnpm lint`
2. `pnpm typecheck:all`
3. `pnpm test:all`
4. Manual lifecycle matrix on real environment:
   - create agent -> wake -> chat
   - idle timeout -> suspend/stop
   - wake from stopped -> ready
   - machine type CPU<->GPU transitions
   - delete agent -> VM/disk cleanup
5. For deploy phases: end-to-end smoke through public domain over TLS.

## Non-Goals
- Migrating to GKE/Kubernetes.
- Adding multi-region failover in this cycle.
- Re-architecting sandbox execution away from per-agent VM model.
