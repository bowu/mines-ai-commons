# Database Conventions

## Source of Truth

- `src/db/schema.ts` is authoritative for table/column/policy shape.
- Use `pnpm db:generate` to produce SQL migrations from schema changes.
- Keep raw SQL custom migrations for grants, seeding, and other non-schema steps.

## Query Layer

- Prefer Drizzle (`db` / `withOrgContext`) for new code.
- `withOrgContextQuery()` is allowed for incremental raw SQL paths.
- Route handlers must run tenant-facing queries under org context.

## Multi-Tenancy

- Every tenant-scoped query must run with `SET LOCAL app.current_org_id`.
- Use `withOrgContext(orgId, fn)` or `withOrgContextQuery(orgId, ...)` from `src/db/index.ts`.
- `nullif(current_setting('app.current_org_id', true), '')::uuid` is the fail-closed RLS expression.

## Pools and Roles

- `DATABASE_URL`: migration/superuser path.
- `APP_DATABASE_URL`: app path (`app_user` role) where RLS is enforced.
- `VM_INTERNAL_DATABASE_URL` and `AUTH_BOOTSTRAP_DATABASE_URL` are optional and used in later phases.

## Applying Changes

1. Edit `src/db/schema.ts`.
2. Run `pnpm db:generate`.
3. Add/adjust custom migration SQL when needed.
4. Run `pnpm db:migrate`.
5. Run `pnpm test:integration`.

## VM Reconciler Columns

- VM lifecycle is transitioning toward intent + observed state.
- `desired_vm_state`: route intent (`running` / `stopped`).
- `observed_vm_state`: reconciler-observed status (`running` / `starting` / `stopped` / `error`).
- `next_reconcile_at`: wake-up timestamp used by the reconciler scheduler.
- `reconcile_attempt_count`: retry backoff state for transient GCE errors.
- `startup_started_at`: when the current startup attempt began (used for startup watchdog recovery).
- `deleted_at`: tombstone marker for async VM/disk GC.
- `last_provision_error` and `last_provision_error_at`: informational diagnostics only.
- `machine_type`: owner-selected VM hardware profile for an agent.
- `needs_upgrade`: set when a running VM reports a stale runtime version; reconciler recreates on next wake.
- `upgrade_risk_detected` and `upgrade_risk_message`: marker-driven warnings that the VM was customized outside `/workspace` and may lose system-level installs on recreate.

## Chat Session Columns

- `agent_chat_sessions.model`: persisted per-conversation model selection (`gemini-3.1-pro`, `sonnet-4.6`, `opus-4.6`, `gpt-5.2`), default `gemini-3.1-pro`.
