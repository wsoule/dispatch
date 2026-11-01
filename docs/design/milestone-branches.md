# Milestone integration branches

A milestone can own an integration branch, `milestone/<id>`. Tasks under the
milestone land on it one squash commit at a time, and the milestone eventually
lands on the default branch as a unit — reviewable and revertible as one thing,
instead of interleaving with unrelated work commit by commit.

This document records the lifecycle decisions the orchestrator implements
(`packages/server/src/orchestrator/milestoneBranch.ts` and its call sites), in
particular what happens to in-flight child runs when the milestone branch moves.

## Lifecycle

- **Created lazily.** The first dispatch of a child task cuts `milestone/<id>`
  from the project's default base branch
  (`Orchestrator.ensureMilestoneBranchFor`, called from `resolveBase`). A
  milestone whose children never dispatch never grows a branch. Creation is
  recorded on the milestone's Activity log.
- **Used as the dispatch base.** Every unblocked child task dispatches with
  `baseBranch: milestone/<id>` — the same `baseBranch` plumbing stacked runs
  already use for non-default bases. A child stacked on an in-review sibling
  keeps stacking semantics unchanged: its base is the sibling's branch, which is
  itself rooted on the milestone branch.
- **Merged onto, never through, the main checkout.** `review(id, 'merge')` for a
  run based on a milestone branch squash-merges in the object database
  (`WorktreeManager.squashMergeIntoRef`: `git merge-tree --write-tree` +
  `commit-tree` + a compare-and-swap `update-ref`). The user's checkout is never
  touched, so none of the main-checkout environment gates apply. The one
  exception: if the user has the milestone branch itself checked out, the normal
  checkout merge path runs instead, gates and all — moving a ref under a live
  working tree is exactly what the plumbing path must not do.
- **Visible with run branches.** `Orchestrator.listBranches` lists `milestone/*`
  refs alongside `dispatch/*` refs with the dedicated status `'milestone'`, so
  the Git surface shows them, guards them (they can't be swept as orphans), and
  offers the usual guarded deletion. Deleting a milestone branch that still has
  unreviewed child runs based on it is refused by the existing "branch is the
  base of X" guard.
- **Hand merges reconcile.** `reconcileExternallyMergedRuns` checks each run
  against its recorded `baseBranch`, so a child branch merged into the milestone
  branch by hand is detected and closed exactly like a hand merge into main.

## What happens when the milestone branch moves

Decision: **dispatch never rewrites a milestone branch — it only ever moves
forward.** The two forward moves are a sibling's squash commit landing and a
human merging the default branch into it. Dispatch never rebases it, and
updating it against main is deliberately a human action; the orchestrator only
**surfaces drift** (`BranchEntry.behindBase`, shown as an "N behind main" chip
in the Git view) rather than silently repairing it.

Because the branch only moves forward, in-flight child runs never sit on
rewritten history, and the cases reduce to:

- **A sibling lands on the milestone branch.** Nothing happens to other
  in-flight children immediately — the same contract concurrent runs on the
  default branch have today. At merge time the merge queue's existing rebase
  step brings each run onto the milestone branch's current tip before verifying
  and merging, so late-landing runs still merge cleanly (or fail the queue entry
  with a named conflict).
- **A run was stacked on the sibling that just landed.** The merge queue's
  existing restack machinery (`MergeQueue.restackDependents` → `restackRun`)
  moves it onto the merged blocker's own base — which for a sibling under the
  same milestone _is_ the milestone branch. No new machinery.
- **The blocker landed somewhere other than the milestone branch** (a
  cross-milestone blocker that merged to main, or to another milestone's
  branch). Restacking the dependent onto that base would carry the milestone's
  work away from the milestone branch; restacking onto the milestone branch
  would drop the blocker's content. Neither guess is safe, so the run is
  **flagged** (`baseDiscarded`, with a reason naming both branches) — mirroring
  the discarded-base treatment — and the merge queue refuses it until a human
  resolves it, typically by merging the base into the milestone branch and
  re-enqueueing.
- **The milestone branch is deleted by hand while children are in flight.**
  Merge refuses with a named conflict ("milestone branch no longer exists"); the
  branch-deletion surface refuses in the first place while unreviewed child runs
  still claim the branch as their base.

## PRs

The PR review action for a child run targets the milestone branch
(`gh pr create --base milestone/<id>`); `PrManager.openPr` pushes the milestone
branch to origin first so the base ref exists there.

## Landing the milestone

`POST /api/milestones/:id/land` is the one action that takes a finished
milestone branch to the default base (`Orchestrator.milestoneLandStatus`
validates; the desktop surfaces it as the Land button on the milestone's board
card once every child is done):

- **Readiness is all-or-nothing.** Every child task must be `done` or
  `cancelled`; anything at `todo`/`in-progress`/`in-review` refuses with a 409
  naming the pending children — a partially-done milestone never lands silently.
  A leftover unreviewed run still based on the branch also refuses, since
  landing deletes the ref that run's diff and merge are anchored on.
- **PR when the project has the `pr` capability** (and the branch carries
  commits): `PrManager.openMilestonePr` pushes `milestone/<id>` and opens one PR
  against the default base; the existing merge poller then flips the milestone
  to `done` (`Orchestrator.markMilestoneMergedViaPr`) when GitHub reports it
  merged. Open milestone PRs persist in an `milestone-prs.json` ledger, so a
  daemon restart keeps polling. A PR closed without merging drops the ledger
  entry (with an Activity line) so the milestone can be landed again.
- **One local `--no-ff` merge otherwise** (`Orchestrator.landMilestoneLocally`):
  a real merge commit with both parents, so the per-task squash commits survive
  and the milestone reverts as one unit. Mirrors `mergeRun`'s two paths — the
  gated checkout merge when the default base is checked out, the checkout-free
  merge-tree/commit-tree/update-ref plumbing when it is not.
- **Closing out matches review-merge**: the milestone's diff against the base is
  snapshotted (served by `GET /api/milestones/:id/diff` after the branch is
  gone), the local `milestone/<id>` ref is deleted, and the milestone's status
  flips to `done` with an Activity line naming how it landed.

Until a milestone lands, tasks merged onto its branch are `done` but their merge
commits are not on origin's default base, so `reconcileArchives` leaves them
visible, which is correct: the work has not reached main yet.
