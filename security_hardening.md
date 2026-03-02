# Security Hardening Plan

## Scope
Harden Mines AI production security for:
- Control-plane API on single VM
- Agent sandbox VMs
- CI/CD and secrets handling
- Auth/session safety

This plan is ordered by risk reduction first, then operational hardening.

## Current Risks (Highest Priority)
1. Provider keys can be exposed through agent VM startup metadata/env (`GEMINI_API_KEY`, `BRAVE_API_KEY`, and any future provider creds).
2. Session storage in production uses MemoryStore (not safe for production reliability/security).
3. Runtime security controls (IAM, network egress limits, anomaly alerts) are incomplete.
4. Magic link tokens are currently stateless and reusable until expiry.
5. `SESSION_SECRET` leakage could allow forged sessions without a rotation playbook.

## Security Goals
1. Agent VMs never hold long-lived provider keys.
2. Key compromise blast radius is limited by short-lived scoped credentials.
3. Control-plane and deploy pipeline enforce least privilege and fail closed.
4. Security regressions are blocked by automated checks.

---

## Phase 0: Immediate Containment (Now)
### Actions
1. Rotate all potentially exposed secrets:
   - `GEMINI_API_KEY`
   - `BRAVE_API_KEY`
   - `VM_BOOTSTRAP_SECRET`
   - Any `AWS_*` credentials if ever set
   - `SESSION_SECRET` and `AUTH_MAGIC_LINK_SECRET`
2. Audit who/what has `compute.instances.get` and metadata read access.
3. Disable any unused credentials and remove stale service account keys.
4. Execute a session/key rotation playbook:
   - rotate `SESSION_SECRET` and auth signing keys
   - invalidate all active sessions
   - verify forced re-authentication behavior

### Exit Criteria
- All listed secrets rotated and redeployed.
- IAM audit complete with a documented access list.
- Secret/session rotation playbook is documented and tested.

---

## Phase 1: Remove Long-Lived Provider Keys From Agent VMs
### Target Model
- Agent VM calls a controlled inference proxy (LiteLLM proxy path).
- Real provider keys exist only in control-plane/proxy environment.
- Agent VM receives only short-lived scoped proxy credentials.

### Actions
1. Introduce proxy endpoint config in sandbox runtime (no direct provider key usage in VM).
2. Remove provider key injection from VM startup script and `/etc/default/mines-ai-sandbox`.
   - Includes `GEMINI_API_KEY`, `BRAVE_API_KEY`, and all `AWS_*` provider credentials.
3. Add short-lived token mint endpoint on control-plane:
   - VM authenticates with GCE identity token + VM token validation.
   - Token scope includes model allowlist, max budget, and TTL.
4. Ensure token revocation on agent delete/suspend and key rotation events.

### Exit Criteria
- Startup metadata for new agent VMs contains no provider secrets.
- Provider keys are absent from VM env files.
- Agent inference works through proxy using scoped short-lived token only.

---

## Phase 2: IAM and Identity Hardening
### Actions
1. Split service accounts by role:
   - Control-plane VM SA
   - Agent VM SA
   - CI/CD deploy SA (if used)
2. Enforce least privilege:
   - Agent VM SA: no broad Compute Admin permissions.
   - Control-plane SA: only required Compute/Cloud SQL permissions.
3. Remove legacy Owner/Editor grants for runtime identities.
4. Require Workload Identity/metadata-based auth where possible, avoid static SA keys.

### Exit Criteria
- IAM policy diff shows least-privilege roles only.
- No static long-lived SA keys required for runtime auth paths.

---

## Phase 3: Network Hardening
### Actions
1. Restrict agent VM egress:
   - Allow only required destinations (proxy/API/package mirrors if needed).
2. Restrict control-plane ingress to required ports (80/443) and internal management paths.
3. Lock internal endpoints (`/api/internal/*`) to strong VM auth + replay-resistant checks.
   - Make bootstrap and vm-ready flows nonce/expiry bound and single-use where applicable.
4. Keep Cloud SQL private connectivity path hardened (proxy + minimal access).

### Exit Criteria
- Firewall/egress rules documented and applied.
- Internal API endpoints reject unauthorized callers consistently.

---

## Phase 4: Session/Auth Hardening
### Actions
1. Replace production session MemoryStore with Redis or Postgres-backed store.
2. Keep cookie flags strict:
   - `Secure`, `HttpOnly`, `SameSite=Lax` (or stricter if compatible)
3. Add rate limits and abuse controls:
   - Magic link request endpoint
   - Login verification endpoint
4. Make magic links single-use:
   - store token hash + expiry + consumed timestamp in DB
   - mark consumed on first successful verify
   - reject replay attempts with explicit audit log
5. Add login anomaly logging (repeated failures, unusual source patterns).
6. Configure email authenticity for auth delivery:
   - SPF
   - DKIM
   - DMARC policy for the auth sender domain

### Exit Criteria
- No MemoryStore warning in production logs.
- Auth endpoints are rate-limited with verified behavior.
- Magic-link replay attempts are blocked by design.

---

## Phase 5: CI/CD Security Guardrails
### Actions
1. Add secret scanning in CI (block commits containing credentials).
2. Add dependency and container/image vulnerability scanning.
3. Enforce deploy-time env validation for required security vars.
4. Add post-deploy synthetic security+lifecycle check:
   - Login -> create agent -> wake -> ready -> chat -> cleanup
5. Add rollback trigger on failed post-deploy checks.
6. Configure GitHub production environment protections:
   - required reviewers for deploy approvals
   - restrict deploy branches to `main`
   - disallow unapproved deployment sources

### Exit Criteria
- CI blocks secret leakage and critical vulns by policy.
- CD automatically validates core secure lifecycle before marking deploy successful.
- Production deploys are gated by environment protection rules.

---

## Phase 6: Observability, Detection, and Incident Response
### Actions
1. Structured audit logs for:
   - Token mint/revoke
   - Internal VM callbacks
   - Reconciler failures and repeated retries
2. Alerting:
   - Spike in auth failures
   - Repeated VM bootstrap failures
   - Unexpected token issuance patterns
3. Create and test incident runbooks:
   - Credential leak response
   - Token compromise response
   - Emergency rollback + key rotation procedure

### Exit Criteria
- Alerts are live and tested.
- Runbook drill completed with documented timing/results.

---

## Implementation Order (Recommended)
1. Phase 0
2. Phase 1
3. Phase 4
4. Phase 2
5. Phase 3
6. Phase 5
7. Phase 6

Rationale:
- Remove key exposure first, then stabilize auth/session, then tighten infra and automation.

## Non-Goals
- Full multi-cluster orchestration migration
- Large architecture rewrite unrelated to credential isolation

## Success Definition
Security hardening is considered complete when:
1. No long-lived provider keys are present on agent VMs or VM metadata.
2. Production auth/session stack is persistent, rate-limited, and monitored.
3. IAM/network policies enforce least privilege with audited evidence.
4. CI/CD prevents secret regressions and validates secure lifecycle on each deploy.
