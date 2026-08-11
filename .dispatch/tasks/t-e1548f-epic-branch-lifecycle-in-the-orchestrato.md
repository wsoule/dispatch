---
id: t-e1548f
title: Epic branch lifecycle in the orchestrator
status: todo
kind: task
parent: e-b7ca6f
milestone: null
blocked-by: []
labels:
  - orchestrator
priority: high
assignee: none
created: 2026-08-10T23:19:42.000Z
updated: 2026-08-10T23:19:42.000Z
external: null
writes: []
---

## Description

Create and maintain `epic/<id>` branches: cut from the default branch on the epic's first dispatch; dispatch of any task under the epic uses it as `baseBranch` (the plumbing stacked runs already use); review()'s merge for those runs targets the epic branch instead of the main checkout's branch; keep the epic branch updated against main (surface drift rather than silently rebasing). Decide and document what happens to in-flight child runs when the epic branch moves — the merge queue's restack machinery is the likely reuse point.

## Acceptance Criteria

- Dispatching a task whose parent epic has a branch cuts the run from `epic/<id>`, and review-merge lands it there, not on main.
- An epic's branch is created lazily and visible in the UI wherever run branches are.
- Child runs restack (or flag, mirroring baseDiscarded) when the epic branch moves under them.

## Activity
