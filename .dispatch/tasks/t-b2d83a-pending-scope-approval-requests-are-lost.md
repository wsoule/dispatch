---
id: t-b2d83a
title: Pending scope/approval requests are lost on daemon restart and never re-surface
status: todo
kind: task
parent: e-ac6705
milestone: null
blocked-by: []
labels:
  - orchestrator
  - resilience
priority: high
assignee: none
created: 2026-08-23T15:09:34.933Z
updated: 2026-08-23T15:11:43.847Z
external: null
writes: []
---

## Description

Incident 2026-08-23: run r-6dd770 (t-880ce2) had an undecided scope request open; the user relaunched the Dispatch app, dispatchd restarted, reconcileOnBoot force-failed the run, and the approval dialog disappeared permanently — the pending request was neither re-displayed after reboot nor attached to the resumed successor run. The human's only path was asking the agent to re-issue the request. Scope/approval requests awaiting a decision should survive a daemon restart: persist them, re-surface undecided ones after reconcileOnBoot (attached to the force-failed run or its resumed successor), and let the decision feed (e-6cfcc7) list them. Related: t-050819 (merged, auto-resume), t-bb4d21 (daemon spin), t-ed735b (zero-turn resume).

## Acceptance Criteria

## Activity
