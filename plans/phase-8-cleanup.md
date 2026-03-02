# Phase 8: Cleanup

## Status

pending

## Depends on

- Phase 7

## ARCHITECTURE.md sections

- `16 Known implementation notes` (line 2555)
- `Implementation sequence -> Phase 8` (line 2655)
- `9.8 Relocated modules` (line 1306)

## Tasks (with acceptance criteria)

- [ ] Remove legacy in-API pi-agent runtime from control-plane package.
  - Acceptance criteria: API no longer owns runtime session/tool execution; sandbox path is sole execution path.
  - Files: `src/services/pi-agent/*`, route integrations
  - ARCH ref: section 9.8 line 1306 and phase 8 notes line 2655

- [ ] Remove host-local agent state directories from deployment/runtime assumptions.
  - Acceptance criteria: no dependence on `data/workspaces` or `data/agents` in production path.
  - Files: runtime config, docs, cleanup scripts
  - ARCH ref: section 5.4 line 345 and phase 8 notes

- [ ] Update local dev compose/process docs for sandbox-server-first workflow.
  - Acceptance criteria: local dev starts API + sandbox-server + client with one documented command flow.
  - Files: `docker-compose.yml`, `README.md`, scripts
  - ARCH ref: section 13 line 2487 and section 14.1 line 2508

- [ ] Final architecture/doc consistency review.
  - Acceptance criteria: no stale references to removed routes/features; plan files match implementation status.
  - Files: `ARCHITECTURE.md`, `PLAN.md`, `plans/*`, `README.md`
  - ARCH ref: sections 16 and 17

## Open Issues

- Decide final boundary between this repo and sandbox runtime package ownership.

## Decisions

- None yet.
