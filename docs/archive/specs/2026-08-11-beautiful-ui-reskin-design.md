# Dispatch reskin on the Beautiful UI design language

**Date:** 2026-08-11 **Status:** Approved by Wyat (brainstorming session)
**Source:** <https://beautiful-ui-five.vercel.app/> ("Beautiful UI" — 19 crafted
primitives for AI-native interfaces, built by Turbo)

## Goal

Replace the feel of Dispatch's desktop app wholesale with Beautiful UI's design
language, and implement all 19 of its AI-native primitives as reusable Dispatch
components. This is one continuous effort (Wyat's explicit choice over a phased
rollout): tokens → existing-kit restyle → the 19 primitives + gallery → every
app surface → polish.

Decisions locked during brainstorming:

- **Target:** `apps/desktop` (the only UI; `packages/web` is retired). The
  marketing site (`apps/site`) is out of scope.
- **Fidelity:** adopt Beautiful UI's visual system wholesale — its palette,
  shadows, radii, type, and motion become Dispatch's. The current "zero-hue
  chrome" doctrine (neutral near-black accent) is retired; the accent becomes
  Beautiful UI blue.
- **Token architecture:** keep Dispatch's existing token _names_ (shadcn
  compatibility), swap in Beautiful UI _values_, and add new tokens only for
  concepts the current names cannot express.
- **Primitives location:** `apps/desktop/src/ui/ai/`, one file per primitive,
  props-driven, plus a dev-only Gallery view for visual review.

## 1. Design language & tokens

All changes land in `apps/desktop/src/styles/tokens.css` (and its
`tokens.test.ts`). Existing token names keep working; only values change.

### Value swaps (existing names)

| Dispatch token                  | Light                   | Dark      |
| ------------------------------- | ----------------------- | --------- |
| `--surface-page`                | `#fafafb`               | `#17181a` |
| `--surface-card`                | `#ffffff`               | `#232427` |
| `--surface-raised`              | `#f4f5f6` (BUI hover)   | `#2a2b2e` |
| `--surface-muted`               | `#f1f2f3` (BUI canvas)  | `#1c1d1f` |
| `--text-primary`                | `#1f2124` (ink)         | `#f2f3f4` |
| `--text-secondary`              | `#62656b` (ink-2)       | `#a5a8ad` |
| `--text-muted` / `--text-ghost` | `#9a9da3` (ink-3)       | `#6c6f75` |
| `--border-default`              | `#ecedef` (line)        | `#2e3033` |
| `--border-strong`               | `#e0e2e5` (line-strong) | `#3a3c40` |
| `--accent`                      | `#0285ff`               | `#3d9aff` |
| `--accent-hover`                | `#0170dd` (accent-ink)  | `#7ec0ff` |
| `--green`                       | `#189a4d`               | `#3dbb72` |
| `--amber` (BUI orange)          | `#ef720c`               | `#f68f3c` |
| `--red`                         | `#e3474c`               | `#ee5c61` |

Semantic `-bg` tints use BUI's tint system: opaque pastels in light mode
(`#e8f5ed`, `#fdf1e5`, `#fcecec`, accent `#e9f3ff`), **alpha overlays in dark
mode** (`#3dbb7224`, `#f68f3c24`, `#ee5c6124`, accent `#3d9aff29`) so tints sit
correctly on any surface. `-border` tokens stay derived via `color-mix` where
they already are.

### New tokens

- Surfaces: `--surface-hover` (`#f4f5f6`/`#2a2b2e`), `--surface-hover-strong`
  (`#e7e9eb`/`#313236`), `--surface-inset` (`#f7f8f9`/`#1f2022`), `--field`
  (`#f2f2f3`/`#2b2c2f`).
- Accent tint: `--accent-tint` (`#e9f3ff`/`#3d9aff29`).
- Shadow scale (light / dark variants exactly as extracted from the site):
  `--shadow-hairline`, `--shadow-btn`, `--shadow-card`, `--shadow-raised`,
  `--shadow-overlay`, `--shadow-inset-field`. All reference `--border-default` /
  `--border-strong` for their ring component.
- Radii: `--radius-chip: 6px`, `--radius-control: 8px`, `--radius-card: 10px`.
- Tooltip: `--tooltip-bg/fg/muted/border` (dark-on-light and darker-on-dark, as
  on the site).
- Type: `--font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace`,
  with font files self-hosted alongside Inter. Inter stays the sans face.
- Motion: `--ease-out-expo: cubic-bezier(.16, 1, .3, 1)` (BUI's `--ease-link`).

### Run-state palette (Dispatch extension)

The `RunDisposition` tokens keep their names and remap onto the new hues:

- working → accent blue (`--accent` / `--accent-tint`)
- waiting → orange, failed → red, review → green (new values above)
- landing → violet retuned to sit in the BUI family: `#6e5ce6` light / `#8f7ff2`
  dark, tint `#efecfd` light / `#8f7ff229` dark (alpha overlay, consistent with
  the tint system). BUI has four hues; landing keeps a distinct fifth tuned to
  match saturation/lightness.
- ready/blocked stay colorless (unchanged philosophy).

The per-project categorical palette (`--project-color-1..8`) is retuned for
harmony against the new surfaces but keeps eight distinguishable hues and the
deterministic assignment in `src/lib/projectColor.ts` (no API change).

### Global chrome

`global.css` updates: focus ring becomes accent-colored
(`outline: 2px solid var(--accent)`), replacing the contrast ring. Fluid root
font-size behavior is preserved unchanged.

## 2. The 19 primitives — `apps/desktop/src/ui/ai/`

One file per primitive. Pure presentational components: props in, DOM out; no
store imports, no tauri calls — wiring to live data happens in views/components
that adopt them. Named after the showcase, mapped to Dispatch jobs:

| #   | Primitive           | File                      | Dispatch job                                                                 |
| --- | ------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| 1   | Loading State       | `loading-state.tsx`       | Agent boot/working indicator: pixel-grid loader with shimmer + elapsed time  |
| 2   | Thinking            | `thinking.tsx`            | Expandable reasoning/steps/search/coding traces in session transcripts       |
| 3   | Streaming Text      | `streaming-text.tsx`      | Agent answers with inline sources, actions, follow-up suggestions            |
| 4   | Approval Card       | `approval-card.tsx`       | Human-in-the-loop questions (`ask_user`, scope requests) with option buttons |
| 5   | Tool Chips          | `tool-chips.tsx`          | Compact tool-call/code-edit chips with counts in transcripts                 |
| 6   | Task Rows           | `task-rows.tsx`           | Live run rows: running/failed/completed with progress detail                 |
| 7   | Chat                | `chat.tsx`                | Tabbed chat panel frame (reasoning replies + composer slot)                  |
| 8   | Prompt Bar          | `prompt-bar.tsx`          | Composer: @ source refs, / commands, model select, dictation affordance      |
| 9   | Recommendation Card | `recommendation-card.tsx` | Agent suggestion with confidence meter, alternatives, actions                |
| 10  | Context Cards       | `context-cards.tsx`       | Retrieved knowledge/evidence chunks with source + char counts                |
| 11  | Diff Table          | `diff-table.tsx`          | AI-proposed tabular edits (add/change/remove rows)                           |
| 12  | Records Table       | `records-table.tsx`       | CRM-style grid: tags, sorting, timestamps, strength indicators               |
| 13  | Filter Table        | `filter-table.tsx`        | Status-chip live filtering (To do / In progress / Completed)                 |
| 14  | Sidebar Nav         | `sidebar-nav.tsx`         | Workspace nav: search, task counts, categories                               |
| 15  | Search              | `search.tsx`              | Command search with live filtering + empty state                             |
| 16  | Insight Cards       | `insight-cards.tsx`       | Paged insights with scrubbable live charts                                   |
| 17  | Code Block          | `code-block.tsx`          | Line-by-line streaming code with syntax highlighting + copy                  |
| 18  | Fine-tune Card      | `fine-tune-card.tsx`      | Inspector: property adjustments (layout, radius, opacity, type)              |
| 19  | Selection Actions   | `selection-actions.tsx`   | Selection popover: Explain / Improve / Shorten / Tone / Grammar              |

Streaming/animated behavior (shimmer, line-by-line reveal, elapsed-time tick) is
implemented with CSS animations and rAF-driven hooks colocated in
`ui/ai/hooks.ts` where shared.

### Gallery (review surface)

A dev-only `GalleryView` (`src/views/GalleryView.tsx`) renders all 19 primitives
with realistic Dispatch-flavored mock data, in both light and dark, reachable
only in dev builds (registered in `App.tsx`'s view routing behind an
`import.meta.env.DEV` guard). E2E is blocked in the agent shell, so the gallery
is the surface handed to Wyat for visual sign-off at each checkpoint.

## 3. Existing kit restyle — `src/ui/` (36 primitives)

APIs unchanged; consumers don't churn. Styling updates:

- Most changes flow automatically from the token value swap.
- Targeted class updates: buttons/controls adopt `--shadow-btn` and
  `--radius-control`; cards/popovers/menus adopt `--shadow-card` /
  `--shadow-overlay` and `--radius-card`; chips/badges adopt `--radius-chip`;
  fields adopt `--field` + `--shadow-inset-field`; tooltips adopt the tooltip
  tokens.
- Focus rings become accent-colored throughout.
- `skeleton.tsx`/`spinner.tsx` align with the Loading State shimmer language.

## 4. Surface overhaul — views and feature components

Every surface adopts the language; where a primitive fits, the surface is
rebuilt on it rather than restyled in place:

- **Shell/sidebar** (`components/shell`) → Sidebar Nav.
- **BoardView** (kanban) → Filter Table interaction pattern + Task Rows.
- **TaskView / session transcript** (`components/sessions`, `components/runs`,
  `components/chat`) → Thinking, Streaming Text, Tool Chips, Code Block,
  Approval Card, Prompt Bar, Chat frame, Loading State.
- **AllAgentsView / SessionsHubView** → Task Rows.
- **TasksListView** → Records Table.
- **DiffModal / git surfaces** (`components/git`, `components/code`) → Diff
  Table, Code Block.
- **ImpactView / OverviewView** (`components/impact`, `components/overview`) →
  Insight Cards.
- **Command palette** (`ui/command.tsx` consumers) → Search.
- **InboxView** → Approval Card + Recommendation Card where agent
  questions/suggestions surface.
- **DraftView / BrainDumpView** → Selection Actions; PlansView
  (`components/plans`) → Context Cards where retrieved context shows.
- **Remaining views** (Milestones, Branches, Settings, Landing, GetStarted,
  Warden, PrReview) → restyled to the language (tokens/shadows/radii/type), no
  structural rebuild.

Fine-tune Card ships as a gallery-demonstrated primitive; its first in-app
adoption (e.g. a settings inspector) is not required by this spec.

## 5. Motion

- Standard easing `--ease-out-expo` for reveals, hovers, expandables.
- Shimmer for loading; line-by-line reveal for Code Block; streaming caret for
  Streaming Text; chip reorder animation in Filter Table.
- All animation honors `prefers-reduced-motion`.

## 6. Verification

- `tokens.test.ts` updated to the new token set (it guards token integrity).
- Per-area focused tests for primitives with meaningful logic (filtering,
  streaming hooks, selection actions); pure-visual primitives are covered by the
  gallery review, not snapshots.
- Baseline: `bun run format`, `bun run lint`, package-level `bun run tsc`,
  focused `bun run test` in changed packages. Playwright visual checks are
  handed to Wyat (agent shell can't spawn the webserver).
- Existing desktop tests must stay green; test updates that merely encode the
  new styling are expected and fine.

## 7. Sequencing (single effort, internal phases)

1. Tokens + fonts + global chrome (app instantly re-skins wholesale).
2. Existing `src/ui/` kit restyle.
3. The 19 primitives + Gallery → **visual checkpoint with Wyat**.
4. Surface overhaul, roughly shell → board/tasks → sessions/chat → tables/ diffs
   → insights → remaining views, with checkpoints per cluster.
5. Motion polish + reduced-motion pass + final gallery/app review.

## Out of scope

- `apps/site` (marketing) and `packages/demo` visuals.
- New backend/server capabilities; primitives are presentational and wire to
  existing data.
- Renaming the token vocabulary (explicitly rejected in favor of
  shadcn-compatible names).
