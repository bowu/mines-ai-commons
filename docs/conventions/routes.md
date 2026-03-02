# API Route Conventions

## Structure

- Route modules live in `src/routes/`, one file per domain (agents, skills, agent-chat, workspace).
- Each file exports an `Express.Router`.
- Routes handle HTTP concerns only — delegate business logic to `src/services/`.
- Goal mode endpoints are split across:
  - user-facing `agent-chat` routes (`/api/agent-chat/sessions/:sessionId/goal`)
  - VM-only `internal` routes (`/api/internal/agents/:agentId/goals/*` and `/api/internal/agents/:agentId/sessions/:sessionId/*`)

## Input Validation

- Use Zod schemas defined in `src/routes/schemas/` (e.g., `agents.schema.ts`).
- Apply `validate()` middleware from `src/middleware/validate.ts` on JSON body routes.
- Multipart/multer routes: validate fields after multer parsing, not before.

## Auth and Org Context

- Protected routes run behind `authMiddleware` (wired in `src/app.ts`), which sets `req.user` and `req.orgId`.
- In route handlers, call `requireAuthContext(req)` from `src/middleware/auth.ts` to assert auth context before DB calls.
- Route-level DB access must use `withOrgContext(req.orgId, ...)` or `withOrgContextQuery(req.orgId, ...)`.
- New inserts into tenant tables must explicitly set `org_id`.
- Agent-scoped endpoints must use `requireAgentAccess(role)` middleware from `src/services/auth/acl.ts`.
- Admin-only operational endpoints (for example `POST /api/agents/runtime/upgrade`) must require auth and verify `req.user.role` (`admin` or `superadmin`) in-handler.
- Internal VM callback routes under `/api/internal` are mounted before session auth and must use VM credentials (`validateVmToken` or GCE identity token on bootstrap) plus per-agent rate limiting (`429` + `Retry-After`).

## Error Handling

- New route handlers should **not** wrap logic in try/catch.
- Throw `AppError` subclasses (from `src/lib/errors.ts`) and let the global error middleware handle responses.
- Legacy routes with inline try/catch are migrated gradually — don't rewrite them unless you're already modifying the handler.

## Response Format

- Success: return domain-specific JSON (e.g., `{ agents: [...] }`).
- Errors: the global error handler returns `{ error: { message, code } }`.

## SSE Endpoints

- `agent-chat.ts` uses Server-Sent Events for streaming.
- SSE handlers need their own error handling since headers are already sent — this is the one exception to the "no try/catch" rule.
