# PLAN.md

Master execution index for post-Phase-0 delivery.

## Status

- Phase 0: complete
- Phase 4: complete
- Phase 5: complete
- Phase 6: complete
- Phase 7: pending
- Phase 8: pending

## Phase Dependency Graph

1. Phase 4 (Database + RLS)
2. Phase 5 (Auth + authorization)
3. Phase 6 (Sandbox runtime + VM integration)
4. Phase 7 (Deployment + operations)
5. Phase 8 (Cleanup + deprecation)

Dependencies:

- Phase 5 depends on Phase 4
- Phase 6 depends on Phase 4 and Phase 5
- Phase 7 depends on Phase 6
- Phase 8 depends on Phase 7

## ARCHITECTURE.md Mapping

- Plan Phase 4 -> `ARCHITECTURE.md` section `11.2 Multi-tenancy` (line 2126) and implementation sequence `Phase 3` DB tasks (lines 2596-2606)
- Plan Phase 5 -> `ARCHITECTURE.md` section `11.1 Authentication` (line 2113), section `8.10 Multi-user agent access` (line 939), and implementation sequence `Phase 4/5` (lines 2608-2629)
- Plan Phase 6 -> `ARCHITECTURE.md` sections `8` (line 432), `9.1-9.8` (lines 1019-1308), and `10.6` internal security model (line 1703)
- Plan Phase 7 -> `ARCHITECTURE.md` section `10` infrastructure (line 1395), `10.5` networking (line 1561), `10.7` ingress (line 2047), implementation sequence `Phase 7` (line 2643)
- Plan Phase 8 -> `ARCHITECTURE.md` section `16 Known implementation notes` (line 2555) and implementation sequence `Phase 8` (line 2655)

## Active Blockers

- Operational follow-up: production session store (Redis) is still pending.
- Operational follow-up: stable callback ingress/DNS is required for deployed GCE VM bootstrap flows.

## Decision Log

- Record all architecture and rollout decisions in `plans/decisions.md`.
