# Blast Radius

Surface what a change touches. Given a file, a run, or a task, show the set of
files affected and how far away each one is.

## Purpose

Dispatch already computes this and shows it to nobody. `ReviewRunner`
(`packages/server/src/orchestrator/review.ts:821`) asks `DepMap` for the
dependents and mirrors of a run's changed files, caps the list, and splices it
into the review agent's prompt as text. There is no HTTP route, no client
binding, and no UI. The signal exists on every review and never reaches a human.

Two consequences this design fixes:

- A reviewer cannot see the reach of a change they are approving.
- Nobody can see that the review agent's scope was *capped* — on a wide change
  it never saw most of the affected files, and nothing says so.

## Non-Goals

- Not a graph editor or visualiser. No node-link rendering.
- Not a new dependency engine. The graph exists; this exposes it.
- Not a change to review scope behaviour. `ReviewRunner`'s prompt stays
  byte-identical.

## Architecture

Three layers, each independently testable:

| Layer | File | Responsibility |
| --- | --- | --- |
| Graph | `packages/server/src/depmap.ts` | `reach()` — transitive walk with hop distance |
| Resolution | `packages/server/src/impact.ts` | subject (file/run/task) → file set → `reach()` |
| Exposure | `packages/server/src/api/impact.ts`, `packages/client`, `apps/desktop` | route, binding, two UI surfaces |

### Preserving hop distance

`normalizeBlastRadius` currently uses carto's `hop_distance` to sort
closest-first and to keep the shortest of several routes to the same file, then
discards it via `.map(([path]) => path)`.

It splits in two:

```ts
export function normalizeBlastRadiusEntries(
  raw: CartoBlastRadius
): { path: string; hops: number }[];

// unchanged signature and output; now a one-line map over the above
export function normalizeBlastRadius(raw: CartoBlastRadius): string[];
```

Keeping the flat function is what guarantees `ReviewRunner` is unaffected.

### The transitive walk

```ts
interface DepMap {
  dependents(file: string): string[]; // unchanged
  mirrors(file: string): string[]; // unchanged
  reach(files: string[], opts: ReachOptions): ReachResult; // new
}

interface ReachOptions {
  maxHops: number; // default 5, matching carto's observed depth
  maxFiles: number; // default 500
}

interface ReachResult {
  entries: { path: string; hops: number }[]; // closest-first
  count: number;
  maxHops: number; // deepest hop actually reached
  sources: ('carto' | 'scanner')[]; // which graphs contributed
  degraded: boolean; // carto was configured but unavailable this call
  truncated: boolean; // a cap stopped the walk
}
```

**Carto never answers alone.** `createCartoDepMap.dependents()` unions carto's
blast radius with the scanner's reverse-import graph, because neither dominates:
carto resolves specifiers naively and misses workspace `exports` edges the
scanner catches, while the scanner only understands `.ts`/`.tsx`. So `sources`
is a list, not a single backend, and is `['scanner']` only when carto is absent
or degraded.

Each graph contributes distance differently, and `reach` reconciles them:

- **Carto** supplies native `hop_distance` (1..N) per file.
- **Scanner** supplies one-hop reverse-import edges; `reach` breadth-first
  searches them to derive distance, with a visited set so cycles terminate.
- **Union by shortest distance.** A file reachable at 2 hops through carto and 1
  through the scanner is recorded at 1 — the same shortest-wins rule
  `normalizeBlastRadius` already applies within carto's own multiple routes.

`reach` must **not** reuse `mergeRoundRobin`. That merge interleaves two lists
by source so a scanner-only dependent survives `DEPENDENT_CAP` (20) when carto
returns far more; it deliberately does not order by distance. Ordering a human
view that way would present an interleaving as if it were a distance ranking.

Caps are mandatory. The recorded fixture reaches 30 files at 5 hops on a small
repo; this monorepo would reach hundreds.

### Subject resolution

`impact.ts` turns any subject into a file set, then calls `reach` once:

| Subject | Resolves to |
| --- | --- |
| `file` | that path |
| `run` | the run's changed files, from the diff it already computes |
| `task` | the task's declared `writes: string[]` — glob patterns, matched against tracked files |

Resolution is the only thing that differs between the three; everything
downstream is identical. That is what makes one surface serve all three.

A task's `writes` are the same glob patterns the undeclared-write findings check
against, so resolution reuses that matcher rather than adding a second one. A
task with no declared writes resolves to an empty set and the UI says so — it
does not guess from the task's prose.

### Exposure

`GET /api/impact?subject=file|run|task&id=<path|runId|taskId>` returns
`ReachResult`. One request, no streaming — the map is cached and the walk is
bounded. A client binding mirrors it.

## UI

`ImpactPanel` (compact) renders count, deepest hop, a direct-vs-downstream bar,
the backend name, and review-scope coverage. It appears in the Review case
panel, task detail, and the Git file pane.

`ImpactView` (full) is a new nav item: subject picker, hop-grouped sections, a
path filter.

Both render from the same `ReachResult`. The panel is not a reduced
reimplementation — there is one data shape and no second path that can drift.

### Components

Built from the existing shadcn primitives in `apps/desktop/src/ui/` and the
`chrome/` layer on top of them. `components.json` pins style `new-york`, base
colour `neutral`, and `lucide` icons; new primitives are added with
`bunx shadcn@latest add <name>`, never hand-rolled and never copied in by hand.

Everything this feature needs already exists:

| Need | Use |
| --- | --- |
| Panel shell, headers, empty state | `chrome/` — `Panel`, `ViewHeader`, `EmptyState` |
| Hop-group expand/collapse | `chrome/collapse-bar` |
| Subject picker | `ui/select` |
| Path filter | `ui/input` |
| Backend name, truncation marker | `ui/badge` |
| Backend caveat on hover | `ui/tooltip` |
| Loading state | `ui/skeleton` |
| File path rendering | `chrome/path-crumb` |

The direct-vs-downstream bar is the one element with no existing primitive.
Prefer composing it from `chrome` rather than introducing a dependency; add
shadcn's `progress` only if composition proves worse, and say so in the plan.

`scripts/check-chrome-utilities.ts` flags raw Tailwind palette hues, so colour
comes from tokens via the chrome layer. Run styles are distinguished by form,
not colour alone — hop depth follows the same rule.

## Honesty requirements

A blast radius that under-reports is worse than none: it converts "I don't know"
into false confidence. Three failure modes must be visible in the UI, never
swallowed.

- **The scanner is TS/TSX-only.** It is not merely shallower than carto — it is
  blind to other languages, so on a polyglot repo it can return a small number
  that reads as authoritative. Both surfaces name the contributing `sources`,
  and a scanner-only result states what it walks.
- **Truncation.** When a cap stops the walk, the UI reads "500+ files (capped)",
  not "500 files".
- **Carto degrading mid-flight.** A half-written `.carto` container during a
  sync is a normal, recoverable state already handled via `CartoDegradation`.
  `reach` reports it as a scanner-backed result with `degraded: true` — not an
  error, and not a silently shallower answer.

**Review scope coverage.** `ReviewRunner` caps dependents at `DEPENDENT_CAP`
before building the prompt, so on a wide change the review agent never saw most
affected files. The panel states "review scope covered 8 of 30". The cap is
already known; this is the most useful sentence the feature produces.

## Error handling

- Unknown file, run, or task → empty result with a stated reason, HTTP 404. Never a 500.
- A file outside the repo root → rejected before touching the graph.
- Carto container unreadable → scanner result with `degraded: true`.

## Testing

The graph walk is where subtle wrongness hides:

- **Cycles.** `A→B→A` terminates.
- **Diamonds.** Shortest distance wins, matching carto's dedupe rule.
- **Caps.** Hitting either cap sets `truncated`. A test asserts the flag, not
  just the truncated length — an unflagged truncation is the silent
  under-report this design exists to prevent.
- **Union by shortest.** A file carto reports at 2 hops and the scanner reaches
  at 1 is recorded at 1. A test pins this, since the naive union would keep
  whichever arrived first.
- **Scanner-only parity.** The same synthetic graph with carto absent yields the
  same shape with `sources: ['scanner']`, so the two paths cannot drift.
- **No round-robin.** A test asserts `reach`'s output is ordered by hop
  distance, not interleaved by source — the failure mode if someone reuses
  `mergeRoundRobin` for symmetry with `dependents()`.

Plus: a resolution test per subject; API route tests covering not-found and
degraded; and panel logic extracted pure and unit-tested, following the desktop
package's existing pattern. No click-path tests — Playwright cannot spawn git in
the agent environment, so those are handed to a human.

## Delivery

Lands in a fresh worktree off `main`, not `feat/demo-environment` (open PR).
