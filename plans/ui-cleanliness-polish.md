# Plan: UI Cleanliness and Polish Pass

## Context

The sidebar redesign is functional, but it still feels denser and noisier than the visual quality in `example1.jpg` and `example2.jpg`.
The gap is not layout structure anymore; it is visual discipline and interaction polish.

This plan focuses on making the current UI feel cleaner, calmer, and more intentional without copying those references.

## Non-goals

- No backend feature changes.
- No auth/ACL behavior changes.
- No major IA rewrite (keep Wiki / Skills / Agents structure).
- No pink palette usage.

## Current Gaps (from review)

1. **Sidebar density is too high**
   - Agent rows show too many always-visible controls.
   - Action affordances compete with labels.
2. **Weak typography hierarchy**
   - Similar text sizes/weights across labels, metadata, and helper text.
3. **Inconsistent spacing rhythm**
   - Uneven paddings/margins across header, rows, cards, and tool blocks.
4. **Excessive surface/border noise**
   - Too many borders/chips/background variants in one viewport.
5. **Chat transcript clarity issues**
   - Tool/thinking traces visually compete with assistant answer content.
6. **Primary focus is diluted**
   - First-glance focal area is unclear on Agents and Skills pages.

## Design Direction

- **Tone**: quiet, editorial, utility-first.
- **Palette**: neutral/light surfaces with restrained accent (Mines blue/gold only for highlights).
- **Hierarchy**: content-first, controls-secondary.
- **Motion**: subtle, purposeful transitions only.
- **Density target**: reduce simultaneous visual elements by ~20-30% in sidebar + chat regions.

## Implementation Phases

### Phase 1: Foundation Tokens and Rhythm

Files:
- `client/src/index.css`

Tasks:
- Normalize spacing scale usage (single 4/8-based rhythm).
- Reduce border contrast and shadow count.
- Tighten semantic color tokens (`muted`, `accent`, `border`) for consistent low-noise surfaces.
- Define page-level max content widths and vertical rhythm rules.

Acceptance:
- Fewer one-off hex/tailwind arbitrary values in core layout components.
- Visual diff shows calmer contrast and cleaner grouping.

### Phase 2: Sidebar Declutter

Files:
- `client/src/components/AppSidebar.tsx`
- `client/src/contexts/AgentsContext.tsx` (if needed for hover/action state)

Tasks:
- Keep agent name/icon primary; hide row actions until hover/focus/active.
- Reduce row chrome (fewer visible separators/icons).
- Standardize row heights and text truncation.
- Improve footer hierarchy (name > email > sign out control).

Acceptance:
- At rest, each row shows icon + label + optional busy state only.
- Delete/config/new-conversation controls appear progressively, not constantly.

### Phase 3: Chat Readability and Focus

Files:
- `client/src/components/AgentsPage.tsx`
- `client/src/components/ChatView.tsx`
- `client/src/components/FilePreviewOverlay.tsx`

Tasks:
- Strengthen separation between message content and operational traces.
- De-emphasize tool/thinking blocks by default (collapsed summary chips + expandable details).
- Simplify header/toggle styling to reduce competition with conversation content.
- Improve composer prominence and breathing room.

Acceptance:
- Assistant/user answer text is dominant visual layer.
- Tool trace details remain accessible but not visually loud.

### Phase 4: Skills and Wiki Surface Consistency

Files:
- `client/src/components/WorkspaceView.tsx`
- `client/src/App.tsx`
- `client/src/components/SkillsPage.tsx` (if present)
- `client/src/components/WikiPage.tsx` (if present)

Tasks:
- Align page shell spacing and heading hierarchy across routes.
- Unify card/list patterns in Skills.
- Reduce frame mismatch around Wiki container and controls.

Acceptance:
- Route-to-route transitions feel like one product system.
- No abrupt style jumps between Agents/Skills/Wiki shells.

### Phase 5: Interaction and Motion Polish

Files:
- UI components touched above

Tasks:
- Add consistent 120-180ms transitions for hover/focus/open states.
- Ensure keyboard focus styles are visible but subtle.
- Tune empty/loading states to match overall tone.

Acceptance:
- Motion is noticeable but quiet.
- Keyboard navigation remains clear and accessible.

## Validation Checklist

1. Functional checks
   - Agent create/delete still works from sidebar.
   - Chat send/stream/stop behavior unchanged.
   - Skills CRUD and search unchanged.
   - Wiki embed actions unchanged.
2. Visual checks
   - Default viewport (1440px) and laptop (1280px) screenshots across 3 routes.
   - Mobile (390px) sidebar collapse and primary actions accessible.
3. Regression checks
   - `pnpm lint && pnpm typecheck:all`
   - `pnpm test`
   - `pnpm test:integration`
   - `pnpm exec playwright test`

## Delivery Strategy

- Ship as small, reviewable commits:
  1. Token/rhythm cleanup
  2. Sidebar declutter
  3. Chat readability
  4. Skills/Wiki consistency
  5. Motion/accessibility polish

- Keep each commit behavior-safe and reversible.

