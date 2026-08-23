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
updated: 2026-08-23T13:59:41.621Z
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
- 2026-08-23T13:59:41.621Z Implementation committed in three slices: d6acc119 (server holds the store behind core's TaskStorePort, plus FindingStorePort/LedgerStorePort; backend from DISPATCH_STORE_BACKEND, still defaulting to `files` until the t-880ce2 import ships), e808bbed (MCP task_list/get/save/next proxy the daemon; task_comment's proxy auth fixed), 8786fb61 (`dispatch task *` proxies the daemon via a new TaskApiClient). Two bugs found and fixed along the way, both caught by driving the real surfaces rather than the stores: (1) openProjectStores only ATTACHES, so a sqlite daemon with no database on disk 500'd on every write — startServer now uses initProjectStores for that backend, since the daemon is the only process permitted to create it; (2) task_comment's daemon proxy never sent an Authorization header, so it 401'd and silently fell back to writing markdown, losing agent attribution on every call since the proxy was added. Safety guard on both surfaces: with a database present and no daemon, the tools/commands refuse rather than opening a second handle — mutation-tested (2 tests fail in MCP, 1 in CLI when the guard is reverted). Scope note: packages/{mcp,cli}/test were denied, so both existing suites are untouched and green (116 and 194), which is itself the backward-compatibility proof for the no-daemon fallback; the new daemon-path coverage lives in packages/server/test/{store-backend,mcp-task-proxy,cli-task-proxy}.test.ts (36 tests). cli-task-proxy.test.ts belongs in packages/cli/test and says so in its header — please move it when someone has that scope. — none
