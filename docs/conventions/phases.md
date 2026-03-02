# Phase Planning Conventions

## Structure

- `PLAN.md` — master index with phase dependency graph and status.
- `plans/phase-N-*.md` — per-phase execution checklists with acceptance criteria.
- `plans/decisions.md` — log of architectural choices.

## Workflow

1. Check `PLAN.md` for dependency order and which phases are active.
2. Read your phase file (`plans/phase-N-*.md`) for specific tasks.
3. Each task has acceptance criteria, target files, and ARCHITECTURE.md references.
4. Update the phase file as tasks complete (check off items, update status).
5. Record architectural choices in `plans/decisions.md`.

## Rules

- Do not modify another phase's scope without coordination.
- Do not modify `ARCHITECTURE.md` without explicit approval.
- Phase files reference specific sections and line numbers in ARCHITECTURE.md — verify these are still accurate before starting work.
