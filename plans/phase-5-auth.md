# Phase 5: Auth

## Status

complete

## Depends on

- Phase 4

## Delivered

- [x] Session middleware (`express-session`) with production guardrails.
  - `SESSION_SECRET` required in production.
  - Cookies are `HttpOnly`, `SameSite=Lax`, `secure` in production, scoped to `/api`.
  - Files: `src/middleware/session.ts`, `src/app.ts`

- [x] Auth middleware with two modes.
  - `AUTH_PROVIDER=none`: bypass auto-provisioning for dev/test.
  - `AUTH_PROVIDER=oidc`: session-backed OIDC auth.
  - Files: `src/middleware/auth.ts`, `src/config.ts`, `src/types/express.d.ts`, `src/types/session.d.ts`

- [x] Auth routes (`/api/auth/*`) with session fixation protection.
  - `GET /api/auth/login`, `GET /api/auth/callback`, `GET /api/auth/me`, `POST /api/auth/logout`.
  - OIDC includes state, nonce, PKCE, and cached discovery config.
  - Files: `src/routes/auth.ts`, `src/routes/schemas/auth.schema.ts`, `src/services/auth/oidc.ts`

- [x] Org/user provisioning and bootstrap path.
  - Domain-based org upsert + user upsert through `authBootstrapQuery`.
  - Files: `src/services/auth/provision.ts`, `src/db/index.ts`

- [x] Agent ACL enforcement (owner/editor/viewer).
  - Route-level ACL middleware on agents, agent-chat, and workspace endpoints.
  - Sharing endpoints implemented (`GET /:id/access`, `POST /:id/share`, `DELETE /:id/share/:userId`).
  - Atomic last-owner protection on revoke.
  - Files: `src/services/auth/acl.ts`, `src/routes/agents.ts`, `src/routes/agent-chat.ts`, `src/routes/workspace.ts`

- [x] Auth/ACL data backfill migration.
  - Seeds default bypass admin user and grants owner access on existing agents.
  - File: `src/db/migrations/0005_auth_backfill.sql`

- [x] Integration coverage for auth and ACL.
  - New suites: `src/routes/auth.integration.test.ts`, `src/routes/agents-acl.integration.test.ts`
  - Existing route integration tests updated for auth/ACL behavior.

- [x] Frontend auth wiring.
  - Auth context bootstrap via `/api/auth/me`.
  - Auto-redirect to `/api/auth/login` on 401.
  - Top bar shows authenticated user and logout action.
  - API client sends credentials and handles auth redirects.
  - Files: `client/src/contexts/AuthContext.tsx`, `client/src/App.tsx`, `client/src/components/TopBar.tsx`, `client/src/lib/api.ts`

## Deferred to Phase 6+

- Shared session store (Redis / connect-redis).
- Internal VM routes and VM token auth.
- Real-time multi-pod session sharing.
