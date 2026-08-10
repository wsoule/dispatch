# Landing: unified PR table, GitHub-gated merge queue, and PR review worktrees

**Status:** approved design, pre-plan
**Date:** 2026-08-10
**Motivation:** The PR surface is bad — you cannot tell what is merged
into main, what is queued, or when anything will merge. Merged PRs
vanish (`gh pr list --state open` only), head/base branches are never
rendered, per-check detail is destroyed server-side, the merge queue
and PR state are unjoined, and the queue merges PRs blind. Reference
UI: Hydrogen's PR table (`apps/web/src/components/pr/`), whose visual
design and pure-logic architecture we port onto Dispatch's data.

## Decisions (settled with Wyat, do not re-litigate)

1. Scope: **all** GitHub PRs on the repo **plus** local merge-queue
   entries, one unified "what lands and when" table.
2. The table is a **new sidebar destination "Landing"**, absorbing the
   current `LandingView` (today reachable only inlined under Review's
   empty state).
3. The merge queue **gates PR-routed entries on GitHub state** (checks,
   mergeable, review decision) instead of calling `gh pr merge` blind.
4. PR review worktrees are **on-demand, auto-synced, auto-removed** on
   merge/close when clean. Purpose: an executable review environment
   (run the app, run tests), not just diff viewing.
5. Architecture: **server-side unified feed** (`GET /api/landing`), not
   a client-side join.
6. No ETA timestamps — show queue position + current gate honestly.
7. UI composes strictly from the existing **shadcn primitives in
   `apps/desktop/src/ui/`** (Table, Badge, Sheet, Popover,
   DropdownMenu, Tooltip, …). No bespoke table/sheet/popover
   components.

## Server

### Landing feed

New `GET /api/landing` returning:

```ts
LandingSnapshot { rows: LandingRow[]; landed: LandedRow[]; generatedAt }

LandingRow {
  id: string                       // stable: pr-<n> | run-<runId> | queue-<entryId>
  kind: 'pr' | 'run-pr' | 'queue-local'
  title: string; taskId?: string; runId?: string
  pr?: {
    number; url; author; isDraft; headRef; baseRef
    state; reviewDecision; mergeable
    checks: { passed; failed; pending; total
              runs: Array<{ name; conclusion; url }> }
    additions; deletions; changedFiles; updatedAt
  }
  queue?: { position; state; stateSince; steps; reason }
  gate: {
    status: 'ready' | 'waiting-checks' | 'waiting-review' | 'conflicts'
          | 'draft' | 'queue-position' | 'verifying' | 'merging'
          | 'blocked' | 'none'
    detail: string                 // the one-line "why isn't this merged yet"
  }
  worktree?: { path; syncState: 'synced' | 'behind' | 'dirty-hold'; headOid }
}
```

- Join key: `RunMeta.prUrl` ↔ PR URL (the rule `buildReviewQueue`
  already uses). A dispatch-opened PR is ONE `run-pr` row carrying both
  queue entry and GitHub state — never two rows.
- `gate` is computed server-side so table, CLI, and any future web UI
  share one answer.
- `landed` = merge-queue history ∪ recently merged PRs (new
  `--state merged` listing, recent N), newest first, with merge commit
  sha and "via PR #N / local".

### PR polling: richer, cached, pushed

- `PrManager.pollOnce` fetches state + mergeable + reviewDecision +
  full `statusCheckRollup` for all open PRs in one `gh pr list` call.
  Per-check `{name, conclusion, url}` is **preserved** (today
  `summarizeChecks` destroys it before it leaves the server).
- Results cached in memory on `PrManager`; a `landing.changed` WS
  event fires on any delta. Baseline poll 60s; tightens to ~15s while
  any queue entry is gated on GitHub.

### Merge-queue gating (behavior change)

- New entry state `waiting-github` for PR-routed entries, entered after
  local verify passes, before merge.
- The queue consults the same cached PR state the table renders: holds
  on pending/failing checks, `CONFLICTING`, draft, or review-required;
  proceeds when green. `gh pr merge` failure still lands in `reason`.
- Local (non-PR) entries unchanged.

### Explicitly not building

- No ETA timestamps. No persistent PR database (memory cache + `gh` is
  enough for a local daemon). No branch-protection configuration
  reading beyond what `gh pr view` reports.

## Desktop UI

### The Landing view

New sidebar item "Landing" with a needs-attention count badge
(consistent with existing sidebar badges). One table using the shadcn
`Table` primitives, run-state tokens, and the mono density scale.
`StatusPill`/`PrChecksPill` vocabulary extended, not replaced.

Rows grouped with full-width tinted group headers (Hydrogen's
discriminated-union row model: `{type:'group'} | {type:'row'}`),
ordered by distance from main:

1. **Needs you** — conflicts, changes requested, failing checks,
   dirty-hold worktrees
2. **In queue** — ordered, `#position`, phase via the real `StepStrip`
3. **Waiting on GitHub** — CI running, review required, draft
4. **Open** — PRs not yet queued
5. **Recently landed** — collapsed; merged PRs ∪ queue history

Columns (progressive disclosure by width, per Hydrogen):

| Col | Content |
|---|---|
| dot | gate-status color + halo ring; Tooltip = `gate.detail` |
| Pull request | title; mono sub-line `#N · author · headRef → baseRef · 2h ago` |
| Lands | gate chip: `Ready · next`, `#3 · behind t-xxxx`, `Waiting on CI · 2 running`, `Verifying · 2/4`, `Conflicts`, `Draft` |
| Checks | dot + `passed/total`; Popover lists each check by name with conclusion, click-through URL |
| Changes | `+adds −dels` / `n files` |
| Review | approved / changes-requested / review-required pill |
| Worktree | `Check out` action, or sync badge + open-in-editor / copy path / reveal (DropdownMenu) |

Interactions:

- Title click opens the existing ReviewView targeted at that row.
  (Drive-by fix: `RunReviewView`'s stale "Pull requests tab" copy and
  `onOpenPr` prop doc.)
- Author and gate chips toggle facet filters (Hydrogen's cell-click
  pattern) rendered as dismissible chips.
- Filter/sort state persists to localStorage only (desktop app — skip
  Hydrogen's URL-param layer).
- All join/filter/group logic in a pure `lib/landingView.ts` — zero
  React, unit-testable (required: Pierre/happy-dom constraints make
  component tests unreliable; pure logic is the testable seam).
- Filter-aware empty states ("Nothing in flight" vs "No rows match" +
  clear-filters).

## PR review worktrees

Server-side `PrWorktreeManager`, reusing agent-review plumbing:
`PrManager.fetchPrHead` (`refs/dispatch/pr/N`, including the existing
fork-confirm gate for cross-repo PRs) + `WorktreeManager.add`.

- **Location: human-findable.** Default
  `../<repoName>-worktrees/pr-<number>` beside the repo; config key to
  override. These exist to `cd` into and run the app —
  `~/.dispatch/worktrees/<hash>/` would defeat the point.
- **Sync piggybacks the PR poll.** New `headRefOid` + clean worktree →
  fetch and fast-forward automatically. Local edits → `dirty-hold`:
  never touched again automatically; row badges
  "dirty · N pushes behind".
- **Cleanup:** PR merged/closed → clean worktree auto-removed; dirty
  worktree kept and flagged reclaimable in the Branches view (same
  vocabulary as `mergedOrphans`).
- API: `POST /api/prs/:n/worktree` (create), `DELETE` (remove);
  state rides `LandingRow.worktree` and `landing.changed`.
- **Not doing:** auto-install/build inside the worktree (repo-specific
  and slow — the row exposes the path, the shell does the rest); no
  worktrees for local queue entries (runs already have one).

## Errors

- `gh` failures degrade per-row: `gate.status = 'none'` + stale badge
  carrying the error; the table stays up.
- Worktree op failures surface through the existing WS log stream.
- `PrChecksPill` at `total === 0` must distinguish "no CI configured"
  from "CI not started" (today both render nothing).

## Testing

- Gate computation and feed join: pure server functions, unit-tested
  against fake `CommandRunner` gh output (existing test idiom).
- Queue gating: merge-queue tests driving fake gh states →
  hold/proceed transitions.
- `lib/landingView.ts`: pure-function tests (grouping, filtering,
  facet chips, empty-state selection).
- `PrWorktreeManager`: temp-repo tests for create/sync/dirty-hold/
  cleanup.
- Visual click-paths: manual, handed to Wyat (Playwright cannot spawn
  git in the agent shell).
