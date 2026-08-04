---
id: t-9e0f00
title: MergeQueue persists into the real ~/.dispatch when tests omit
  DISPATCH_HOME (12.7k leaked dirs)
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-03T23:29:07.233Z
updated: 2026-08-03T23:29:07.233Z
external: null
writes:
  - packages/server/test/merge-queue.test.ts
  - packages/server/test/blocked-finding-gate.test.ts
  - packages/server/src/orchestrator/paths.ts
---

## Description

`~/.dispatch/runs/` on this machine holds **12,763 directories but only 25 run transcripts**. ~12.7k of them contain nothing but a `merge-queue.json`.

\## Root cause

`mergeQueuePath(rootDir)` (packages/server/src/orchestrator/paths.ts:60) resolves to `runsDir(rootDir)/merge-queue.json`, and `runsDir` keys on `rootHash(rootDir)` under `dispatchHome()` — which falls back to the real `homedir()` whenever `DISPATCH_HOME` is unset.

Tests construct a `MergeQueue` over a fresh temp `rootDir` (packages/server/test/merge-queue.test.ts, packages/server/test/blocked-finding-gate.test.ts). Some test files set `DISPATCH_HOME` to a temp dir — config-api.test.ts even carries the comment "DISPATCH_HOME — left unset it lands in the real home, one dir per test" — but the merge-queue tests do not. Every `persist()` from those tests therefore writes a new hash-keyed directory into the developer's actual home, and nothing ever removes it. One directory per temp rootDir per test run, accumulating forever.

\## Suggested fix

- Set `DISPATCH_HOME` to a temp dir in the merge-queue test setup (and audit every other test that constructs a `MergeQueue`, `Transcript`, or anything else routing through `paths.ts`).
- Consider a shared test helper that redirects `DISPATCH_HOME` so this cannot be forgotten again, rather than repeating the save/restore dance in each file.
- Consider making `paths.ts` refuse to write under the real home when `NODE_ENV`/`BUN_ENV` indicates a test run, so a missed redirect fails loudly instead of leaking silently.
- Clean up the existing ~12.7k stray directories (they are safe to delete — only orphan `merge-queue.json` files with no matching transcripts).

\## Acceptance Criteria

- No test run leaves new directories under the real `~/.dispatch/runs`.
- Merge-queue tests still pass with `DISPATCH_HOME` redirected.
- A guard or shared helper makes the redirect hard to omit in future tests.

Found while analysing run transcripts for task t-b4dfdd.

## Acceptance Criteria

## Activity
