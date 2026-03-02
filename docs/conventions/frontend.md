# Frontend Conventions

## Stack

React 19 + Vite 7 + Tailwind CSS 4 + shadcn/ui.

## Components

- Reuse existing UI primitives in `client/src/components/ui/` (shadcn/ui).
- Page-level components: `AgentsPage`, `ChatView`, `WorkspaceView`, `SkillsPage`, `TopBar`.
- Keep components focused — extract shared logic into hooks or utilities.

## API Calls

- All API calls go through `client/src/lib/api.ts`.
- Don't make fetch calls directly from components.

## State

- No global state library currently — components manage their own state.
- API data is fetched in components and passed down as props.

## Testing

- Test files use `*.test.ts` or `*.test.tsx` (both patterns are discovered).
- Use `vitest` with `jsdom` environment (configured in `client/vitest.config.ts`).
