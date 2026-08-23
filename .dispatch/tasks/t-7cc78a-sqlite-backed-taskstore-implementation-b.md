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
updated: 2026-08-23T00:21:13.060Z
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
- 2026-08-22T18:24:34.888Z Run r-664ec2: adopted the interrupted r-d236d7 worktree's implementation after reviewing it file-by-file against the task (SqliteTaskStore behind a new TaskStorePort, SqliteFinding/Ledger/Evidence stores, openProjectStores as the construction-time backend switch, browserPurity test walking the value-import graph from browser.ts). Verified rather than trusted: re-ran the 61 new tests, mutation-tested all 9 guards in the diff myself (1–3 tests fail per reverted guard, none vacuous), and added one guard the prior run lacked — openDispatchDb now refuses a database whose user_version is newer than DISPATCH_DB_VERSION instead of stamping it back down (mutation-tested: 1 failure). — none
- 2026-08-22T18:28:25.399Z Two notes for whoever adopts this in the daemon. (1) dispatchDbPath() defaults to .dispatch/dispatch.db, i.e. inside the project repo — inert today because nothing constructs with backend:'sqlite', but the epic's plan is ~/.dispatch/projects/&lt;id&gt;/, and until that move a project that flips the switch will see dispatch.db (plus -wal/-shm) in git status. Every caller passes an explicit dbPath, so it is a one-line change at the call site. (2) The schema covers what the task enumerated — tasks/epics, findings, ledger entries (decisions are kind:'decision'), and command/mutation evidence. fix-loops.jsonl and per-run transcripts are deliberately out: runs are still orchestrator-owned state, so run_id is an opaque key here rather than a foreign key. — none
- 2026-08-22T18:30:24.645Z [run r-2ca940] finished: finished — 12 files, $6.37 — agent:wsoule679/claude
- 2026-08-23T00:21:13.060Z requested changes (run r-3b5a48): Code review found contract regressions vs the file backend. REQUIRED before merge:
1. Restore id validation: the ^[te]-[0-9a-f]{6}$ gate has no sqlite counterpart — put()/toMarkdown() can yield path-traversal filenames from unvalidated ids/slugs (sqliteTaskStore.ts:235, :351).
2. isInitialized() is hardwired true and open CREATES .dispatch/dispatch.db + WAL/SHM even for read-only attach (storeBackend.ts:66, sqliteTaskStore.ts:191) — this kills the CLI's 'not a dispatch project' guard and litters repos from pure reads. Preserve the files backend's create-nothing/attach contract; init creates, open does not.
3. Collisions must never silently overwrite: create() and FindingStore.add() write through ON CONFLICT DO UPDATE, so a cross-process id collision (daemon + CLI share the WAL db) silently replaces existing rows (sqliteTaskStore.ts:231, sqliteRecords.ts:198). Use plain INSERT (or DO NOTHING + retry loop on .changes===0); reserve upserts for update(). FindingStore.update() should be a targeted UPDATE of verdict/ruling/updated_at, not the 16-column upsert.
4. Quarantine, don't coerce: corrupted blocked_by/writes parse to [] (un-blocks tasks / erases write scope, sqliteDb.ts:202), corrupted applies_to broadcasts a targeted ledger entry to every task (sqliteRecords.ts:256), and metaFromRow blind-casts enums with listSafe hardcoding errors:[] (sqliteTaskStore.ts:87). Surface all of these as loud errors like parseTaskFile/listSafe do on the file backend.
5. nextSeq is a racy MAX+1 read-then-insert (sqliteRecords.ts:457) — fold into the INSERT (COALESCE(MAX(seq)+1,0) subselect) or a transaction.
OPTIONAL (confirmed, do if quick): shared pure builders to stop backend drift — buildFinding/buildLedgerEntry/buildNewTaskDoc/applyUpdatePatch in core, server imports the core input types instead of its verbatim copies (findings.ts:39, ledger.ts:25); one mintUniqueId helper (4 copies now); cache prepared statements per SQL; private rowOf(id) so update/amend stop double-SELECTing (slugOf dies); clauses[] form for ledger list; keep put()/toMarkdown() private until the migration commit that uses them. Run package tests when done, commit. — human:wsoule679
