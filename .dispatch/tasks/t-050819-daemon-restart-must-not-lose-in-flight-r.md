---
id: t-050819
title: "Daemon restart must not lose in-flight runs: auto-resume on boot and on
  re-dispatch"
status: in-progress
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
  - resilience
priority: high
assignee: none
created: 2026-08-22T18:01:32.916Z
updated: 2026-08-22T18:01:41.464Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/cli/src/**
  - packages/client/src/**
---

## Description

Incident 2026-08-22: dispatchd restarted while three runs were in flight; all were force-failed by reconcileOnBoot (orchestrator.ts:3023) and one nearly-complete run (r-d236d7, session and worktree fully intact) was lost — re-dispatching its task via `dispatch run` spawned a FRESH run and the work had to be salvaged by hand-messaging the new agent.

All the machinery already exists: resumeRun (orchestrator.ts:3827) resumes with the same worktree, branch, sessionId, model, and claims — but its only caller is the human pressing Resume in the UI. Close three gaps:

1. reconcileOnBoot: after the existing survey settles, a force-failed run that is resumable — unreviewed, has a sessionId, worktree present, not already resumed — is auto-resumed through the resumeRun path instead of left dead. HAZARD: the orphaned agent process can survive the restart and keep committing (see stampOrphanWork, orchestrator.ts:1602) — never auto-resume while the orphan is provably alive or the branch is still gaining post-fail commits; defer and retry rather than fight the orphan for the worktree.
2. `dispatch run <taskId>`: when the task's most recent run is failed/interrupted-dirty, unreviewed, and resumable, resume it (resumedFrom chain) instead of spawning fresh; add --fresh to force a new run.
3. Expose resume directly: `dispatch run resume <runId>` calling the same daemon endpoint the UI uses.

Tests: extend packages/server/test/resilience.test.ts — restart mid-run with a fake executor, assert the run continues via a resumedFrom successor in the same worktree with no work lost; assert the orphan-alive case defers. Keep api.ts surface changes minimal — a live run currently claims that file.

## Acceptance Criteria

## Activity
- 2026-08-22T18:01:41.464Z dispatched (claude, branch dispatch/t-050819-daemon-restart-must-not-lose-in-flight-r-5d4d11) — human:wsoule679
