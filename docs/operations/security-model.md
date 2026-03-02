# Security Model

## Purpose
This document defines the platform's security model, trust boundaries, and concrete security goals.
It is the source of truth for what we protect, from whom, and how.

Related:
- `security_hardening.md` (implementation roadmap)
- `ARCHITECTURE.md` (system architecture)

## System Context
Mines AI consists of:
- Control-plane API + frontend (single GCP VM)
- Cloud SQL (Postgres)
- Agent runtime VMs (GCE)
- CI/CD (GitHub Actions)
- External providers (LLM/search/email)

## Assets We Must Protect
1. Secrets and credentials:
- Provider keys
- Session/auth signing secrets
- VM bootstrap/internal auth secrets
- Cloud/service-account credentials

2. User data:
- Conversations, message history, tool outputs
- Workspace files and artifacts

3. Platform integrity:
- Control-plane code and deployment pipeline
- Agent lifecycle state and reconciler behavior

4. Cost/safety envelope:
- GPU/VM resource usage
- Outbound network behavior

## Trust Boundaries
1. Browser <-> Control-plane API
- Untrusted client boundary
- Enforced by auth, authorization, CSRF/session controls, input validation

2. Control-plane <-> Cloud SQL
- Trusted service boundary
- Enforced by least-privilege DB role + RLS

3. Control-plane <-> Agent VM
- Semi-trusted runtime boundary
- Agent code is treated as untrusted workload even if VM is user-associated
- GCE bootstrap identity is verified with instance identity tokens and bound claims:
  - service account email
  - project id
  - instance name
  - zone
- Internal VM API calls use signed, time-bound VM bearer tokens (`exp` bounded).
- VM token use is lifecycle-gated (`desired_vm_state`, `observed_vm_state`) and generation-gated.
- Token revocation uses `vm_token_generation` checks; delete/tombstone increments generation to invalidate old VM tokens immediately.
- Runtime readiness signals are intentionally split:
  - `runtimeHealthy`: sandbox process is serving
  - `controlPlaneConnected`: sandbox can authenticate/call control-plane successfully

4. Agent VM <-> External network
- High-risk egress boundary
- Must be explicitly controlled and monitored

5. CI/CD <-> Production
- Supply-chain boundary
- Enforced by protected environments, pinned workflows, least-privilege deploy identity

## Threat Model (Primary)
1. Credential exposure from agent runtime
- Agent-executed code reads env/files/metadata and exfiltrates secrets.

2. User-to-user data leakage
- One agent or session accesses another user's data via auth/ACL/RLS gaps.

3. Control-plane compromise via internal endpoints
- Forged VM/internal callbacks or replayed tokens.

4. Resource abuse
- Compromised account/agent causes runaway VM/GPU/API cost.

5. Deployment/supply-chain compromise
- Malicious/accidental deploy path introduces insecure config or leaked secrets.

## Security Principles
1. Least privilege everywhere
- Minimal IAM roles, DB privileges, and route-level permissions.

2. Defense in depth
- VM isolation plus in-VM restrictions and egress controls.

3. Fail closed
- Missing/invalid security configuration blocks startup or deploy.

4. Explicit trust and provenance
- Internal calls require strong identity + replay resistance.

5. Minimize secret exposure surface
- Keep long-lived provider credentials out of agent VMs.

## Security Goals
1. Agent VMs do not hold long-lived provider secrets.
2. Session/auth tokens are robust against replay and abuse.
3. Cross-tenant data isolation is enforced and test-verified.
4. Internal control-plane endpoints are authenticated and replay-resistant.
5. Outbound network from agent VMs is constrained to required paths.
6. CI/CD prevents unsafe deployments and secret regressions.
7. Security incidents are detectable and recoverable with tested runbooks.
8. Runtime health and control-plane credential connectivity are observed separately so recovery can be targeted without masking auth/connectivity failures.

## Control Objectives (Current Direction)
1. Credential isolation
- Route LLM/tool provider access through a controlled proxy/control-plane path.
- Agent VMs receive scoped, short-lived credentials only when needed.

2. Identity and access
- Strict ACL checks for agent/session routes.
- RLS-enforced org isolation at DB layer.
- Minimal IAM role split by runtime function.
- Internal VM endpoints require:
  - verified GCE bootstrap identity for credential bootstrap
  - VM token validation for ongoing internal API use
  - lifecycle + token-generation checks for replay/revocation resistance

3. Runtime containment
- Treat agent code as untrusted.
- Restrict VM egress and resource abuse paths.

4. Auth/session hardening
- Persistent production session store.
- Rate limiting on auth-sensitive routes.
- Single-use magic link semantics.

5. Deployment hardening
- Protected production environment in GitHub.
- Deterministic deploy/rollback procedures with smoke checks.

## Non-Goals
1. Full zero-trust redesign in one phase.
2. Real-time deep packet inspection for all VM egress.
3. Mandatory mTLS between control-plane and every agent VM in this phase.
4. Hardware attestation/confidential-computing guarantees in this phase.

## Validation Signals
Security model is considered effective when:
1. No provider keys are present in agent VM startup metadata/env.
2. Security regression tests pass in CI (auth/ACL/RLS/internal endpoint checks).
3. Production deploy checks and smoke tests pass with protected environment gates.
4. Baseline structured logging exists for internal VM endpoint failures and reconciler lifecycle transitions; security-oriented auth-failure logging expansion is tracked in `security_hardening.md` Phase 6.
5. Alerting on anomalous auth/token/VM patterns is implemented and validated (tracked in `security_hardening.md` Phase 6).

## Ownership
- Product/engineering owns this model.
- Any architecture/security behavior change must update this document and `security_hardening.md` in the same PR.
