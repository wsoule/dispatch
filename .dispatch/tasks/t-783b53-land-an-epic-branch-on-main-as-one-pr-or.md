---
id: t-783b53
title: Land an epic branch on main as one PR or one merge
status: in-progress
kind: task
parent: e-b7ca6f
milestone: null
blocked-by:
  - t-e1548f
labels:
  - orchestrator
  - ui
priority: medium
assignee: none
created: 2026-08-10T23:19:42.000Z
updated: 2026-08-11T21:01:02.672Z
external: null
writes: []
---

## Description

A "land this epic" action once its tasks are done: open one PR from `epic/<id>` to main via the PrManager path (push, `gh pr create`, poll to merged — reusing the existing poller), or do a local merge when there is no remote. Landing closes out the epic the way review-merge closes out a run: epic status flips, the branch is cleaned up, and the epic's diff snapshot is preserved for the review surface. Blocked-by the lifecycle task since there is nothing to land until child runs merge into the epic branch.

## Acceptance Criteria

- One action takes a finished epic branch to main (PR when the project has the pr capability, local merge otherwise) and marks the epic done.
- Partially-done epics refuse to land with a clear message rather than landing half an epic silently.

## Activity
- 2026-08-11T18:02:20.429Z dispatched (claude, branch dispatch/t-783b53-land-an-epic-branch-on-main-as-one-pr-or-65842a) — none
- 2026-08-11T18:11:18.514Z Plan settled after reading the epic-branch lifecycle commit (550d2988): POST /api/epics/:id/land is the one action. Orchestrator gains epicLandStatus (validation: kind/status/branch-exists/all-children-done-or-cancelled/no unreviewed runs on the branch), landEpicLocally (true --no-ff merge into the default base — checkout path with mergeRun's gates when the base is checked out, checkout-free merge-tree/commit-tree/update-ref plumbing otherwise), epicDiff + snapshot at diffSnapshotPath(rootDir, epicId), markEpicMergedViaPr. PrManager gains openEpicPr (push epic branch, gh pr create --base <default>) with a persisted epic-prs.json ledger the existing pollOnce also walks, so a daemon restart keeps polling. API picks PR vs local merge off prCapability. Client landEpic/fetchEpicDiff + a Land button on EpicCardTile when all children are done. — none
- 2026-08-11T18:14:06.802Z [run r-65842a] finished: failed — 0 files, $11.58 — agent:wsoule679/claude
- 2026-08-11T21:01:02.672Z requested changes (run r-40ae50): Continue where you left off. Re-read the task and your own transcript above first, then pick up from the last thing you were doing. — human:wsoule679
