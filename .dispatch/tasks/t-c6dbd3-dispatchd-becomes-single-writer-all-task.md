---
id: t-c6dbd3
title: "dispatchd becomes single writer: all task I/O through the daemon store"
status: in-progress
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-7cc78a
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:17.943Z
updated: 2026-08-23T13:15:25.831Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/mcp/src/**
  - packages/cli/src/**
---

## Description

Route every task/finding/ledger read and write through dispatchd's SQLite-backed store: daemon HTTP/WS endpoints, MCP tools (task_save, task_list, task_get, task_next, record_* tools), and CLI commands all talk to the daemon instead of touching files directly. The daemon is the only process holding the DB. Existing two-tier token auth (agentToken/appToken) is unchanged. UI real-time updates ride the existing WS channel — no polling.

## Acceptance Criteria

## Activity
- 2026-08-23T01:15:42.851Z dispatched (claude, branch dispatch/t-c6dbd3-dispatchd-becomes-single-writer-all-task-e0be91) — human:wsoule679
- 2026-08-23T02:50:27.894Z Starting t-c6dbd3. Scope request for packages/mcp/test/** + packages/cli/test/** timed out undecided (~89min, no responder), so treating it as denied and staying inside the declared fence: packages/{server,mcp,cli}/src + packages/server/test. Consequence for design: the change must be backward compatible so the existing packages/cli/test/task-*.test.ts and packages/mcp/test/*.test.ts stay green untouched — i.e. daemon-first with a direct-store fallback when no daemon is running, rather than a hard "start dispatchd" error. New coverage for the daemon-proxy path goes in packages/server/test/**. Plan: (1) daemon holds ProjectStores behind core's TaskStorePort seam instead of a concrete TaskStore, with findings/ledger routed to the same backend; (2) MCP task_list/task_get/task_save/task_next proxy the daemon HTTP API like task_comment/record_* already do; (3) `dispatch task *` proxies the daemon via findRunningDaemon (no auto-spawn). Backend default stays `files` — the SQLite flip belongs with the migration task t-880ce2, which is blocked by this one. — none
- 2026-08-23T13:15:12.808Z [run r-e0be91] flagged interrupted-dirty: 15 uncommitted path(s) found — none
- 2026-08-23T13:15:12.837Z [run r-e0be91] flagged interrupted-dirty: 15 uncommitted path(s) found — none
- 2026-08-23T13:15:25.831Z requested changes (run r-a65e6c): dispatchd wedged at 100% CPU on its main thread and had to be restarted; your run was force-failed but your worktree (api.ts, cache.ts, findings.ts, ledger.ts, linear/sync.ts in progress) is intact. Continue the single-writer wiring from where you left off. — human:wsoule679
