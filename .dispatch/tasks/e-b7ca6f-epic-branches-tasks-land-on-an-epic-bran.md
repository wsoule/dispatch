---
id: e-b7ca6f
title: "Epic branches: tasks land on an epic branch, the epic lands on main"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
priority: high
assignee: none
created: 2026-08-10T23:19:42.000Z
updated: 2026-08-11T16:48:31.530Z
external: null
writes: []
---

## Description

Today every run branches off the project default branch and merges straight back, so an epic's tasks land on main one by one, interleaved with unrelated work, and there is no way to review or revert the epic as a unit. Give an epic its own integration branch: dispatching a task under the epic cuts the run branch from `epic/<id>` instead of main, review-merge lands it back on `epic/<id>`, and when the epic is done the whole branch goes to main as one PR (or one local merge).

Most of the machinery half-exists: runs already carry `baseBranch` (stacked runs prove non-main bases work end to end via `stackParents`/`stackBaseCommit`), the merge queue already restacks dependents when a base moves, and the PR path already pushes and polls. The missing piece is the epic-branch lifecycle: create on first dispatch, retarget child runs at it, keep it rebased/merged against main as main moves, and a "land this epic" action.

The external-merge reconciler (reconcileExternallyMergedRuns) checks each run against its recorded `baseBranch`, so runs merged into an epic branch by hand will reconcile the same way runs on main do.

## Acceptance Criteria

## Activity
- 2026-08-11T16:48:31.530Z [epic] epic dispatch started (concurrency 3) — human:wsoule679
