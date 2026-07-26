# Branch Visibility and Cleanup — Design

**Status:** approved, ready for implementation planning **Date:** 2026-07-26

## Problem

Dispatch creates one git worktree and one `dispatch/*` branch per run, and
removes both on every review path. That cleanup works. What is missing is
everything _outside_ that path:

1. **No visibility.** A branch name appears only in `RunDetailHeader.tsx:55`
   (one run at a time) and in the PR list row (`PullRequestsView.tsx:608`).
   Nothing answers "what dispatch branches and worktrees exist on my disk right
   now."
2. **Unreviewed runs accumulate.** A run that finished, failed, or was cancelled
   and never reviewed keeps its worktree and branch forever. There is no way to
   reclaim that disk short of reviewing the run or using git by hand.
3. **Orphan branch refs leak permanently.** `WorktreeManager.pruneOrphans`
   deletes unknown _directories_ under the worktrees root, but never inspects
   `refs/heads/dispatch/`. A ref whose directory is gone (a hand-deleted
   transcript, a crash between ref creation and directory creation) is invisible
   to every existing code path and is never reclaimed.

The current repo is a live instance of (2): six `dispatch/*` branches and six
worktrees under `~/.dispatch/worktrees/cc658f598366/`.

## What Already Works — Do Not Rebuild

`WorktreeManager.remove()` (`worktree.ts:118`) already does
`worktree remove --force` → `branch -D` → `prune`, and all three review paths
call it:

| Path                       | Call site                                 |
| -------------------------- | ----------------------------------------- |
| `review(runId, 'merge')`   | `orchestrator.ts:753` (inside `mergeRun`) |
| `review(runId, 'discard')` | `orchestrator.ts:548`                     |
| `markRunMergedViaPr`       | `orchestrator.ts:622`                     |

`Orchestrator.diff()` (`orchestrator.ts:465`) already falls back to the
persisted `<runId>.diff.json` snapshot when `meta.worktreePath` no longer
exists. **This is load-bearing for the "Free disk" action below:** snapshot
first, remove the directory, and the review surface keeps working with no change
to `diff()` at all.

## Non-Goals

- Changing `reconcileOnBoot`'s auto-GC behavior. Orphan refs are surfaced, never
  auto-deleted — a branch ref is often the only remaining record of that work,
  and deleting it at boot destroys commits with no undo and no user in the loop.
- Per-worktree disk-size reporting. `du` is slow on large repos.
- Any change to `readyTasks()` semantics, merge-queue eligibility ordering, or
  the stacked-dispatch restack logic.

---

## 1. Data Model

One new type in `packages/server/src/orchestrator/types.ts`. It is a **join** of
git's reality and the run registry's reality, because neither alone can answer
the question:

```ts
export type BranchEntryStatus = 'active' | 'reviewable' | 'leftover' | 'orphan';

export interface BranchEntry {
  branch: string; // dispatch/t-abc…-r020122
  worktreePath?: string; // absent when the ref has no worktree
  worktreeExists: boolean; // directory actually present on disk
  dirty: boolean; // uncommitted work in that worktree
  lastCommitAt?: string; // committerdate of the branch tip
  ahead: number; // commits ahead of the merge base with base
  mergedIntoBase: boolean; // commits already landed on base

  // Present only when the run registry knows this branch
  runId?: string;
  taskId?: string;
  taskTitle?: string;
  runState?: RunState;
  baseBranch?: string;
  reviewedAt?: string;
  prUrl?: string;

  status: BranchEntryStatus;
}
```

`status` is **derived at read time, never stored** — it is a statement about the
current disagreement between git and the registry, and persisting it would let
it go stale:

| Condition                                              | `status`     | Actions offered     |
| ------------------------------------------------------ | ------------ | ------------------- |
| run exists, state **not** in `TERMINAL_RUN_STATES`     | `active`     | none (read-only)    |
| run exists, terminal, `reviewedAt` unset               | `reviewable` | Discard · Free disk |
| run exists, `reviewedAt` set, ref or dir still present | `leftover`   | Delete              |
| no run in registry for this branch                     | `orphan`     | Delete              |

`leftover` should not occur in normal operation; it means a prior `remove()`
failed silently (both its git calls swallow errors by design). Surfacing it is
how that failure becomes visible instead of invisible.

`ahead` and `mergedIntoBase` are computed against `baseBranch` when the registry
knows it, and against `WorktreeManager.defaultBaseBranch()` otherwise — an
orphan ref has no recorded base.

## 2. Enumeration

Five new read-only methods on `WorktreeManager`, all shelling out to real `git`
through the existing `runGit` helper:

- `listBranches(prefix: string)` —
  `for-each-ref --format='%(refname:short)%09%(committerdate:iso-strict)' refs/heads/<prefix>`
- `listWorktrees()` — `worktree list --porcelain`, parsed into
  `{ path, branch }[]`
- `aheadCount(branch, base)` — `rev-list --count <base>..<branch>`
- `isMergedInto(branch, base)` — `merge-base --is-ancestor <branch> <base>`
  (exit code 0 means merged)
- `isWorktreeDirty(path)` — `status --porcelain` run **in the worktree**, not in
  the main checkout

Then `Orchestrator.listBranches(): BranchEntry[]` left-joins those git results
against `registry.list()`, keyed on `meta.branch`.

Enumerating from **git** rather than from the registry is what makes orphans
visible at all — this is the exact asymmetry that causes the leak today, since
`pruneOrphans` scans the worktrees directory and therefore cannot see a ref
whose directory is gone.

The join is deliberately one-directional: git is authoritative for "does this
exist," the registry is authoritative for "what does it mean." Neither side is
mutated to agree with the other. Disagreement is surfaced as a `status` value
instead of being silently reconciled.

Registry entries whose branch ref is already gone are **not** listed — there is
nothing left to clean up, and listing them would turn every historical run into
permanent noise.

## 3. API

| Route                                            | Behavior                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `GET /api/branches`                              | returns `BranchEntry[]`                                                                                   |
| `POST /api/branches/free-disk` body `{ branch }` | persist diff snapshot → `worktree remove --force` → `prune`. **The ref survives.** Run meta is untouched. |
| `DELETE /api/branches/:encodedBranch`            | persist diff snapshot → `worktree remove --force` → `branch -D` → `prune`                                 |

Branch names contain `/`, so the `DELETE` path segment is URL-encoded and
decoded before use. Routing follows `api.ts`'s existing `segments`/`method`
pattern; a new top-level `segments[0] === 'branches'` block sits alongside the
`runs` block.

**Discard reuses the existing `POST /api/runs/:id/review { action: 'discard' }`
endpoint.** No new endpoint. The row action calls the path that already
snapshots the diff, removes worktree and branch, reopens the task to `todo`,
sets `reviewedAt`/`reviewAction`, fires review hooks, and broadcasts
`task.changed` + `run.changed`. Duplicating any of that would create a second
way for state to diverge.

Two new orchestrator methods back the two destructive routes:

- `freeWorktreeDisk(branch: string): BranchEntry` — snapshot (when a run is
  known), remove the directory, keep the ref. `meta.worktreePath` is left
  pointing at a directory that no longer exists; this is safe because `diff()`
  already tests `existsSync` before using it.
- `deleteBranch(branch: string, opts: { force?: boolean }): void` — the orphan /
  leftover / hard-delete path.

## 4. Guards

Both destructive routes throw `OrchestratorConflictError` (→ 409) when:

1. The branch backs a run **not** in `TERMINAL_RUN_STATES` — never touch a live
   agent's worktree while it is being written to.
2. The branch's run has an **open PR** — reuses `requireNoOpenPr`
   (`orchestrator.ts:951`) verbatim, which refuses whenever `meta.prUrl` is set,
   since tearing down the worktree and branch would break the very PR that
   points at them.
3. The branch is the main checkout's **currently checked-out branch** —
   `git branch -D` would fail anyway, but refusing with a named reason beats
   surfacing git's error text.
4. The branch is the `baseBranch` of another listed entry. This is the stacked
   case: deleting a blocker's branch destroys its dependents' merge base, which
   would silently corrupt every dependent's diff. The 409 names the dependent
   branch.

`DELETE` additionally refuses when `mergedIntoBase` is false, unless `?force=1`.
This makes the one genuinely irreversible operation — destroying unmerged
commits — require a deliberate second action in the UI rather than a single
click.

Guard 4 is evaluated against the same `listBranches()` result the caller saw, so
the check and the display cannot disagree about what depends on what.

Guard 4 is extracted as `Orchestrator.requireNoStackedDependent` and scoped to
the two raw branch actions here — **not** to `review(runId, 'discard')`, which
also removes a branch.

That split is by layer, and it is the point rather than an oversight. `DELETE`
and `free-disk` are pure git operations with no run bookkeeping to hang a marker
on, so refusing is the only way they can avoid corrupting a dependent.
`review()` does have that bookkeeping: discarding a blocker flags every
dependent with `baseDiscarded` (see the stacked-dispatch work) and the merge
queue refuses it later with a specific reason. That keeps a human free to reject
work without first dismantling everything stacked above it — and auto-rebasing a
dependent onto the default branch instead would silently strip the code it was
written against.

The guard has **no force escape hatch**, on purpose. Dependents form a DAG, so
its leaves are always cleanable right now, which means "clean up the dependent
first" always terminates. There is no legitimate case that needs to override it,
and every case that would override it corrupts a diff.

## 5. UI

New `apps/desktop/src/views/BranchesView.tsx`, reached from a new `'branches'`
member of the `ProjectView` union in `apps/desktop/src/lib/appNav.ts:15` and a
new sidebar entry in `Sidebar.tsx`'s `PROJECT_VIEWS`, placed between `runs` and
`pull-requests`.

Three groups, most-urgent first:

- **Orphaned** — `orphan` and `leftover` entries.
- **Needs review** — `reviewable` entries.
- **Active** — read-only. A live agent is working here.

`leftover` sits with the orphans rather than under "Needs review" (as an earlier
draft of this spec had it): a `leftover` run has _already_ been reviewed, so
asking for a review again would be wrong. What it actually shares with an orphan
is that nothing owns the ref anymore and no automatic path will reclaim it.

Each row shows: branch name, task title (when known), run-state chip, `↑N` ahead
count, a dirty indicator, and last-commit age. Row actions follow the status
table in §1.

The Orphaned group gets one bulk action: **Delete all merged orphans**. It is
the only bulk operation offered, because `mergedIntoBase` proves those commits
already landed on the base branch, making it the only bulk case with no
data-loss risk.

The view refreshes off the existing `run.changed` WebSocket broadcast and offers
a manual refresh, since git state can change outside the app entirely.

New client methods in `packages/client/src/api.ts` mirroring the three routes,
plus the `BranchEntry` type mirrored there the same way `RunMeta` already is.

## 6. Testing

- `packages/server/test/orchestrator/worktree.test.ts` — real temp git repos:
  ref and worktree-list parsing, ahead counts, merged detection, dirty detection
  in a worktree.
- `packages/server/test/orchestrator/orchestrator.test.ts` — the join produces
  the right `status` for each of the four cases; each of the four guards refuses
  with a 409-mapped error; and the load-bearing assertion: after
  `freeWorktreeDisk`, `diff(runId)` still returns the snapshot content.
- `packages/server/test/runs-api.test.ts` (or a sibling) — the three new routes,
  including URL-encoded branch names containing `/`.

## Verification

Per `AGENTS.md`, from the monorepo root after implementation:

```bash
export AGENT=1
bun run format
bun run lint
```

Plus `bun run tsc` in `packages/server`, `packages/client`, and `apps/desktop`,
and the focused test files listed above.
