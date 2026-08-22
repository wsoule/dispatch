---
id: t-7cc78a
title: SQLite-backed TaskStore implementation behind the existing store seam
status: in-progress
kind: task
parent: e-99e113
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:37:48.803Z
updated: 2026-08-22T18:07:56.097Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
---

## Description

Add a SQLite-backed implementation of the TaskStore interface (packages/core/src/store.ts, ~315 lines) alongside the current filesystem one. taskfile.ts parse/serialize stays pure and reused. Schema covers tasks, epics, findings, ledger entries, decisions, and evidence — everything the JSONL sidecars hold today. Selection between backends stays a construction-time choice so the daemon can adopt it next. Keep packages/core/src/browser.ts pure (no node:sqlite in the browser entry point).

## Acceptance Criteria

## Activity
- 2026-08-22T17:33:44.308Z dispatched (claude, branch dispatch/t-7cc78a-sqlite-backed-taskstore-implementation-b-d236d7) — human:wsoule679
- 2026-08-22T17:55:26.197Z [run r-d236d7] flagged interrupted-dirty: 12 uncommitted path(s) found — none

- 2026-08-22T17:56:52.867Z dispatched (claude, branch dispatch/t-7cc78a-sqlite-backed-taskstore-implementation-b-664ec2) — human:wsoule679

- 2026-08-22T18:03:48.547Z [run r-664ec2] flagged interrupted-dirty: 12 uncommitted path(s) found — none
- 2026-08-22T18:07:56.097Z requested changes (run r-2ca940): You were interrupted by a dispatchd restart (a dev build was bouncing the daemon — now resolved). Your worktree and progress are intact; the survey above lists what was uncommitted. Continue from where you left off, re-verifying anything mid-flight when you stopped. — human:wsoule679
