---
id: t-82bd0a
title: "Merged-status view: what landed on main and what is still out"
status: done
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - ui
priority: high
assignee: none
created: 2026-08-10T23:19:42.000Z
updated: 2026-08-11T18:10:45.118Z
external: null
writes: []
archived-at: 2026-08-11T18:10:45.118Z
---

## Description

There is no single surface answering "which run branches have landed on main and which are still out?" — today it takes `git branch` + merge-base checks by hand (which is how four Aug 4 run branches sat unnoticed for a week). Build a view (or a Branches-view upgrade) that buckets every run branch: merged & reviewed, merged & pushed to origin, awaiting review, and stale/abandoned.

The data is already server-side: `reviewedAt`/`reviewAction`/`mergeCommit` on RunMeta, `isOnOriginBase` for pushed state, and the new external-merge reconciler (`reconcileExternallyMergedRuns` in orchestrator.ts) which closes out hand-merged runs — so "merged but showing NEEDS REVIEW" should no longer be a state this view has to represent, but "merged locally, not pushed" and "unmerged, base has moved N commits" are.

## Acceptance Criteria

- One screen shows every run branch with its merged/unmerged status vs the project base branch, without the user running git commands.
- Merged-locally-but-not-pushed is visually distinct from pushed.
- Unmerged branches show how far behind the base they've fallen.

## Activity
- 2026-08-11T16:48:46.596Z dispatched (claude, branch dispatch/t-82bd0a-merged-status-view-what-landed-on-main-a-b23d3a) — human:wsoule679
- 2026-08-11T16:53:35.734Z Plan settled after orientation: (1) server — add `behindBase` to BranchEntry (computed in listBranches only for unmerged refs) and extend `pushedToOrigin` to cover merged branches with no registry mergeCommit (hand-merged orphans) by checking the branch tip against origin/base; (2) client — mirror the field; (3) desktop — new "Landed" screen (nav id `landed`, sidebar Git group) bucketing every run branch via a pure lib: merged & pushed / merged local-only / awaiting review / agent running / abandoned (orphan+leftover), with behind-base counts on unmerged rows. Worktree is fresh — running bun install + build now. — none
- 2026-08-11T17:32:47.243Z Implementation committed in 3 slices: (1) server+client — BranchEntry.behindBase (unmerged only) + pushedToOrigin tip-fallback for hand-merged refs, with 4 new tests; (2) desktop — Landed view (sidebar Git group, cmd+8, palette entry) bucketing awaiting-review / in-progress / abandoned / merged-local / merged-pushed. Key design point found in self-review: merged refs are deleted by review('merge'), so landed rows are sourced from the run registry (reviewedAt+reviewAction, archived excluded, PR merges pushed by definition, no-op merges have nothing to push), deduped against surviving leftover refs; (3) Refresh now invalidates runs alongside branches. 5 guards mutation-tested, all killed (1-2 failures each). Desktop suite 1242/0, focused server suites green, format/lint/knip clean. Waiting on the full server suite for final confirmation. — none
- 2026-08-11T17:33:06.986Z [run r-b23d3a] finished: finished — 15 files, $28.19 — agent:wsoule679/claude
- 2026-08-11T18:02:12.388Z run r-b23d3a merged into main — human:wsoule679
