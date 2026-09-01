---
id: t-c6dbd3
title: "dispatchd becomes single writer: all task I/O through the daemon store"
status: done
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-7cc78a
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:17.943Z
updated: 2026-09-01T19:11:10.512Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/mcp/src/**
  - packages/cli/src/**
archived-at: 2026-09-01T19:11:10.512Z
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
- 2026-08-23T14:11:24.161Z [run r-a65e6c] finished: finished — 27 files, $37.83 — agent:wsoule679/claude
- 2026-08-23T14:31:20.454Z requested changes (run r-d7cce5): Code review complete: 10 confirmed findings. REQUIRED before merge:
1. SEVERE — index.ts:553 constructs Orchestrator WITHOUT the backend-selected findingStore, so on sqlite the blocked-finding merge gate reads an empty JSONL store and never fires: a run with an adjudicated 'blocked' finding merges. Inject the same store instance ReviewRunner/FixLoop/apiCtx get.
2. SEVERE — backend selection split-brain: the daemon picks backend from DISPATCH_STORE_BACKEND env only (index.ts:187) while clients infer from .dispatch/dispatch.db existence — an auto-started daemon without the env serves an empty files backend over a database-backed project (task list returns [], task new writes markdown beside the db). Persist the backend per project (e.g. in config or a marker the daemon reads) so both sides derive it from the project, not the environment.
3. task.ts:82 / mcp daemon.ts:124: mere EXISTENCE of dispatch.db hard-locks CLI+MCP task access when no daemon is running, and openDispatchDb creates the db unconditionally beside populated tasks/. Existence must not mean ownership — tie it to the persisted backend choice from fix 2, and stop creating the db on attach paths.
4. tools.ts:650: task_comment on a db-backed project without DISPATCH_RUN_ID falsely refuses with 'dispatchd is not running' while the daemon is up — the proxy block is gated on runId. Proxy whenever the daemon is live; the endpoint accepts runId null.
5. doctor.ts:86: db-backed doctor skips ALL graph checks (dangling refs, cycles, status) on the false premise the schema enforces them (bare DELETE leaves dangling blocked_by, no FK). Run the graph checks against the daemon/store data, not just task files.
6. tools.ts:594: /api/tasks/ready filters archived, the local readyTasks fallback does not — apply the same archived parity fix task list got, or task_next flips answers with daemon presence.
7. tools.ts:237: a live legacy daemon without an agentToken passes the health probe, commits the route to daemon, then every call 401s with no local fallback (CLI throws STALE_DAEMON_MESSAGE first). Treat token-less daemon as not-routable and fall back to files.
8. tools.ts:455: daemon-routed task_get turns a corrupt-but-present task file into 'task not found' — surface the parse error + 'run dispatch doctor' hint (consult problems()/health on 404s for files backend).
9. sqliteTaskStore.ts:245: create()'s collision error names an id that was never attempted (regenerated after the last INSERT) — reuse this branch's own withMintedId helper.
10. sqliteTaskStore.ts:286/407: update()'s patch-split and newDoc()'s defaults+template are verbatim copies of TaskStore's — extract shared pure helpers (applyUpdatePatch/newTaskDoc) so backends cannot diverge.
OPTIONAL (confirmed, if quick): dedupe the CLI/MCP daemon HTTP client stacks; use core's dispatchDbPath instead of three hand-spelled paths; import core's finding/ledger input types in server; collapse the triple /api/health fetch per MCP read; revisit the truncate-and-reload cache rebuild per sqlite mutation. Run server+cli+mcp tests, commit. — human:wsoule679
- 2026-08-23T14:31:35.478Z [run r-d7cce5] finished: finished — 27 files, $0.00 — agent:wsoule679/claude
- 2026-08-23T14:33:06.303Z requested changes (run r-751892): Your previous resume finished with zero turns and made no changes. The 10 required review fixes are in the previous user message in this conversation — apply them now, starting with the two SEVERE ones (inject the backend-selected findingStore into the Orchestrator; persist backend selection per project so daemon and clients agree). Run server+cli+mcp tests, commit. — human:wsoule679
- 2026-08-23T14:56:56.455Z [run r-751892] finished: finished — 32 files, $20.46 — agent:wsoule679/claude
- 2026-08-23T14:58:28.803Z run r-751892 merged into epic/e-99e113 — human:wsoule679
- 2026-09-01T19:10:16.636Z run r-d7cce5 discarded — human:wsoule679
- 2026-09-01T19:10:16.840Z run r-a65e6c discarded — human:wsoule679
- 2026-09-01T19:10:17.047Z run r-e0be91 discarded — human:wsoule679
