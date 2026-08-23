# Beautiful UI Reskin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the entire Dispatch desktop app onto the Beautiful UI design
language and implement its 19 AI-native primitives as reusable components.

**Architecture:** Token-value swap under Dispatch's existing token names
(shadcn-compatible), new tokens for BUI-only concepts (shadow scale, radii,
tints, hover/inset surfaces), a `src/ui/ai/` primitives library reviewed through
a dev-only Gallery view, then surface-by-surface adoption.

**Tech Stack:** React 19, Tailwind v4 (`@theme inline`), cva, radix-ui,
@fontsource, Bun test.

**Spec:** `docs/superpowers/specs/2026-08-11-beautiful-ui-reskin-design.md` —
read it first; its token tables are the source of truth for every hex value.

## Global Constraints

- Work happens in the worktree `../dispatch-worktrees/beautiful-ui-reskin`
  (branch `beautiful-ui-reskin`). Fresh worktree needs `bun install` &&
  `bun run build` before tsc/tests (`@dispatch/*` resolve via `dist/`).
- Reference assets: `.agents/ignore/beautiful-ui/bui.html` (full rendered
  showcase markup) and `bui.css` (its complete Tailwind bundle). When a task
  says "match the showcase", grep these — do not invent visuals. Sections appear
  in showcase order 01–19.
- Never restate palette hexes outside `styles/tokens.css`. `tokens.test.ts`
  enforces no hex literals in `tailwind.css`; extend that discipline to
  components (use tokens/utilities).
- All primitives in `src/ui/ai/` are presentational: props in, DOM out. No store
  imports, no tauri calls, no data fetching.
- Every animation honors `prefers-reduced-motion` (use the `motion-reduce:`
  Tailwind variant or a media query).
- Comments: terse, 1–2 lines max (Wyat's rule). No lint suppressions — fix
  findings for real.
- Per-task verification: `bun run format && bun run lint` from repo root,
  `bun run tsc` in `apps/desktop`, plus the task's focused tests. Commit at the
  end of every task.
- `AGENT=1` exported in every shell session.
- File naming in `ui/ai/`: kebab-case files, named PascalCase exports, prop
  types exported as `<Component>Props`.
- Icons come from `lucide-react` (already a dependency), sized via Tailwind
  `size-*` utilities.

---

### Task 1: JetBrains Mono font

**Files:**

- Modify: root `package.json` (workspaces.catalog: add
  `"@fontsource/jetbrains-mono"`, remove `"@fontsource/ibm-plex-mono"`)
- Modify: `apps/desktop/package.json` (swap dependency)
- Modify: `apps/desktop/src/main.tsx:12-13`

**Interfaces:**

- Produces: JetBrains Mono 400/600 self-hosted; `--font-mono` consumers pick it
  up after Task 2.

- [ ] **Step 1:** In root `package.json` catalog, replace the
      `@fontsource/ibm-plex-mono` entry with
      `"@fontsource/jetbrains-mono": "^5.2.5"` (match the version style of the
      other fontsource entries in the catalog). In `apps/desktop/package.json`,
      replace `"@fontsource/ibm-plex-mono": "catalog:"` with
      `"@fontsource/jetbrains-mono": "catalog:"`.
- [ ] **Step 2:** In `src/main.tsx` replace the two
      `@fontsource/ibm-plex-mono/*.css` imports with
      `import '@fontsource/jetbrains-mono/400.css';` and
      `import '@fontsource/jetbrains-mono/600.css';`.
- [ ] **Step 3:** `bun install` (note: bunfig `minimumReleaseAge=7d` — if
      install rejects the version, pick the newest version older than 7 days).
- [ ] **Step 4:** `bun run tsc` in `apps/desktop`; expect clean.
      `rg -n "ibm-plex" apps/desktop root package.json bun.lock` — no
      desktop-app references remain (lockfile entries for other packages are
      fine).
- [ ] **Step 5:** Commit: `feat(desktop): swap mono font to JetBrains Mono`

### Task 2: Rewrite tokens.css to the Beautiful UI palette

**Files:**

- Modify: `apps/desktop/src/styles/tokens.css` (full rewrite of color values;
  keep sizing/spacing/hairline/tracking sections untouched)
- Modify: `apps/desktop/src/styles/tokens.test.ts`

**Interfaces:**

- Produces: every existing token name with new values; new tokens
  `--surface-hover`, `--surface-hover-strong`, `--surface-inset`, `--field`,
  `--accent-tint`, `--shadow-hairline-ring`, `--shadow-btn`, `--shadow-card`,
  `--shadow-raised`, `--shadow-overlay`, `--shadow-inset-field`,
  `--radius-chip`, `--radius-control`, `--radius-card`, `--tooltip-bg`,
  `--tooltip-fg`, `--tooltip-muted`, `--tooltip-border`, `--ease-out-expo`.

- [ ] **Step 1 (failing test first):** Rewrite `tokens.test.ts` to guard the new
      system, then run it and watch it fail against the old file:

```ts
import { expect, test } from 'bun:test';

const tailwind = await Bun.file(
  new URL('./tailwind.css', import.meta.url)
).text();
const tokens = await Bun.file(new URL('./tokens.css', import.meta.url)).text();

// tailwind.css must only alias tokens.css — never restate the palette.
test('tailwind.css declares no hex literals', () => {
  const hexes = tailwind.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  expect(hexes).toEqual([]);
});

// The reskin's keystone: the accent is Beautiful UI blue in both themes.
test('--accent is Beautiful UI blue', () => {
  expect(tokens).toContain('--accent: #0285ff');
  expect(tokens).toContain('--accent: #3d9aff');
});

// New concepts the reskin introduces must exist in both theme blocks where
// they carry per-theme values.
const perTheme = [
  '--surface-hover:',
  '--surface-inset:',
  '--field:',
  '--accent-tint:',
  '--tooltip-bg:',
  '--shadow-btn:',
  '--shadow-card:',
  '--shadow-overlay:',
];
test('reskin tokens exist in light and dark blocks', () => {
  for (const t of perTheme) {
    const count = tokens.split(t).length - 1;
    expect(count).toBeGreaterThanOrEqual(2);
  }
});

// Radii and easing are theme-invariant — exactly one declaration each.
test('structural tokens declared once', () => {
  for (const t of [
    '--radius-chip:',
    '--radius-control:',
    '--radius-card:',
    '--ease-out-expo:',
  ]) {
    expect(tokens.split(t).length - 1).toBe(1);
  }
});
```

Run: `bun test src/styles/tokens.test.ts` in `apps/desktop`. Expected: FAIL
(accent + new tokens missing).

- [ ] **Step 2:** Rewrite the color sections of `tokens.css`. Light `:root`
      values (keep the existing comment style but rewrite comments to describe
      the BUI system, not the old zero-hue doctrine):

```css
--surface-page: #fafafb;
--surface-card: #ffffff;
--surface-raised: #f4f5f6;
--surface-muted: #f1f2f3;
--surface-hover: #f4f5f6;
--surface-hover-strong: #e7e9eb;
--surface-inset: #f7f8f9;
--field: #f2f2f3;

--text-primary: #1f2124;
--text-secondary: #62656b;
--text-muted: #9a9da3;
--text-ghost: #9a9da3;

--border-default: #ecedef;
--border-strong: #e0e2e5;
--border-selected: #0285ff;

--accent: #0285ff;
--accent-hover: #0170dd;
--accent-contrast: #ffffff;
--accent-tint: #e9f3ff;
--accent-muted: #e9f3ff;
--accent-subtle: #f4f9ff;
--accent-border: color-mix(in srgb, var(--accent) 32%, var(--surface-card));

--project-color-1: #4c8fd6;
--project-color-2: #2ba06a;
--project-color-3: #a86bc9;
--project-color-4: #d08a2e;
--project-color-5: #6a7bd9;
--project-color-6: #7fa63b;
--project-color-7: #d65f86;
--project-color-8: #2f9fb3;

--green: #189a4d;
--green-bg: #e8f5ed;
--green-border: color-mix(in srgb, var(--green) 34%, var(--green-bg));

--blue: #0285ff;
--blue-bg: #e9f3ff;
--blue-border: color-mix(in srgb, var(--blue) 34%, var(--blue-bg));

--red: #e3474c;
--red-bg: #fcecec;
--red-border: color-mix(in srgb, var(--red) 34%, var(--red-bg));

--amber: #ef720c;
--amber-bg: #fdf1e5;
--amber-border: color-mix(in srgb, var(--amber) 34%, var(--amber-bg));

--violet: #6e5ce6;
--violet-bg: #efecfd;
--violet-border: color-mix(in srgb, var(--violet) 34%, var(--violet-bg));

--gray: #62656b;
--gray-bg: #f1f2f3;
--gray-border: #e0e2e5;

--tooltip-bg: #25272b;
--tooltip-fg: #f6f7f8;
--tooltip-muted: #a5a8ad;
--tooltip-border: #3a3c40;

--shadow-hairline-ring: 0 0 0 1px var(--border-default);
--shadow-btn: 0 0 0 1px var(--border-strong), 0 1px 2px #1018280d;
--shadow-card:
  0 0 0 1px var(--border-default), 0 1px 2px #1018280a, 0 2px 6px #10182808;
--shadow-raised: 0 0 0 1px var(--border-default), 0 2px 10px #0000000b;
--shadow-overlay: 0 0 0 1px var(--border-default), 0 8px 28px #0001;
--shadow-inset-field: inset 0 1px 2px #0000001f;

--radius-chip: 6px;
--radius-control: 8px;
--radius-card: 10px;

--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
```

Run-state block keeps its structure; only the `working`/`landing` references
change:

```css
--state-working-fg: var(--accent);
--state-working-surface: var(--accent-tint);
--state-working-edge: var(--accent-border);
/* waiting → amber, failed → red, review → green: unchanged references */
--state-landing-fg: var(--violet);
--state-landing-surface: var(--violet-bg);
--state-landing-edge: var(--violet-border);
```

(`--state-landing-*` previously referenced `--blue`; violet takes over so blue
reads as "working/accent". `--blue` stays for diff meaning-color.) `--font-mono`
becomes `'JetBrains Mono', ui-monospace, 'SF Mono', monospace`. Keep
`--overlay`/`--overlay-light`, sizing, tracking, hairline, and spacing sections
exactly as they are.

- [ ] **Step 3:** Rewrite the dark block (same media query):

```css
--surface-page: #17181a;
--surface-card: #232427;
--surface-raised: #2a2b2e;
--surface-muted: #1c1d1f;
--surface-hover: #2a2b2e;
--surface-hover-strong: #313236;
--surface-inset: #1f2022;
--field: #2b2c2f;

--text-primary: #f2f3f4;
--text-secondary: #a5a8ad;
--text-muted: #6c6f75;
--text-ghost: #6c6f75;

--border-default: #2e3033;
--border-strong: #3a3c40;
--border-selected: #3d9aff;

--accent: #3d9aff;
--accent-hover: #7ec0ff;
--accent-contrast: #ffffff;
--accent-tint: #3d9aff29;
--accent-muted: #3d9aff29;
--accent-subtle: #3d9aff14;
--accent-border: color-mix(in srgb, var(--accent) 40%, var(--surface-card));

--project-color-1: #6faae2;
--project-color-2: #46bd84;
--project-color-3: #bd8ad8;
--project-color-4: #e0a54e;
--project-color-5: #8b98e8;
--project-color-6: #9dc25b;
--project-color-7: #e07d9e;
--project-color-8: #55b9cc;

--green: #3dbb72;
--green-bg: #3dbb7224;
--blue: #3d9aff;
--blue-bg: #3d9aff29;
--red: #ee5c61;
--red-bg: #ee5c6124;
--amber: #f68f3c;
--amber-bg: #f68f3c24;
--violet: #8f7ff2;
--violet-bg: #8f7ff229;
--gray: #a5a8ad;
--gray-bg: #ffffff0e;
--gray-border: #3a3c40;

--tooltip-bg: #111214;
--tooltip-fg: #f2f3f4;
--tooltip-muted: #a5a8ad;
--tooltip-border: #2e3033;

--shadow-btn: 0 0 0 1px var(--border-strong), 0 1px 2px #0000004d;
--shadow-card:
  0 0 0 1px var(--border-default), 0 1px 2px #0003, 0 2px 6px #0003;
--shadow-raised: 0 0 0 1px var(--border-default), 0 2px 10px #00000038;
--shadow-overlay: 0 0 0 1px var(--border-strong), 0 8px 28px #00000057;
--shadow-inset-field: inset 0 1px 2px #0006;
```

Dark
`--green-border`/`--red-border`/`--amber-border`/`--violet-border`/`--blue-border`
keep their `color-mix` derivations (delete any literal dark `-border` overrides
so the light-block `color-mix` recomputes from dark inputs — check the existing
file: green/blue/gray declare literals in dark; replace with nothing so
derivation flows, EXCEPT `--gray-border` which stays literal as above).

- [ ] **Step 4:** Run `bun test src/styles/tokens.test.ts`. Expected: PASS.
- [ ] **Step 5:** `bun run format && bun run lint` (root), `bun run tsc`
      (apps/desktop). Commit:
      `feat(desktop): retheme tokens to Beautiful UI palette`

### Task 3: Tailwind aliases + global chrome

**Files:**

- Modify: `apps/desktop/src/styles/tailwind.css`
- Modify: `apps/desktop/src/styles/global.css:44-50` (focus ring)

**Interfaces:**

- Produces: utilities `bg-surface-hover`, `bg-surface-hover-strong`,
  `bg-surface-inset`, `bg-field`, `bg-accent-tint`, `text-tooltip-fg` etc.,
  `shadow-btn`, `shadow-card`, `shadow-raised`, `shadow-overlay`,
  `shadow-inset-field`, `rounded-chip`, `rounded-control`, `rounded-card`,
  `ease-out-expo`. All primitives and surface tasks consume these.

- [ ] **Step 1:** In `tailwind.css` `@theme inline`, add (keeping the
      only-aliases rule):

```css
--color-surface-hover: var(--surface-hover);
--color-surface-hover-strong: var(--surface-hover-strong);
--color-surface-inset: var(--surface-inset);
--color-field: var(--field);
--color-accent-tint: var(--accent-tint);
--color-tooltip-bg: var(--tooltip-bg);
--color-tooltip-fg: var(--tooltip-fg);
--color-tooltip-muted: var(--tooltip-muted);
--color-tooltip-border: var(--tooltip-border);

--radius-chip: var(--radius-chip);
--radius-control: var(--radius-control);
--radius-card: var(--radius-card);

--shadow-btn: var(--shadow-btn);
--shadow-card: var(--shadow-card);
--shadow-raised: var(--shadow-raised);
--shadow-overlay: var(--shadow-overlay);
--shadow-inset-field: var(--shadow-inset-field);

--ease-out-expo: var(--ease-out-expo);
```

Note: `--radius-chip: var(--radius-chip)` in `@theme inline` is
self-referential-looking but correct — the theme variable reads the `:root`
token of the same name (the existing `--shadow-hairline: var(--hairline)`
pattern; if Tailwind rejects the same-name alias, rename the token side, not the
utility side). Also change `--sh-accent: var(--accent-muted)` to
`--sh-accent: var(--surface-hover)` — shadcn's subtle hover fill must stay
neutral now that `--accent-muted` is a blue tint.

- [ ] **Step 2:** In `global.css`, change the focus ring to accent:

```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}
```

Also update the comment (the "no hue left to spend" rationale is obsolete).

- [ ] **Step 3:** Launch the dev app briefly (`bun run dev` in apps/desktop, or
      rely on tsc if the shell can't) and confirm no Tailwind build errors. Run
      `bun test src/styles/tokens.test.ts` (hex-literal guard still passes).
- [ ] **Step 4:** `bun run format && bun run lint`, `bun run tsc`. Commit:
      `feat(desktop): tailwind utilities + accent focus ring for reskin`

### Task 4: Restyle the existing ui kit (36 primitives)

**Files:**

- Modify: everything in `apps/desktop/src/ui/*.tsx` (not `ui/chrome/`, not new
  `ui/ai/`)

**Interfaces:**

- Consumes: Task 3 utilities. APIs unchanged — no consumer churn.

- [ ] **Step 1:** Sweep with these mappings (grep each pattern across
      `src/ui/`):
  - Buttons/controls (`button.tsx`, `toggle.tsx`, `toggle-group.tsx`,
    `select.tsx` triggers, `native-select.tsx`, `dropdown-menu.tsx` triggers):
    base `rounded-md` → `rounded-control`; `outline` variant gains `shadow-btn`
    and drops `shadow-xs`; `default` variant:
    `bg-primary text-primary-foreground hover:bg-primary/90` stays (primary is
    now blue — correct).
  - Cards/popovers/menus/dialogs (`dialog.tsx`, `alert-dialog.tsx`,
    `popover.tsx`, `dropdown-menu.tsx` content, `command.tsx`, `sheet.tsx`,
    `select.tsx` content): content containers get `rounded-card shadow-overlay`
    (drop `border` where the ring in `shadow-overlay` replaces it; keep
    structural layout classes).
  - Fields (`input.tsx`, `textarea.tsx`, `input-group.tsx`):
    `bg-field shadow-inset-field rounded-control` replacing `border-input` +
    `shadow-xs` combos; focus stays ring-based (ring color is already `--ring` →
    accent).
  - Chips (`badge.tsx`, `kbd.tsx`): `rounded-chip`.
  - `tooltip.tsx`: content → `bg-tooltip-bg text-tooltip-fg` with
    `shadow-overlay rounded-control`; remove the current fill classes.
  - `skeleton.tsx`: pulse fill `bg-surface-hover-strong`.
  - `tabs.tsx`: active tab gets `bg-surface-card shadow-btn rounded-control`
    (segmented-control look — check showcase chat tabs in `bui.html` for
    reference).
- [ ] **Step 2:** `rg -n "shadow-xs|rounded-md" apps/desktop/src/ui/*.tsx` —
      remaining hits must be deliberate (document any keeper in the commit
      message).
- [ ] **Step 3:** Run desktop tests: `bun run test` in `apps/desktop` (expect
      some class-assertion updates in existing view tests — update those
      assertions to the new classes; behavior assertions must not change).
- [ ] **Step 4:** `bun run format && bun run lint`, `bun run tsc`. Commit:
      `feat(desktop): restyle ui kit to Beautiful UI language`

### Task 5: Gallery scaffold

**Files:**

- Create: `apps/desktop/src/views/GalleryView.tsx`
- Create: `apps/desktop/src/views/galleryStories.tsx`
- Modify: `apps/desktop/src/lib/appNav.ts:50` (GlobalView union)
- Modify: `apps/desktop/src/App.tsx` (render GalleryView; register a
  command-palette entry gated by `import.meta.env.DEV`)
- Modify: `apps/desktop/src/components/shell` sidebar (dev-only Gallery nav
  entry, same gate)

**Interfaces:**

- Produces:
  `type GalleryStory = { id: string; title: string; note?: string; render: () => ReactNode }`
  and `export const galleryStories: GalleryStory[]` in `galleryStories.tsx`.
  Every primitive task appends stories here.

- [ ] **Step 1:** Add `'gallery'` to the `GlobalView` union. `GalleryView`
      renders a two-column page (`bg-surface-page`): sticky index of story
      titles on the left, story sections on the right, each section a
      `bg-surface-card rounded-card shadow-card` frame with the story title +
      optional note above. Include a header row with the count ("N primitives").
- [ ] **Step 2:** Seed `galleryStories.tsx` with one placeholder story rendering
      existing `Button` variants so the view is verifiable now (replaced
      organically as primitive stories land).
- [ ] **Step 3:** Wire App.tsx rendering (`navState.globalView === 'gallery'`)
      and the dev-gated nav/command entries. Non-dev builds must not reference
      the view: guard with `import.meta.env.DEV &&`.
- [ ] **Step 4:** Write `src/views/GalleryView.test.tsx`: renders all stories'
      titles; run it (bun test). Verify dev app shows the gallery.
- [ ] **Step 5:** Format/lint/tsc. Commit:
      `feat(desktop): dev-only primitive gallery`

### Tasks 6–24: The 19 primitives

Shared conventions for every primitive task (repeat NOT restated per task — this
block is normative):

- File in `apps/desktop/src/ui/ai/`, named export(s), exported `<Name>Props`.
- Match the showcase: find the section in `.agents/ignore/beautiful-ui/bui.html`
  (search by the visible heading text noted per task) and port
  structure/classes, translating BUI token vars to Dispatch utilities:
  `--canvas`→`bg-surface-muted`, `--surface`→`bg-surface-card`,
  `--inset`→`bg-surface-inset`, `--ink`→`text-foreground`,
  `--ink-2`/`--ink-3`→`text-muted-foreground` (shadcn aliases), plus the Task 3
  utilities (`bg-surface-hover`, `bg-field`, `bg-accent-tint`, `shadow-*`,
  `rounded-*`). Where no utility exists, `[color:var(--token)]`-style arbitrary
  values sparingly — never hex literals.
- Each task appends one or more stories to `galleryStories.tsx` with realistic
  Dispatch-flavored mock data (agents, runs, tasks, repos — not ice cream),
  covering every visual state listed.
- Logic (anything beyond markup: timers, filtering, streaming, selection math)
  is extracted into pure functions or hooks and unit-tested TDD-style: write the
  failing test, watch it fail, implement, watch it pass. Pure-visual markup is
  verified via the gallery, not snapshots.
- Each task ends: format/lint/tsc + `bun test` for its test file + commit
  `feat(desktop): add <name> primitive`.

### Task 6: Loading State

**Files:** Create `ui/ai/loading-state.tsx`, `ui/ai/use-elapsed.ts`,
`ui/ai/use-elapsed.test.ts`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `LoadingState({ label, startedAt, variant = 'grid' }: { label: string; startedAt?: number; variant?: 'grid' | 'orbit' })`;
  `useElapsed(startedAt?: number): string` returning `"0:07"`-style mm:ss (hours
  as h:mm:ss).
- Showcase heading: "Loading state" (pixel-grid loader, shimmer label, elapsed
  time).

- [ ] Test `formatElapsed(ms)` (pure, exported from `use-elapsed.ts`):
      `formatElapsed(7_000) === '0:07'`, `formatElapsed(61_000) === '1:01'`,
      `formatElapsed(3_661_000) === '1:01:01'`. TDD cycle.
- [ ] Implement: 3×3 pixel grid of `size-[3px]` cells animating opacity in a
      staggered loop (CSS keyframes, `motion-reduce:animate-none`); shimmer
      label via background-clip gradient sweep; `useElapsed` ticks with
      `setInterval` 1s, cleaned up on unmount. `orbit` variant: three dots
      orbiting (the showcase's DriveDotsOrbit).
- [ ] Gallery stories: grid + orbit, one with `startedAt` 90s ago.
- [ ] Verify + commit.

### Task 7: Thinking

**Files:** Create `ui/ai/thinking.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `Thinking({ steps, collapsed, onToggle, elapsedLabel }: ThinkingProps)` where
  `steps: ThinkingStep[]`,
  `type ThinkingStep = { kind: 'reasoning' | 'search' | 'coding' | 'step'; label: string; detail?: string; state: 'done' | 'active' | 'pending' }`.
- Showcase heading: "Thinking".

- [ ] Port: collapsed row = muted chip with shimmer label + chevron; expanded =
      vertical step list, each row an icon per `kind` (lucide: `Brain`,
      `Search`, `Code`, `Circle`), `state==='active'` row shimmers, done rows
      `text-muted-foreground`, connecting hairline between rows. Expand/collapse
      animates height with `ease-out-expo`, `motion-reduce:transition-none`.
- [ ] Gallery stories: collapsed active, expanded mixed-state (reasoning done,
      search active, coding pending).
- [ ] Verify + commit.

### Task 8: Streaming Text

**Files:** Create `ui/ai/streaming-text.tsx`, `ui/ai/use-streamed-text.ts`,
`ui/ai/use-streamed-text.test.ts`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `StreamingText({ text, streaming, sources, followUps, onFollowUp, actions }: StreamingTextProps)`;
  `sources: Array<{ id: string; label: string; href?: string }>` render as
  inline numbered chips; `followUps: string[]` as suggestion buttons below;
  `actions?: ReactNode` slot (copy etc.).
  `useStreamedText(full: string, opts?: { cps?: number; enabled?: boolean }): string`
  reveals progressively.
- Showcase heading: "Streaming text".

- [ ] TDD `nextSlice(full, shown, charsPerTick)` pure helper
      (word-boundary-aware reveal): revealing never splits a word; reveal of
      complete string returns full.
- [ ] Implement hook on rAF/interval; caret block (`▍`-style, animated, hidden
      when done or reduced-motion); source chips
      `rounded-chip bg-surface-inset text-muted-foreground hover:bg-surface-hover`
      with superscript index; follow-ups as
      `rounded-control shadow-btn bg-surface-card hover:bg-surface-hover`
      buttons.
- [ ] Gallery stories: mid-stream, complete-with-sources+followups.
- [ ] Verify + commit.

### Task 9: Approval Card

**Files:** Create `ui/ai/approval-card.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `ApprovalCard({ question, detail, options, onSelect, selectedId, disabled }: ApprovalCardProps)`;
  `options: Array<{ id: string; label: string; description?: string; recommended?: boolean }>`.
- Showcase heading: "Approval card".

- [ ] Port: card `bg-surface-card rounded-card shadow-card`; agent question
      header with icon; option rows as radio-style buttons (`rounded-control`,
      hover `bg-surface-hover`, selected `bg-accent-tint` + `border-selected`
      ring, recommended gets an accent-tinted "Recommended" chip); footer
      confirm row appears once selected. Keyboard: options focusable, Enter
      selects.
- [ ] Gallery stories: unanswered, selected, disabled (answered) states.
- [ ] Verify + commit.

### Task 10: Tool Chips

**Files:** Create `ui/ai/tool-chips.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces: `ToolChip({ icon, label, meta, state, onClick }: ToolChipProps)`
  with `state: 'running' | 'done' | 'failed'`;
  `ToolChipGroup({ children, overflowCount }: { children: ReactNode; overflowCount?: number })`.
- Showcase heading: "Tool chips".

- [ ] Port: inline-flex chip `rounded-chip bg-surface-inset text-xs` with icon,
      mono `meta` (e.g. `+24 −3`), running chips shimmer, failed chips
      `text-red bg-red-bg`; group renders "+N" overflow chip.
- [ ] Gallery stories: mixed states row incl. overflow.
- [ ] Verify + commit.

### Task 11: Task Rows

**Files:** Create `ui/ai/task-rows.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `TaskRow({ title, agent, state, detail, progress, elapsedLabel, onClick, actions }: TaskRowProps)`
  with `state: 'running' | 'waiting' | 'failed' | 'done' | 'queued'`;
  `TaskRowList({ children }: { children: ReactNode })` (frame with hairline
  dividers).
- Showcase heading: "Task rows".

- [ ] Port: dense rows; leading state dot using run-state tokens
      (`running`→`text-state-working`, `waiting`→`text-state-waiting`,
      `failed`→`text-state-failed`, `done`→`text-state-review`,
      `queued`→`text-state-ready`), running dot pulses; title + muted `detail`
      line that live-updates (shimmer while running); trailing elapsed mono
      label and hover-revealed `actions`. Failed rows tint `bg-red-bg/50`.
- [ ] Gallery stories: list of 5 covering all states.
- [ ] Verify + commit.

### Task 12: Chat

**Files:** Create `ui/ai/chat.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `ChatPanel({ tabs, activeTabId, onSelectTab, onNewTab, children, composer }: ChatPanelProps)`;
  `tabs: Array<{ id: string; label: string; unread?: boolean }>`;
  `ChatMessage({ role, children, avatar }: { role: 'user' | 'agent'; children: ReactNode; avatar?: ReactNode })`.
- Showcase heading: "Chat".

- [ ] Port: panel frame `bg-surface-card rounded-card shadow-card` with top tab
      strip (segmented chips, active `bg-surface-card shadow-btn`, unread dot),
      scrollable message area (user messages right-aligned
      `bg-surface-inset rounded-card` bubbles; agent messages full-width plain),
      `composer` slot pinned bottom.
- [ ] Gallery story: two-tab panel, mixed messages, PromptBar placeholder box in
      composer slot (real PromptBar wired in its own story).
- [ ] Verify + commit.

### Task 13: Prompt Bar

**Files:** Create `ui/ai/prompt-bar.tsx`, `ui/ai/prompt-bar.test.tsx`; modify
`galleryStories.tsx`.

**Interfaces:**

- Produces:
  `PromptBar({ value, onChange, onSubmit, references, onRemoveReference, commands, models, modelId, onModelChange, disabled, placeholder }: PromptBarProps)`;
  `references: Array<{ id: string; label: string; icon?: ReactNode }>` (chips
  above input); `commands: Array<{ id: string; label: string; hint?: string }>`
  (popover filtered when value starts with `/`);
  `models: Array<{ id: string; label: string }>`.
- Showcase heading: "Prompt bar".

- [ ] TDD `matchCommands(commands, value)` pure helper: `'/re'` matches label
      prefixes case-insensitively; non-`/` input returns `[]`.
- [ ] Implement: container `bg-field shadow-inset-field rounded-card`
      focus-within accent ring; auto-growing textarea (rows 1–8); reference
      chips removable; footer row: model select (existing `ui/select.tsx`), mic
      icon-button (affordance only — `onClick` optional prop), submit
      icon-button (accent fill, disabled when empty); `/` opens command popover,
      Enter submits, Shift+Enter newline.
- [ ] Component test: typing `/` shows commands; Enter calls `onSubmit`.
- [ ] Gallery stories: empty, filled-with-references, command-popover open.
- [ ] Verify + commit.

### Task 14: Recommendation Card

**Files:** Create `ui/ai/recommendation-card.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `RecommendationCard({ title, rationale, confidence, alternatives, onAccept, onDismiss, onPickAlternative }: RecommendationCardProps)`;
  `confidence: number` (0–1) rendered as a segmented meter;
  `alternatives: Array<{ id: string; label: string }>`.
- Showcase heading: "Recommendation card".

- [ ] Port: card with accent-tinted icon badge, title, muted rationale;
      confidence meter = 5 segments (`rounded-full h-1` bars, filled per
      quintile, accent fill — match the showcase, not a traffic-light scale)
      with mono percent label; collapsible alternatives list; footer Accept
      (primary) / Dismiss (ghost).
- [ ] Gallery stories: high confidence, low confidence expanded alternatives.
- [ ] Verify + commit.

### Task 15: Context Cards

**Files:** Create `ui/ai/context-cards.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `ContextCard({ source, snippet, charCount, icon, onOpen }: ContextCardProps)`;
  `ContextCardRow({ children }: { children: ReactNode })` (horizontal scroll
  row).
- Showcase heading: "Context cards".

- [ ] Port: compact cards `bg-surface-inset rounded-card` with source header
      (icon + mono label), 3-line clamped snippet `text-muted-foreground`,
      footer char count mono; row scrolls horizontally with fade masks.
- [ ] Gallery story: row of 4 (mock: AGENTS.md, tokens.css, a ledger entry, a
      Linear ticket).
- [ ] Verify + commit.

### Task 16: Diff Table

**Files:** Create `ui/ai/diff-table.tsx`, `ui/ai/diff-table.test.tsx`; modify
`galleryStories.tsx`.

**Interfaces:**

- Produces:
  `DiffTable({ columns, rows, onAccept, onReject, onAcceptAll }: DiffTableProps)`;
  `columns: Array<{ key: string; label: string }>`;
  `rows: Array<{ id: string; kind: 'add' | 'remove' | 'change'; cells: Record<string, { old?: string; next?: string }> }>`.
- Showcase heading: "Diff table".

- [ ] TDD `summarizeDiff(rows)` →
      `{ adds: number, removes: number, changes: number }`.
- [ ] Implement: table in card frame; `add` rows `bg-green-bg`, `remove` rows
      `bg-red-bg` + strikethrough, `change` cells show `old → next` (old
      muted-strikethrough, next accent); header summary chips from
      `summarizeDiff`; per-row hover accept/reject icon-buttons + Accept-all
      primary button.
- [ ] Gallery story: 6-row mixed diff (mock: task table edits).
- [ ] Verify + commit.

### Task 17: Records Table

**Files:** Create `ui/ai/records-table.tsx`, `ui/ai/records-table.test.ts`;
modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `RecordsTable({ columns, rows, sort, onSortChange, onRowClick }: RecordsTableProps)`;
  `columns: Array<{ key: string; label: string; kind?: 'text' | 'tags' | 'time' | 'strength' }>`;
  `rows: Array<{ id: string; cells: Record<string, unknown> }>`;
  `sort: { key: string; dir: 'asc' | 'desc' } | null`. Cell renderers: `tags` →
  chip row, `time` → relative mono, `strength` → 3-bar indicator.
- Showcase heading: "Records table".

- [ ] TDD `sortRows(rows, columns, sort)` pure helper (string/number/date-aware;
      stable when `sort` null).
- [ ] Implement: full-bleed grid, sticky header
      `bg-surface-inset text-muted-foreground` with sort chevrons, hairline row
      dividers, hover `bg-surface-hover`.
- [ ] Gallery story: 6 rows with all cell kinds (mock: dispatch tasks w/ tags +
      last-run).
- [ ] Verify + commit.

### Task 18: Filter Table

**Files:** Create `ui/ai/filter-table.tsx`, `ui/ai/filter-table.test.ts`; modify
`galleryStories.tsx`.

**Interfaces:**

- Produces:
  `FilterChips({ options, active, onToggle, counts }: FilterChipsProps)`
  (`options: Array<{ id: string; label: string }>`; `active: string[]`;
  `counts?: Record<string, number>`) and pure
  `filterRows<T>(rows: T[], active: string[], getStatus: (r: T) => string): T[]`
  (empty `active` = all).
- Showcase heading: "Filter table".

- [ ] TDD `filterRows`: empty active returns all; single + multi selection
      unions.
- [ ] Implement chips: pill row, inactive
      `bg-surface-inset text-muted-foreground`, active
      `bg-accent-tint text-accent` with count badge; rows animate reorder via
      CSS `transition` on transform where feasible (`motion-reduce` exempt). The
      demo table in the gallery story composes `FilterChips` + `TaskRowList`
      from Task 11.
- [ ] Verify + commit.

### Task 19: Sidebar Nav

**Files:** Create `ui/ai/sidebar-nav.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `SidebarNav({ header, sections, activeId, onSelect, footer }: SidebarNavProps)`;
  `sections: Array<{ id: string; label?: string; items: Array<{ id: string; label: string; icon?: ReactNode; count?: number; state?: 'default' | 'attention' }> }>`.
- Showcase heading: "Sidebar nav".

- [ ] Port: `bg-surface-page` column, section labels `.dense-label`-style
      uppercase muted, items `rounded-control` hover `bg-surface-hover`, active
      `bg-surface-hover-strong text-foreground` (NOT accent fill — check
      showcase), counts as trailing muted mono, `attention` items get accent
      dot; header slot (workspace switcher) and footer slot.
- [ ] Gallery story: dispatch-shaped nav (Board, Inbox 3, Plans, All agents…).
- [ ] Verify + commit.

### Task 20: Search

**Files:** Create `ui/ai/search.tsx`, `ui/ai/search.test.ts`; modify
`galleryStories.tsx`.

**Interfaces:**

- Produces:
  `SearchPanel({ query, onQueryChange, groups, onSelect, emptyHint }: SearchPanelProps)`;
  `groups: Array<{ id: string; label: string; items: Array<{ id: string; label: string; icon?: ReactNode; hint?: string; kbd?: string }> }>`;
  pure `filterGroups(groups, query)` (case-insensitive substring on item labels,
  drops empty groups).
- Showcase heading: "Search".

- [ ] TDD `filterGroups`.
- [ ] Implement: overlay-style panel `rounded-card shadow-overlay`; input row
      with search icon (no visible border, hairline divider below); grouped
      results, active row `bg-surface-hover`, kbd hints via existing
      `ui/kbd.tsx`; empty state = centered muted icon + `emptyHint`. Full
      keyboard nav (up/down/enter).
- [ ] Gallery stories: results, empty.
- [ ] Verify + commit.

### Task 21: Insight Cards

**Files:** Create `ui/ai/insight-cards.tsx`, `ui/ai/insight-cards.test.ts`;
modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `InsightCard({ title, summary, series, unit, delta, page, pageCount, onPageChange }: InsightCardProps)`;
  `series: number[]` rendered as an inline SVG area chart with scrub interaction
  (pointermove shows crosshair + value chip);
  `delta: { value: string; direction: 'up' | 'down' | 'flat' }`.
- Showcase heading: "Insight cards".

- [ ] TDD `pathFromSeries(series, w, h)` pure SVG path builder (normalizes to
      viewbox; flat series centered; handles length 1 without NaN).
- [ ] Implement: card with title, delta chip (`up`→green tint, `down`→red tint,
      `flat`→gray), area chart (accent stroke, accent-tint fill gradient), scrub
      crosshair (hairline + mono value bubble), pager dots bottom.
- [ ] Gallery story: 2-page insight (mock: runs/day, merge lead time).
- [ ] Verify + commit.

### Task 22: Code Block

**Files:** Create `ui/ai/code-block.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Consumes: `useStreamedText` from Task 8.
- Produces:
  `CodeBlock({ code, language, streaming, filename, onCopy }: CodeBlockProps)`.
- Showcase heading: "Code block".

- [ ] Check for an existing highlighter first:
      `rg -n "shiki|highlight|prism" apps/desktop/package.json apps/desktop/src`
      — the Pierre diff surfaces likely ship one; reuse it. If none is
      importable, implement a minimal regex tokenizer for the gallery languages
      (ts, css, json): comments, strings, keywords, numbers — colored with
      `--accent`/`--green`/`--violet`/`text-muted-foreground` tokens only.
- [ ] Implement: `bg-surface-inset rounded-card` frame, header row (mono
      filename, language chip, copy icon-button with copied-state check),
      `font-mono text-sm` body, streaming mode reveals line-by-line (new line
      fades in, `motion-reduce` shows instantly), horizontal scroll contained.
- [ ] Gallery stories: static ts sample, streaming sample.
- [ ] Verify + commit.

### Task 23: Fine-tune Card

**Files:** Create `ui/ai/fine-tune-card.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces: `FineTuneCard({ title, controls, onChange }: FineTuneCardProps)`;
  `controls: Array<{ id: string; label: string; kind: 'segmented'; options: string[]; value: string } | { id: string; label: string; kind: 'slider'; min: number; max: number; value: number; unit?: string } | { id: string; label: string; kind: 'select'; options: string[]; value: string }>`;
  `onChange(id, value)`.
- Showcase heading: "Fine-tune card".

- [ ] Implement: inspector card `bg-surface-card rounded-card shadow-raised`;
      each control row = muted label left, control right; segmented = mini
      toggle-group (`bg-surface-inset` track, active segment
      `bg-surface-card shadow-btn`); slider = native range styled with accent
      fill + mono value; select via `ui/native-select.tsx`.
- [ ] Gallery story: layout/radius/opacity/type controls (the showcase's exact
      four).
- [ ] Verify + commit.

### Task 24: Selection Actions

**Files:** Create `ui/ai/selection-actions.tsx`,
`ui/ai/selection-actions.test.tsx`; modify `galleryStories.tsx`.

**Interfaces:**

- Produces:
  `SelectionActionsMenu({ actions, onAction, position }: SelectionActionsMenuProps)`
  (pure positioned menu:
  `actions: Array<{ id: string; label: string; icon?: ReactNode }>`, default set
  exported as `defaultSelectionActions` = Explain/Improve/Shorten/Tone/Grammar)
  and
  `useTextSelection(ref: RefObject<HTMLElement>): { text: string; rect: DOMRect | null }`.
- Showcase heading: "Selection actions". Note:
  `components/code/SelectionActions.tsx` already exists for diffs — do NOT
  modify it here; Task 31 reconciles.

- [ ] Component test: menu renders actions, calls `onAction`, positions at given
      rect (jsdom/happy-dom rect math only — no real selection API in tests).
- [ ] Implement: floating chip-row
      `rounded-control shadow-overlay bg-surface-card` above the selection rect
      with a subtle pop-in (`ease-out-expo`, `motion-reduce:transition-none`);
      Tone gets a submenu (chevron → Professional/Friendly/Direct); selection
      highlight styling via `::selection { background: var(--accent-tint) }`
      added in `global.css`.
- [ ] Gallery story: paragraph with a pre-selected mock rect showing the menu.
- [ ] Verify + commit.

### Task 25: Shell + sidebar adoption

**Files:** Modify `components/shell/*` (sidebar component — locate via
`rg -n "sidebar" src/components/shell`), `App.tsx` shell wrappers.

**Interfaces:**

- Consumes: `SidebarNav` (Task 19).

- [ ] Rebuild the app sidebar on `SidebarNav`: project switcher in `header`,
      project views + global views as sections (keep all existing navigation
      behavior/callbacks — this is a re-skin, wiring unchanged), inbox count as
      `count`, attention states from existing notification logic, Gallery dev
      entry stays.
- [ ] Restyle remaining shell chrome (`ui/chrome/`, titlebar, panels) to tokens:
      page `bg-surface-page`, panel seams hairline.
- [ ] Run existing shell/App tests; update class assertions only.
- [ ] Format/lint/tsc + commit: `feat(desktop): shell adopts SidebarNav`

### Task 26: Board + task surfaces

**Files:** Modify `views/BoardView.tsx`, `views/TasksListView.tsx`,
`views/AllAgentsView.tsx`, `views/SessionsHubView.tsx`,
`components/sessions/SessionRow.tsx`.

**Interfaces:**

- Consumes: `FilterChips`/`filterRows` (18), `TaskRow`/`TaskRowList` (11),
  `RecordsTable` (17).

- [ ] BoardView: column headers become filter-chip-styled status chips with
      counts; cards adopt `rounded-card shadow-card bg-surface-card` + run-state
      dot language from `TaskRow`; keep DnD wiring untouched.
- [ ] TasksListView: render through `RecordsTable` (columns: title, tags, state,
      updated) preserving row-click nav and existing test behavior (update
      `TasksListView.test.tsx` expectations to the new DOM as needed —
      interaction assertions must keep passing unchanged).
- [ ] AllAgentsView + SessionsHubView + SessionRow: rows become `TaskRow`s
      inside `TaskRowList` (state mapping: use existing `runState.ts`
      disposition → TaskRow state; keep `AllAgentsView.test.tsx` behavior
      green).
- [ ] Format/lint/tsc + focused tests + commit:
      `feat(desktop): board and task surfaces adopt reskin primitives`

### Task 27: Transcript + chat adoption

**Files:** Modify `views/TaskView.tsx`, `components/runs/TranscriptRow.tsx`,
`ToolCard.tsx`, `QuestionCard.tsx`, `ApprovalCard.tsx`, `ScopeRequestCard.tsx`,
`RunLogView.tsx`, `RunStatePill.tsx`, `components/chat/SnippetComposer.tsx`,
warden chat surface (locate via `rg -n "warden" src/views src/components`).

**Interfaces:**

- Consumes: `Thinking` (7), `StreamingText` (8), `ApprovalCard` primitive (9),
  `ToolChip` (10), `ChatPanel`/`ChatMessage` (12), `PromptBar` (13),
  `LoadingState` (6), `CodeBlock` (22).

- [ ] TranscriptRow: thinking/reasoning segments render via `Thinking`; tool
      calls via `ToolChip` (ToolCard's expanded detail stays as the chip's
      click-through); streaming agent text via `StreamingText` (wire real
      streaming state; sources/follow-ups only where data exists — do not
      fabricate).
- [ ] `components/runs/ApprovalCard.tsx`, `QuestionCard.tsx`,
      `ScopeRequestCard.tsx`: rebuild on the `ui/ai/approval-card.tsx`
      primitive, preserving every callback and payload shape (these are live
      human-in-the-loop paths — their tests must stay green:
      `ReviewChatPanel.test.tsx` etc.).
- [ ] Composers (SnippetComposer, warden chat input, task chat input): rebuild
      on `PromptBar` keeping current submit/mention semantics; model picker
      options come from existing project-config source (see commit `a76feaf2`).
- [ ] Boot/working placeholders: `LoadingState` with real `startedAt`.
- [ ] Code fences in `components/runs/Markdown.tsx` render via `CodeBlock`
      (static mode).
- [ ] Focused tests: `bun test src/components/runs src/components/chat` in
      apps/desktop.
- [ ] Format/lint/tsc + commit:
      `feat(desktop): transcript and chat adopt reskin primitives`

### Task 28: Diff/git + insights + search adoption

**Files:** Modify `views/DiffModal.tsx`, `components/code/DiffSurface.tsx`,
`components/git/*` (restyle pass), `views/ImpactView.tsx`,
`components/impact/ImpactPanel.tsx`, `views/OverviewView.tsx`,
`components/overview/*`, command palette consumers of `ui/command.tsx`.

**Interfaces:**

- Consumes: `DiffTable` (16), `InsightCards` (21), `SearchPanel` (20),
  `ContextCard` (15).

- [ ] DiffModal/DiffSurface: adopt diff-table visual language (green/red row
      tints, `old → next` change cells) — keep Pierre components' internals
      untouched (they're untestable in happy-dom; restyle only wrappers/frames
      around them).
- [ ] Git panels: token/shadow/radius restyle pass; CommitComposer adopts field
      styling.
- [ ] ImpactView/OverviewView: stat panels become `InsightCard`s fed from
      existing data (series from whatever the panels already compute; pager for
      multiple metrics); FeedRow adopts TaskRow density language.
- [ ] Command palette: restyle `ui/command.tsx` content to `SearchPanel`'s
      visual spec (keep cmdk wiring; port classes rather than replacing the
      lib).
- [ ] PlansView retrieved-context blocks (PlanQuestionsForm context) render via
      `ContextCard` where chunks exist.
- [ ] Focused tests + format/lint/tsc + commit:
      `feat(desktop): diff, insight, and search surfaces adopt reskin`

### Task 29: Inbox, drafts, remaining views

**Files:** Modify `views/InboxView.tsx`, `views/DraftView.tsx`,
`views/BrainDumpView.tsx`, `views/PlansView.tsx`, `views/MilestonesView.tsx`,
`views/BranchesView.tsx`, `views/SettingsView.tsx`, `views/LandingView.tsx`,
`views/GetStartedView.tsx`, `views/WardenView.tsx`, `views/PrReviewView.tsx`,
`components/settings/*`.

**Interfaces:**

- Consumes: `ApprovalCard` (9), `RecommendationCard` (14),
  `SelectionActionsMenu`/`useTextSelection` (24).

- [ ] InboxView: agent questions → `ApprovalCard`; agent suggestions →
      `RecommendationCard`; other rows adopt TaskRow density. Keep
      `InboxView.test.tsx` behavior green.
- [ ] DraftView + BrainDumpView: wire `useTextSelection` +
      `SelectionActionsMenu` over the editable text (action handlers dispatch to
      the existing agent-message path used by chat; if no such path exists for a
      given action, wire Explain/Improve only and leave the rest rendered but
      disabled with a tooltip "coming soon" — do NOT fake results). Reconcile
      with `components/code/SelectionActions.tsx`: diffs keep their existing
      component, restyled to the primitive's visual spec.
- [ ] Remaining views: restyle pass only (tokens/shadows/radii/type, cards →
      `rounded-card shadow-card`, section labels → dense-label style). Settings
      sections keep their tests green.
- [ ] Focused tests (`InboxView.test.tsx`, `SettingsView.test.tsx`,
      `LandingView.test.tsx`) + format/lint/tsc + commit:
      `feat(desktop): remaining surfaces adopt reskin`

### Task 30: Motion + final verification

**Files:** Modify `global.css` (shared keyframes if duplicated across
primitives), any primitive needing polish; `AGENTS.md` untouched.

- [ ] Consolidate animation: shimmer + pulse keyframes defined once in
      `global.css` (or a `ui/ai/motion.css` imported by main.tsx), primitives
      reference them; every `transition`/`animation` uses `--ease-out-expo`
      where it fits the showcase feel.
- [ ] Reduced-motion audit:
      `rg -n "animate-|transition|@keyframes" src/ui/ai src/styles` — every hit
      either honors `motion-reduce:` / `prefers-reduced-motion` or is a
      non-motion transition (color/opacity are acceptable).
- [ ] Full suite: `bun run format && bun run lint` (root), `bun run tsc` +
      `bun run test` in `apps/desktop`, root `bun run test` if time allows
      (slow, sleep-sensitive — package-level is the bar). Flaky-looking server
      failures: re-run that package alone before blaming the change.
- [ ] Gallery pass: all 19 primitives present with stories; count badge correct.
- [ ] Commit any stragglers: `polish(desktop): motion + reduced-motion pass`

---

## Final checkpoint (human)

Wyat reviews visually: gallery view (light + dark) + a click-through of board,
task transcript, inbox, diff, settings. Playwright/e2e is not runnable from the
agent shell — this hand-off IS the visual verification.
