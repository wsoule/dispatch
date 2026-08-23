---
id: t-880ce2
title: "One-time import: existing .dispatch markdown and JSONL into the daemon DB"
status: working
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-c6dbd3
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:56.447Z
updated: 2026-08-23T15:54:18.293Z
external: null
writes:
  - packages/cli/src/**
  - packages/cli/test/**
  - packages/core/src/**
  - packages/core/test/**
  - packages/server/src/**
  - packages/server/test/**
---

## Description

Migration command that imports a project's existing .dispatch/tasks/*.md, findings.jsonl, ledger.jsonl, fix-loops.jsonl, notes, and inbox into the daemon's SQLite store, preserving ids, timestamps, and blockedBy edges. Idempotent and dry-runnable; originals are preserved into the receipt log rather than deleted. Runs automatically on first daemon start against a legacy project, with a clear report of what moved.

## Acceptance Criteria

## Activity
- 2026-08-23T14:58:39.487Z dispatched (claude, branch dispatch/t-880ce2-one-time-import-existing-dispatch-markdo-6dd770) — human:wsoule679
- 2026-08-23T15:09:11.567Z auto-resumed after failed (daemon restart) (run r-ab889f)
- 2026-08-23T15:36:54.146Z Scope blocker: request_scope for packages/server/src/index.ts + packages/server/test/** timed out undecided (denied), and the re-ask failed with "run is not running". Proceeding inside the declared fence (packages/cli/src, packages/core/src, packages/core/test). Consequence: resolveStoreBackend() in packages/server/src/index.ts still refuses DISPATCH_STORE_BACKEND=sqlite whenever .dispatch/tasks exists — its comment names this task as the one that lifts it — so the sqlite path stays unreachable for every legacy project until that one guard is relaxed. I am putting the auto-run seam in core instead (initProjectStores runs the import and returns the report on stores.migration), which is the most a core-only change can do; the daemon still needs that one guard relaxed and one log line to print the report. — none
- 2026-08-23T15:45:22.553Z Fence widened by human decision, not by an in-app scope grant: the daemon's app token was unrecoverable after a forced respawn (its startup output went to /dev/null), so the grant dialog was unavailable and my request_scope call timed out as denied. The approval was instead applied at the task level — declared writes now add packages/server/src/**, packages/server/test/**, packages/cli/test/**. Verified against the canonical repo's task file (updated 2026-08-23T15:36:54.147Z); note that MCP task_get is currently serving a stale copy from this run's worktree that still shows the old three-path fence, so read the canonical file if the two disagree. Reason the extra paths are load-bearing: the legacy readers I import FROM (FindingStore, LedgerStore, run-transcript evidence) exist only in packages/server, and Q2 requires relaxing resolveStoreBackend's blanket refusal at index.ts:215 — the guard whose own comment names this task as its replacement. Q1/Q2 decision recorded to the ledger as l-cb8689 so t-9d89bb and t-b3ad8f inherit it. — none
- 2026-08-23T15:49:41.361Z Dry-run report against this repo's real .dispatch/ (amendment 3), run before any real import path was exercised — no dispatch.db and no storage.json were created, confirmed by ls afterwards.

Dry run — nothing was written. /Users/wyatsoule/.dispatch/worktrees/cc658f598366/r-6dd770

  source                       found  imported  skipped  damaged
  tasks                        155       155        0        0
  epics                         30        30        0        0
  findings                     341       341        0        0
  ledger entries               308       308        0        0

  Left in place (nothing was deleted, moved, or rewritten):
    .dispatch/fix-loops.jsonl — 1, left as files (store not yet DB-backed)
    .dispatch/notes.json — 3, left as files (store not yet DB-backed)
    .dispatch/inbox — 26, left as files (store not yet DB-backed)
    ~/.dispatch/runs/<project>/*.jsonl — not counted, run evidence lives in each run transcript outside the project

  Row parity          before   after  imported
  tasks                  0     155       155
  epics                  0      30        30
  findings               0     341       341
  ledger_entries         0     308       308
  evidence               0       0         0
  mutations              0       0         0

Count parity checked independently against the filesystem, not taken from the report: `ls .dispatch/tasks/*.md | wc -l` = 185 = 155 + 30, `ls .dispatch/tasks/e-*.md | wc -l` = 30, and a python pass over each JSONL counting distinct `id` values gives 341 findings and 308 ledger entries. Every source record was importable — 0 damaged, 0 unparsable lines, no duplicate-id collisions in either sidecar. The dry run is the real import inside a transaction that is rolled back rather than committed, so these are the numbers a real import produces, not a prediction of them. — none
- 2026-08-23T15:54:18.293Z HALTED — two agents are implementing this task in the same worktree (/Users/wyatsoule/.dispatch/worktrees/cc658f598366/r-6dd770) at the same time, and the tree no longer compiles.

Run r-6dd770 (me) built: core/src/migrate.ts exporting importLegacyProject/hasLegacyState/totalImported/LEGACY_SOURCES + formatMigrationReport (whole import in one BEGIN/COMMIT; dry-run is the same transaction ROLLBACKed, so rehearsal numbers ARE the real import's numbers; report carries rowsBefore/rowsAfter per table for count parity), core/src/storage.ts (moved the storage.json marker into core so the CLI can write it, server/storage.ts now re-exports it — the comment there already said core was its right home), `dispatch migrate [--dry-run]` in cli/src/commands/migrate.ts, boot-time auto-import + relaxed resolveStoreBackend in server/src/index.ts, and 38 tests (core 25, cli 5, server 8) that were all green.

A second agent then rewrote core/src/migrate.ts wholesale to a different API — migrateProject(options: MigrateOptions), RecordCounts, DeferredSource, MigrationSkip, dry-run branched inside the loops. It also added core/src/jsonlRecords.ts, which extracts the JSONL id+createdAt compaction rule out of the daemon's FindingStore/LedgerStore so the import and the daemon cannot drift, and rewired server/src/findings.ts and ledger.ts onto it. That refactor is the better call and should survive whichever implementation wins — I had duplicated that rule inside my own migrate.ts.

Current state: core/src/index.ts, cli/src/commands/migrate.ts, server/src/index.ts and all three test files still reference the deleted API, so `bun run tsc` in packages/core fails with 12+ TS2305 errors. I stopped rather than race — ask_user and request_scope both now fail with "run is not running", so I could not ask which implementation to keep.

My work is snapshotted, uncommitted, in .agents/ignore/t-880ce2-r6dd770/ (full migrate.ts, core/storage.ts, the CLI command, all three test files, and diffs of the server/core/cli edits) so it survives whatever happens to the source tree.

One result is independent of which implementation wins — the dry-run artifact in the comment above: 155 tasks + 30 epics + 341 findings + 308 ledger entries importable from this repo's real .dispatch/, 0 damaged, verified against the filesystem rather than taken from the report. — none
