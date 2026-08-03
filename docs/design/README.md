# The Nocturne redesign

`dispatch-nocturne.dc.html` is the full-app design mockup this redesign is built
from, imported from the Claude Design project
`5925d976-9f25-4ba7-94d0-f41477704479`. It is committed rather than left in
`.agents/ignore/` on purpose: every dispatched agent works in its own worktree,
so a gitignored copy on one machine is invisible to the agent doing the work.

## We take its structure. We take none of its colors.

The mockup is a dark-only prototype drawn against a different design system, in
a palette that is not ours. **Nothing in it is a color decision for Dispatch.**

Take from it: layout, information architecture, density, type scale, what
information appears on a row, what actions sit where, grouping and collapse
behavior, empty and loading states, copy.

Ignore entirely: every hex value, the blurple accent, and every
`color-mix(in srgb, var(--color-text) N%, transparent)` chain. Do not port
`--st-work`, `--st-wait`, `--st-fail`, `--st-ok`, `--st-land`, `--dim`,
`--dim2`, `--line`, or raw hexes like `#12131d` and `#1b1d2b`.

All color comes from the app's existing token layer in
`apps/desktop/src/styles/tokens.css`, which already defines light and dark
variants of everything these screens need. Status colors map onto tokens that
exist today — no new palette:

| Run/task state in the mockup | Dispatch token                        |
| ---------------------------- | ------------------------------------- |
| working (an agent is live)   | `--accent`, `--accent-muted`          |
| waiting on you               | `--amber`, `--amber-bg`               |
| failed                       | `--red`, `--red-bg`                   |
| needs review / passed        | `--green`, `--green-bg`               |
| landing (in the merge queue) | `--blue`, `--blue-bg`                 |
| ready                        | `--text-secondary`, `--surface-muted` |
| blocked                      | `--text-ghost`, `--gray-bg`           |

Dimmed metadata is `--text-muted` and `--text-secondary`. Hairlines are
`--border-default` / `--border-strong`. Mono metadata uses `--font-mono` at
`--text-xs` / `--text-sm`. Where the mockup reaches for a tint the tokens don't
cover, add a token first, then use the token.

## Reading the mockup

It is a single self-contained prototype, not React. Open it in a browser to see
it run. Two halves:

- **The template** (lines 1–1076) — plain HTML with `sc-for` / `sc-if` control
  flow and `{{ }}` bindings. Every screen is one `<sc-if value="{{ isX }}">`
  block, so `isControl`, `isReview`, `isTasks` and friends mark the screen
  boundaries.
- **The logic** (lines 1078–1925) — a `DCLogic` subclass. `state` at the top
  holds the fixture data; `renderVals()` at the bottom returns every binding the
  template consumes. Because the prototype has no CSS classes to speak of,
  `renderVals()` computes literal style strings inline — so read it for
  _structure and conditional logic_ (when a row is urgent, what a group caps at,
  which action a state gets) and skip the color arithmetic it wraps that logic
  in.

Useful entry points: `LBL` (the state labels), `ribbonDef` (the seven counters),
the `feed` builder (grouping, caps, per-row actions), and `epicList()` (task
state derivation).

## What is here that the app does not have

Every screen in the mockup now maps onto an existing view. The two that used to
be missing have both been built: **Brain dump** (`BrainDumpView.tsx`) and
**Landing**, the merge queue as a first-class surface (`LandingView.tsx`,
rendered inside `ReviewView`).

## What not to build

**Do not build the mockup's `isNotes` screen.** Notes & triage has been removed;
Brain dump is the single inbox. Also skip the "Older — the triage list from
before →" link in Brain dump's right rail: it points at a page that no longer
exists.

Two things the old Notes surface carried moved into the inbox rather than dying
with it. The MCP `dispatch_note` tool that agents call mid-run to flag what they
noticed now POSTs to `/api/inbox` (its four note kinds fold onto `note` and
`task`); `packages/server/src/notes.ts` still exists and still backs the
`/api/notes` routes, but no longer backs that tool. And `useDispatchProject.ts`
holds a second plan slot (`notePlanId` / `notePlanRecord` /
`handleConfirmNotePlan`) that AI-drafts a task from one item, which is Brain
dump's "Plan it" action. Neither is dead code.

The mockup's **Plans** screen is also not its own epic: `PlansView.tsx` already
covers it, and the conversational-planning work is tracked under `e-359627`.
