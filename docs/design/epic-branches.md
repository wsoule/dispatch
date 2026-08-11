# Epic integration branches

An epic can own an integration branch, `epic/<id>`. Tasks under the epic land on
it one squash commit at a time, and the epic eventually lands on the default
branch as a unit — reviewable and revertible as one thing, instead of
interleaving with unrelated work commit by commit.

This document records the lifecycle decisions the orchestrator implements
(`packages/server/src/orchestrator/epicBranch.ts` and its call sites), in
particular what happens to in-flight child runs when the epic branch moves.

## Lifecycle

- **Created lazily.** The first dispatch of a child task cuts `epic/<id>` from
  the project's default base branch (`Orchestrator.ensureEpicBranchFor`, called
  from `resolveBase`). An epic whose children never dispatch never grows a
  branch. Creation is recorded on the epic's Activity log.
- **Used as the dispatch base.** Every unblocked child task dispatches with
  `baseBranch: epic/<id>` — the same `baseBranch` plumbing stacked runs already
  use for non-default bases. A child stacked on an in-review sibling keeps
  stacking semantics unchanged: its base is the sibling's branch, which is
  itself rooted on the epic branch.
- **Merged onto, never through, the main checkout.** `review(id, 'merge')` for a
  run based on an epic branch squash-merges in the object database
  (`WorktreeManager.squashMergeIntoRef`: `git merge-tree --write-tree` +
  `commit-tree` + a compare-and-swap `update-ref`). The user's checkout is never
  touched, so none of the main-checkout environment gates apply. The one
  exception: if the user has the epic branch itself checked out, the normal
  checkout merge path runs instead, gates and all — moving a ref under a live
  working tree is exactly what the plumbing path must not do.
- **Visible with run branches.** `Orchestrator.listBranches` lists `epic/*` refs
  alongside `dispatch/*` refs with the dedicated status `'epic'`, so the Git
  surface shows them, guards them (they can't be swept as orphans), and offers
  the usual guarded deletion. Deleting an epic branch that still has unreviewed
  child runs based on it is refused by the existing "branch is the base of X"
  guard.
- **Hand merges reconcile.** `reconcileExternallyMergedRuns` checks each run
  against its recorded `baseBranch`, so a child branch merged into the epic
  branch by hand is detected and closed exactly like a hand merge into main.

## What happens when the epic branch moves

Decision: **dispatch never rewrites an epic branch — it only ever moves
forward.** The two forward moves are a sibling's squash commit landing and a
human merging the default branch into it. Dispatch never rebases it, and
updating it against main is deliberately a human action; the orchestrator only
**surfaces drift** (`BranchEntry.behindBase`, shown as an "N behind main" chip
in the Git view) rather than silently repairing it.

Because the branch only moves forward, in-flight child runs never sit on
rewritten history, and the cases reduce to:

- **A sibling lands on the epic branch.** Nothing happens to other in-flight
  children immediately — the same contract concurrent runs on the default branch
  have today. At merge time the merge queue's existing rebase step brings each
  run onto the epic branch's current tip before verifying and merging, so
  late-landing runs still merge cleanly (or fail the queue entry with a named
  conflict).
- **A run was stacked on the sibling that just landed.** The merge queue's
  existing restack machinery (`MergeQueue.restackDependents` → `restackRun`)
  moves it onto the merged blocker's own base — which for a sibling under the
  same epic _is_ the epic branch. No new machinery.
- **The blocker landed somewhere other than the epic branch** (a cross-epic
  blocker that merged to main, or to another epic's branch). Restacking the
  dependent onto that base would carry the epic's work away from the epic
  branch; restacking onto the epic branch would drop the blocker's content.
  Neither guess is safe, so the run is **flagged** (`baseDiscarded`, with a
  reason naming both branches) — mirroring the discarded-base treatment — and
  the merge queue refuses it until a human resolves it, typically by merging the
  base into the epic branch and re-enqueueing.
- **The epic branch is deleted by hand while children are in flight.** Merge
  refuses with a named conflict ("epic branch no longer exists"); the
  branch-deletion surface refuses in the first place while unreviewed child runs
  still claim the branch as their base.

## PRs

The PR review action for a child run targets the epic branch
(`gh pr create --base epic/<id>`); `PrManager.openPr` pushes the epic branch to
origin first so the base ref exists there.

## Out of scope (for the branch lifecycle)

Landing the finished epic on the default branch — one PR or one local merge — is
the epic-level "land" action, tracked separately in the epic (e-b7ca6f). Until
it lands, tasks merged onto an epic branch are `done` but their merge commits
are not on origin's default base, so `reconcileArchives` leaves them visible,
which is correct: the work has not reached main yet.
