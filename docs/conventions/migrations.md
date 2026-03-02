# Migration Conventions

## Workflow

- `pnpm db:generate` creates migration SQL from schema diffs.
- `pnpm db:migrate` applies migrations using Drizzle's journal (`__drizzle_migrations`).
- Do not edit migration journal metadata files manually unless absolutely necessary.

## Migration Types

- Generated migrations: table/column/index/policy diffs from `src/db/schema.ts`.
- Custom migrations: grants, role setup, seed/backfill data, one-off cleanup.

## Rules

- Never modify an already-applied migration in shared branches.
- Keep migrations forward-only.
- Put irreversible/destructive changes behind explicit approvals.
- Keep custom SQL idempotent where practical (`IF EXISTS`/`IF NOT EXISTS`).

## Runtime

- App startup calls `runMigrations()` from `src/db/migrate.ts`.
- Integration tests also run the same migration path in setup.
