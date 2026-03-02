# Phase 4: Database + RLS

## Status

in_progress

## Depends on

- Phase 0 (complete)

## ARCHITECTURE.md sections

- `11.2 Multi-tenancy` (line 2126)
- `5.2 Multi-tenancy and multi-user tables` (line 248)
- `5.3 Schema changes for VM-backed agents` (line 324)
- `Implementation sequence -> Phase 3` (lines 2596-2606)

## Tasks (with acceptance criteria)

- [ ] Migration 005: create `organizations` and `users` tables with constraints and defaults.
  - Acceptance criteria: migration applies cleanly on empty DB and existing DB without data loss.
  - Files: `src/db/migrations/005_organizations_users.sql`
  - ARCH ref: section 11.2 line 2126

- [ ] Migration 006: add `org_id` to tenant-scoped tables (`agents`, `skills`, related tables as specified).
  - Acceptance criteria: all tenant-scoped records enforce org association; required foreign keys and indexes exist.
  - Files: `src/db/migrations/006_org_id_columns.sql`
  - ARCH ref: section 11.2 lines 2130-2148

- [ ] Migration 007: enable RLS and create per-table org isolation policies.
  - Acceptance criteria: queries through app role cannot read cross-org data even without `WHERE org_id`.
  - Files: `src/db/migrations/007_rls_policies.sql`
  - ARCH ref: section 11.2 lines 2149-2239

- [ ] Migration 008: create roles `app_user`, `internal_vm_user`, `auth_bootstrap_user` and grants.
  - Acceptance criteria: least privilege enforced; non-app roles cannot access unrelated tables.
  - Files: `src/db/migrations/008_db_roles_and_grants.sql`
  - ARCH ref: section 11.2 lines 2154-2184

- [ ] Migration 009: add functional indexes for normalized lookup (`LOWER(domain)`, `LOWER(email)`).
  - Acceptance criteria: index exists and is used on lowercased equality lookups.
  - Files: `src/db/migrations/009_normalized_lookup_indexes.sql`
  - ARCH ref: section 11.2 org/user lookup flow lines 2343-2351

- [ ] Refactor DB module to role-separated pools and query helpers.
  - Acceptance criteria: `appQuery`, `vmInternalQuery`, and `authBootstrapQuery` paths exist and are used by intended routes.
  - Files: `src/db/index.ts`, `src/config.ts`, route call sites
  - ARCH ref: section 11.2 lines 2257-2300

- [ ] Add transaction-wrapped org context helper for app queries.
  - Acceptance criteria: org context uses explicit transaction and `SET LOCAL app.current_org_id` before tenant query.
  - Files: `src/db/index.ts`
  - ARCH ref: section 11.2 lines 2270-2289

- [ ] Add integration tests for RLS isolation and role separation.
  - Acceptance criteria: tests prove app role cannot bypass RLS, internal role can access only allowed tables, auth role limited to org/user operations.
  - Files: `src/db/*.test.ts` (or dedicated integration folder + CI wiring)
  - ARCH ref: implementation sequence line 2606 and section 11.2

## Open Issues

- Decide migration strategy for pre-existing single-tenant data (`org_id` backfill policy).
- Confirm whether global platform skills remain `org_id = NULL` in Phase 4 or deferred.

## Decisions

- None yet.
