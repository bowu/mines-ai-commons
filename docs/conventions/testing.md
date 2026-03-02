# Testing Conventions

## Test Types

| Type | File pattern | Command | Uses DB? |
|------|-------------|---------|----------|
| Unit | `*.test.ts` | `pnpm test` | No |
| Integration | `*.integration.test.ts` | `pnpm test:integration` | Yes (real Postgres) |
| Client | `client/src/**/*.test.{ts,tsx}` | `pnpm --filter mines-ai-commons-client test` | No |
| E2E | `e2e/**/*.spec.ts` | `pnpm test:e2e` | Yes (API + browser) |
| All (fast) | — | `pnpm test:all` | Both (no browser) |
| Full | — | `pnpm test:full` | Both + browser |

## Unit Tests

- Co-locate with source: `src/config.ts` → `src/config.test.ts`.
- Test pure functions and logic without external dependencies.
- Use `vitest` with `describe/it/expect`.

## Integration Tests

- Co-locate with routes: `src/routes/agents.ts` → `src/routes/agents.integration.test.ts`.
- Run against real Postgres via docker-compose (port 5435 locally, 5432 in CI).
- Global setup (`src/test/setup-integration.ts`) creates a fresh test DB and runs migrations.
- Use `cleanTable()` from `src/test/db-helper.ts` in `beforeEach` for per-test isolation.
- Use `supertest` to test HTTP endpoints through the Express app.
- Tests run serially to avoid DB conflicts.
- RLS-focused tests (`src/db/rls.integration.test.ts`) should execute queries with `SET LOCAL ROLE app_user` and explicit org context.

## E2E Tests

- Keep browser tests in `e2e/*.spec.ts` (Playwright).
- Avoid external-model/network dependency in CI flows (test UI + local API/DB behavior only).
- Use API-based setup/teardown helpers and an `"[e2e]"` prefix to avoid touching non-test records.
- Prefer stable role/text selectors scoped to specific regions (for example top navigation).

## Writing a New Integration Test

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import supertest from "supertest";
import { createApp } from "../app.js";
import { cleanTable } from "../test/db-helper.js";

describe("GET /api/your-route", () => {
  beforeEach(async () => {
    await cleanTable("your_table");
  });

  it("returns expected data", async () => {
    const app = createApp();
    const res = await supertest(app).get("/api/your-route").expect(200);
    expect(res.body).toHaveProperty("data");
  });
});
```

## Before Committing

```bash
pnpm lint && pnpm typecheck:all && pnpm test:all
```

For UI/system flows (or CI-parity locally), also run:

```bash
pnpm test:full
```
