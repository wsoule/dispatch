---
id: t-bb4d21
title: "dispatchd busy-loop: main thread pegs at 100% CPU, daemon goes unresponsive"
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
  - resilience
  - performance
priority: high
assignee: none
created: 2026-08-23T13:46:02.527Z
updated: 2026-08-23T13:46:02.527Z
external: null
writes: []
---

## Description

Incident 2026-08-23 (~01:20 onward): the installed dispatchd (PID 58214, ~18h uptime, Dispatch.app build) pegged its MAIN thread at 100% CPU and stopped answering — CLI 'dispatch runs' hung past 120s, MCP task_comment/task_save hung to the 1800s idle timeout, process stayed alive. A 2s sample showed all 1515 samples in one synchronous call path on the main thread (stripped binary, no symbols — the shape is a hot loop, not slow I/O). Conditions: one execute run in flight (r-e0be91), a large run registry (~40 runs, several carrying multi-KB error strings), continuous board JSONL churn, a concurrent session active. SIGTERM did not exit it promptly; the app respawned a healthy daemon after kill.

Investigate candidate main-path hot loops: runs listing serialization (dispatch runs --json was already truncating on the large registry earlier the same day), fix-loop advance/stall rechecks, merge-queue refresh tick, survey scheduling re-entry. Repro lead: registry with many terminal runs carrying large error payloads + an active run. Include a watchdog (log a stack when the event loop stalls >N seconds) so the next spin is diagnosable. Related resilience cluster: t-050819 (merged), t-350f21, t-ed735b. NOTE: the session-long MCP stdio server also wedged permanently once the daemon spun and never recovered after the daemon restart — check whether the MCP server holds a daemon connection it should re-establish.

## Acceptance Criteria

## Activity
