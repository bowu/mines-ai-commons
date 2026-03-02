# AGENTS.md

AI agent contributor guide for Mines AI Commons — a university AI agent platform for Colorado School of Mines.

## Quick Start

```bash
corepack enable && pnpm install
pnpm dev   # auto-starts postgres, runs migrations, starts API :3001 + Frontend :5173
```

Prerequisites: Node.js 22 (`.nvmrc`), pnpm (Corepack), Docker.

## Verify Changes

```bash
pnpm lint && pnpm typecheck:all && pnpm test:all
pnpm test:full  # run before merge when browser flows changed
```

## Key Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | API + client with local infra |
| `pnpm dev:gce` | API + client + local LiteLLM proxy + Cloudflare tunnels for GCE sandbox testing |
| `pnpm sync:prompt` | Regenerate shared agent system prompt modules from `prompts/agent-system-prompt.yaml` |
| `pnpm sync:prompt:check` | Fail if generated prompt modules are stale vs YAML source |
| `pnpm pr` | Create a PR from current feature branch |
| `pnpm env:doctor` | Validate local deploy prerequisites and render prod secret payload (dry-run) |
| `pnpm run deploy` | Sync prod env secret from local `.env` + dispatch production deploy workflow |
| `pnpm smoke:prod` | Run basic external production smoke checks (`/`, `/api/health`, `/api/auth/login`) |
| `pnpm rollback -- --release-id <id>` | Dispatch production rollback workflow |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:integration` | DB-backed tests against real Postgres |
| `pnpm test:e2e` | Playwright browser tests (starts app + client + sandbox + local Postgres) |
| `pnpm e2e:install` | Install Playwright Chromium browser |
| `pnpm test:all` | Fast local suite: unit + integration + client + sandbox |
| `pnpm test:full` | Full suite: `test:all` + Playwright e2e |
| `pnpm lint` | Biome check |
| `pnpm typecheck:all` | Server + client type checks |
| `pnpm db:generate` | Generate SQL migrations from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply Drizzle migrations |
| `pnpm db:migrate-files` | Migrate `data/skills` + `data/workspaces` to org-prefixed paths |
| `pnpm db:reset` | Recreate Postgres volume + migrate |

## Project Map

| Path | What |
|------|------|
| `src/routes/` | Express route handlers (agents, skills, agent-chat, workspace) |
| `src/routes/auth.ts` | Auth endpoints (`/api/auth/*`) for bypass + OIDC flows |
| `src/db/schema.ts` | Drizzle schema source of truth (tables + RLS policies) |
| `src/db/migrations/` | Drizzle-kit generated/custom SQL migrations |
| `src/middleware/` | Error handler, validation |
| `src/lib/errors.ts` | Typed error classes (AppError, NotFoundError, etc.) |
| `src/services/` | Business logic (pi-agent, skills, web tools, sandbox lifecycle) |
| `src/services/auth/` | Auth provisioning, OIDC config, and ACL enforcement |
| `src/config.ts` | Typed env config — all env access goes through here |
| `client/src/components/` | React UI (shadcn/ui primitives in `ui/`) |
| `client/src/lib/api.ts` | Centralized API client |
| `sandbox/src/` | Sandbox runtime server + pi-agent execution wrappers |
| `ARCHITECTURE.md` | Full system architecture (do NOT modify without approval) |
| `PLAN.md` | Phase dependency order and status |
| `plans/` | Per-phase execution checklists and decisions log |

## Code Principles

- **Reuse before creating.** Search for existing functions, utilities, and patterns before writing new ones. Prefer refactoring shared code over duplicating logic.
- **Remove dead code.** Delete unused functions, imports, files, and dependencies. Don't comment out — delete.
- **Keep modules focused.** Routes handle HTTP. Services handle logic. `src/db/` handles data access. Don't mix concerns.
- **No mock data.** All features work with real data and real services.
- **Config via `src/config.ts`.** Never read `process.env` directly in routes or services.

## Conventions by Area

Detailed conventions live in focused files — read the relevant one before working in that area:

| Working on... | Read |
|---------------|------|
| Database queries or schema | `docs/conventions/database.md` |
| API routes or validation | `docs/conventions/routes.md` |
| Authentication and access control | `src/middleware/auth.ts`, `src/routes/auth.ts`, `src/services/auth/acl.ts` |
| Error handling | `docs/conventions/errors.md` |
| SQL migrations | `docs/conventions/migrations.md` |
| Tests | `docs/conventions/testing.md` |
| Frontend components | `docs/conventions/frontend.md` |
| Phase planning | `docs/conventions/phases.md` |

## Keep Docs in Sync

When your changes affect documented behavior, update the docs in the same commit:

| What changed | Update |
|--------------|--------|
| Tables, columns, RLS policies | `src/db/schema.ts` is source of truth; also update `docs/conventions/database.md` if conventions changed |
| API routes (add/remove/rename) | `docs/conventions/routes.md` |
| Migration workflow | `docs/conventions/migrations.md` |
| Test patterns or commands | `docs/conventions/testing.md` |
| Frontend components or patterns | `docs/conventions/frontend.md` |
| Key commands or project structure | This file (`AGENTS.md`) |
| Phase completion or new decisions | `PLAN.md` status + `plans/decisions.md` |
| Architectural changes (approved) | `ARCHITECTURE.md` |

If you add, remove, or rename a file listed in the Project Map above, update the table. If a convention doc references line numbers or function names that you changed, fix the references.

## Do Not

- Modify `ARCHITECTURE.md` without explicit approval.
- Add dependencies without clear justification.
- Commit `.env` files or credentials.
- Modify another phase's scope without coordination.
