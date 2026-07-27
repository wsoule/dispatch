# Run disk cleanup

**Date:** 2026-07-26 **Status:** approved, ready for implementation plan

## Problem

Run state on disk grows without bound and nothing surfaces the cost. Measured on
one project after a day of dispatching:

```
~/.dispatch/worktrees/<hash>/   1.9G   (3 worktrees)
~/.dispatch/runs/<hash>/        960K   (17 transcripts, 6 diff snapshots)
```

Two facts reframe what cleanup should do, and both contradict the obvious
design.

**Worktrees are already freed on review.** `review()` calls
`persistDiffSnapshot` then `worktrees.remove` on every path — local merge,
discard, and PR merge (see `orchestrator.ts`). There is no leak to fix there.
All three surviving worktrees belong to runs that are terminal but
**unreviewed**, which legitimately still hold their checkouts.

**The disk cost is almost entirely reinstallable dependencies:**

```
r-47cdd2   total 648M   node_modules 641M
r-9954a6   total 699M   node_modules 641M
r-b1d725   total 649M   node_modules 641M
```

99% of a worktree is `node_modules`. The source checkout — the part that makes a
run reviewable — is about 7MB.

This makes today's `free-disk` action the wrong shape for the common case: it
removes the whole worktree directory, discarding the 7MB that has value in order
to reclaim the 641MB that does not need to be discarded at all. It is the right
tool only when you want the directory genuinely gone.

The dependency bloat is also partly self-inflicted: `verifyCommand` begins with
`bun install --frozen-lockfile`, so every entry the merge queue verifies leaves
a fully populated `node_modules` behind.

## Design

### 1. Trim — a new primitive, distinct from free-disk

`trimWorktree(runId)` deletes `node_modules` and `dist` directories from a
terminal run's worktree, leaving the checkout, the branch, and the run's
reviewability intact.

Reclaims ~641MB per run at no cost:

- `diff()` is pure git and never needed `node_modules`.
- The branch ref is untouched, so the run stays mergeable.
- It self-heals: `verifyCommand` starts with `bun install`, so if the run is
  later enqueued, verify repopulates what it needs.

Trim runs automatically once a run is terminal **and** has no in-flight
merge-queue entry. That second condition matters — trimming a worktree
mid-verify would delete dependencies out from under a running test suite.

`free-disk` stays as-is for the heavier "remove the directory entirely" case.

### 2. Bulk close-out for never-reviewable runs

One action that discards every run which cannot meaningfully be reviewed:

- **Cancelled** runs. A human already stopped these; nobody will review them.
- **Superseded** runs: a terminal run whose branch carries a newer run.

Superseded needs a precise definition because runs share branches — a resume
reuses its predecessor's branch and worktree. A run is superseded when another
run with the same `branch` has a later `createdAt`. `r-47cdd2` is the clean
example: `r-75a646` resumed the same branch and finished, so reviewing
`r-47cdd2` is meaningless — its worktree is shared and its work is a subset.

This is why the run count so overstates the work: 17 runs across roughly 8 real
branches, including five runs on one branch from a single sequence of resume
attempts.

Discarding uses the existing `review(runId, 'discard')` path rather than a new
deletion mechanism, so worktree and branch removal, the diff snapshot, and task
bookkeeping all behave exactly as a manual discard does.

### 3. Disk-usage view

A surface listing per-run disk cost, split into checkout versus dependencies,
with Trim and Discard actions inline and a project total. The point is that this
condition surfaces itself rather than requiring `du` and someone noticing.

### Explicitly not doing: transcript pruning

Transcripts and diff snapshots total 960K — 0.05% of the footprint — and they
are the durable record that survives a daemon restart, backs the run list, and
feeds `replayTranscript`. Deleting them trades the entire history for a rounding
error.

## Testing

- **Trim:** against a real temp worktree with a stub `node_modules` — assert it
  is gone, the checkout and branch survive, and `diff()` still returns the same
  patch afterward. That last assertion is the one that matters; it is the
  property trim exists to preserve.
- **Trim safety:** a run with an in-flight queue entry is skipped.
- **Superseded detection:** a pure function over `RunMeta[]` (group by `branch`,
  newest `createdAt` wins), tested directly — including the shared-branch resume
  case, since that is the whole reason the naive per-run reading is wrong.
- **Bulk close-out:** an API test asserting it discards exactly the cancelled +
  superseded set **and leaves every reviewable run untouched**. The second half
  is the important assertion: the failure mode is discarding work someone still
  wanted.

## Acceptance criteria

- `trimWorktree` reclaims `node_modules`/`dist` while leaving the run
  reviewable; `diff()` verified working after a trim.
- Trim is skipped for runs with an in-flight merge-queue entry.
- Terminal runs are trimmed automatically.
- Bulk close-out discards cancelled and superseded runs via the existing discard
  path, and provably touches nothing reviewable.
- A disk-usage surface shows per-run checkout vs dependency bytes with inline
  actions.
- `bun run format`, `bun run lint`, and `bun test packages/server` clean.
