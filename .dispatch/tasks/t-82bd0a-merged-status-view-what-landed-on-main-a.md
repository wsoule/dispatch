---
id: t-82bd0a
title: "Merged-status view: what landed on main and what is still out"
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - ui
priority: high
assignee: none
created: 2026-08-10T23:19:42.000Z
updated: 2026-08-10T23:19:42.000Z
external: null
writes: []
---

## Description

There is no single surface answering "which run branches have landed on main and which are still out?" — today it takes `git branch` + merge-base checks by hand (which is how four Aug 4 run branches sat unnoticed for a week). Build a view (or a Branches-view upgrade) that buckets every run branch: merged & reviewed, merged & pushed to origin, awaiting review, and stale/abandoned.

The data is already server-side: `reviewedAt`/`reviewAction`/`mergeCommit` on RunMeta, `isOnOriginBase` for pushed state, and the new external-merge reconciler (`reconcileExternallyMergedRuns` in orchestrator.ts) which closes out hand-merged runs — so "merged but showing NEEDS REVIEW" should no longer be a state this view has to represent, but "merged locally, not pushed" and "unmerged, base has moved N commits" are.

## Acceptance Criteria

- One screen shows every run branch with its merged/unmerged status vs the project base branch, without the user running git commands.
- Merged-locally-but-not-pushed is visually distinct from pushed.
- Unmerged branches show how far behind the base they've fallen.

## Activity
