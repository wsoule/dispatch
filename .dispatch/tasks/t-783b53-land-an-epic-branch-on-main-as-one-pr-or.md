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
updated: 2026-08-11T18:02:20.429Z
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
