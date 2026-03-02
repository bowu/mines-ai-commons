# Decisions Log

Track architecture and implementation decisions made during phased delivery.

## Template

- Date:
- Decision:
- Context:
- Alternatives considered:
- Rationale:
- Follow-up actions:

## 2026-02-20 - Drizzle-Kit Migration Authority

- Decision: Use `drizzle-kit` as the only migration mechanism (`db:generate`, `db:migrate`).
- Context: Previous custom migration runner and `schema_migrations` tracking diverged from Drizzle schema usage.
- Alternatives considered: keep raw SQL runner; hybrid (custom runner + generated SQL).
- Rationale: Single migration journal + schema-driven diffs are more predictable for agent-assisted implementation.
- Follow-up actions: keep custom SQL migrations only for grants/seed/indexes and role/bootstrap logic.

## 2026-02-20 - Multi-Tenant RLS Fail-Closed Context

- Decision: RLS policies use `nullif(current_setting('app.current_org_id', true), '')::uuid`.
- Context: Missing org context must not leak data.
- Alternatives considered: hard errors on missing setting; app-only filtering.
- Rationale: Missing/empty context resolves to `NULL`, yielding zero rows under equality checks.
- Follow-up actions: all tenant DB calls use `withOrgContext` or `withOrgContextQuery`.

## 2026-02-20 - Org-Prefixed Filesystem Layout

- Decision: Scope storage under org: `data/skills/<orgId>/<skillId>` and `data/workspaces/<orgId>/<agentId>`.
- Context: Existing path layout was single-tenant and unsafe under multi-tenancy.
- Alternatives considered: keep flat layout with naming prefixes; DB-only isolation.
- Rationale: explicit directory scoping prevents cross-org filesystem collisions and simplifies cleanup.
- Follow-up actions: run `pnpm db:migrate-files --dry-run` then `pnpm db:migrate-files` during rollout.

## 2026-02-21 - Phase 5 Auth Provider and Modes

- Decision: Implement OIDC as the production auth provider with a dev/test bypass mode.
- Context: Phase 5 required real authentication without breaking local development workflows.
- Alternatives considered: CAS-first implementation; SAML-first implementation; OIDC-only with no bypass.
- Rationale: OIDC fits current infrastructure and libraries, while bypass mode keeps local iteration simple and stable.
- Follow-up actions: add CAS/SAML adapters only if required by a specific institution.

## 2026-02-21 - App-Layer Agent ACL Enforcement

- Decision: Enforce owner/editor/viewer access in route middleware using `agent_access`, with mandatory integration tests.
- Context: Per-user RLS was deferred; org-level RLS is already in place.
- Alternatives considered: immediate per-user RLS in PostgreSQL policies.
- Rationale: route-level ACL is simpler to ship now and covered by integration tests; org isolation remains DB-enforced.
- Follow-up actions: revisit per-user RLS if stricter DB-level guarantees are needed.

## 2026-02-21 - Session Store Scope

- Decision: Keep `express-session` in-memory store for now; defer Redis-backed shared sessions to Phase 6.
- Context: Auth/ACL delivery was prioritized ahead of multi-pod session sharing.
- Alternatives considered: immediate Redis dependency in Phase 5.
- Rationale: lower implementation risk for this phase; acceptable for local and single-instance deployments.
- Follow-up actions: implement Redis session store before production multi-replica rollout.

## 2026-02-22 - Phase 6 Local-First Sandbox Cutover

- Decision: Cut chat/workspace execution over to the sandbox runtime in local mode first, while keeping GCE lifecycle operations scaffolded behind `SANDBOX_MODE=gce`.
- Context: Phase 6 required moving agent execution out of the API process and introducing VM lifecycle state, without blocking local/test workflows.
- Alternatives considered: complete GCE implementation before any route cutover; keep in-process runtime until full cloud provisioning is done.
- Rationale: local-first cutover reduces security exposure immediately (no in-process coding tools on API host) and allows full app/e2e validation of the new proxy path now.
- Follow-up actions: finish GCE manager operations, add identity-token verification for internal callbacks, and add per-agent rate limiting on internal endpoints.

## 2026-02-22 - Phase 6 Internal Auth and Lifecycle Hardening

- Decision: Complete Phase 6 with GCE lifecycle operations plus hardened internal VM callback auth and rate limiting.
- Context: The initial Phase 6 cutover left production-critical gaps in VM lifecycle behavior and internal-route security controls.
- Alternatives considered: defer hardening to Phase 7; keep bootstrap on shared secret only.
- Rationale: enforcing GCE identity-token bootstrap verification in `gce` mode, VM token generation checks, and per-agent `Retry-After` rate limits closes the highest-risk internal attack paths while preserving local-mode ergonomics.
- Follow-up actions: add distributed internal-route rate limiting before multi-pod production rollout and validate callback ingress through stable DNS/ingress instead of ephemeral tunnels.
