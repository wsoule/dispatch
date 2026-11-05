# The Nocturne redesign

`dispatch-nocturne.dc.html` is the full-app design mockup this redesign is built
from, imported from the Claude Design project
`5925d976-9f25-4ba7-94d0-f41477704479`. It is committed rather than left in
`.agents/ignore/` on purpose: every dispatched agent works in its own worktree,
so a gitignored copy on one machine is invisible to the agent doing the work.

## We take its structure. We take none of its colors

The mockup is a dark-only prototype drawn against a different design system, in
a palette that is not ours. **Nothing in it is a color decision for Dispatch.**

Take from it: layout, information architecture, density, type scale, what
information appears on a row, what actions sit where, grouping and collapse
behavior, empty and loading states, copy.

Ignore entirely: every hex value, the blurple accent, and every
`color-mix(in srgb, var(--color-text) N%, transparent)` chain. Do not port
`--st-work`, `--st-wait`, `--st-fail`, `--st-ok`, `--st-land`, `--dim`,
`--dim2`, `--line`, or raw hexes like `#12131d` and `#1b1d2b`.

All color comes from `@dispatch/ui`'s token layer,
`packages/ui/src/styles/tokens.css`, which defines light and dark variants of
everything these screens need. A status is colored only through a `UiTone` and
the `data-tone` hook ("Status vocabulary" in `packages/ui/README.md`), never
through a raw hue and never through the accent: the purple means primary, focus,
selection and links, not a status. The mockup's states map onto the tones the
app already draws them in (`feedStateTone` in
`apps/desktop/src/lib/feedState.ts`):

| Run/task state in the mockup | `UiTone`          |
| ---------------------------- | ----------------- |
| working (an agent is live)   | `info` (blue)     |
| waiting on you               | `warning` (amber) |
| failed                       | `danger` (red)    |
| needs review / passed        | `success` (green) |
| landing (in the merge queue) | `info` (blue)     |
| ready                        | `muted` (grey)    |
| blocked                      | `warning` (amber) |

Each state also keeps its own glyph and words, so color is never the only cue,
and done is a filled neutral mark, never green. Where the mockup reaches for a
tint the tokens don't cover, add a token to `tokens.css` first, then use it.

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
the `feed` builder (grouping, caps, per-row actions), and `milestoneList()`
(task state derivation).

## What is here that the app does not have

The app now uses a sidebar of destinations (Overseer, Issues, Needs you,
Timeline, Graph, Threads, Docs, Runs), so the mockup's screens no longer map one
to one. **Brain dump** is built as Drop a thought (⌘D): captures wait under
Noted in the Overseer's Coming in column until made a task or dismissed. The
**Control room** and **Landing** screens were built and then retired with the
old sidebar layout: what waits on you is the Needs you destination and the
Overseer's Coming in column, and the merge queue shows in the Overseer's Going
out column and on each task's review.

## What not to build

**Do not build the mockup's `isNotes` screen.** Notes & triage has been removed;
Drop a thought (⌘D) and the Overseer's Noted list are the single inbox. Also
skip the mockup's "Older — the triage list from before →" link: it points at a
page that no longer exists.

One thing the old Notes surface carried moved into the inbox rather than dying
with it: the MCP `dispatch_note` tool that agents call mid-run to flag what they
noticed now POSTs to `/api/inbox` (its four note kinds fold onto `note` and
`task`). `packages/server/src/notes.ts` still exists and still backs the
`/api/notes` routes, but no longer backs that tool. The old Brain dump's "Plan
it" action, which AI-drafted a task from one note, is gone.

The mockup's **Plans** screen is not its own milestone either: plans live in the
Overseer conversation as plan cards (the palette's "Plan work…" opens it), and
the conversational-planning work is tracked under `e-359627`.
