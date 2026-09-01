---
id: t-9d89bb
title: "Receipts exporter: git-versioned audit trail outside the project repo"
status: done
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-c6dbd3
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:52.987Z
updated: 2026-09-01T19:11:10.512Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/core/src/**
  - packages/core/test/**
archived-at: 2026-09-01T19:11:10.512Z
---

## Description

Daemon exports the audit trail — ledger entries, findings, decisions, evidence, task history snapshots — to a git-versioned receipt log outside the project repo (default ~/.dispatch/projects/<id>/receipts, configurable). Commits are batched/debounced, human-readable, and the format round-trips: the receipt log alone is enough to reconstruct task history if the DB is lost. This preserves the "autonomy with receipts" positioning after git stops being the sync layer.

## Acceptance Criteria

## Activity
- 2026-08-24T23:55:49.549Z dispatched (claude, branch dispatch/t-9d89bb-receipts-exporter-git-versioned-audit-tr-630128) — human:wsoule679
- 2026-08-25T00:33:05.201Z Design settled. Receipt log is laid out as a file-backed dispatch project (.dispatch/tasks/*.md + findings/ledger/evidence JSONL under ~/.dispatch/projects/<rootHash>/receipts), so restore is the existing importLegacyProject() rather than a bespoke deserializer. Asked the human to confirm four shaping calls; no reply in the window, proceeding on my recommendation and recorded it to the ledger. Building now: core materialize/restore + server git exporter + debounced scheduler. — none
- 2026-09-01T14:46:17.787Z [run r-630128] flagged interrupted-dirty: 7 uncommitted path(s) found — none
- 2026-09-01T14:46:35.568Z requested changes (run r-7bb074): You were interrupted by a daemon restart; your worktree is intact. Continue the receipts-exporter task from where you left off, re-verifying anything mid-flight when you stopped. — human:wsoule679
- 2026-09-01T15:42:38.021Z BLOCKER (worked around, needs a 2-line follow-up). `DispatchConfig.receipts` is typed OPTIONAL, and it should be required like every other config block (repoDigest, carto, fixLoop).

Why: apps/desktop/src/components/settings/fixtures.test-helper.ts hand-constructs a complete DispatchConfig literal, so a required field breaks it with TS2741 and `bun run build` exits 2 on @dispatch/desktop. That file is outside this run's declared writes (packages/core/**, packages/server/**). I ran the full workspace build first to confirm it was the ONLY out-of-scope breakage, then requested scope for exactly that one file — nobody was available to decide inside the window, so it came back denied.

Leaving the field required would have left the branch unbuildable and therefore unreviewable, so I made it optional, documented at the declaration that loadConfig always populates it, and put the single fallback behind receiptsEnabled(). Nothing is functionally wrong; the type is just weaker than it should be.

The follow-up, for whoever has the scope: add DEFAULT_RECEIPTS to that fixture's existing `@dispatch/core/browser` import and add `receipts: DEFAULT_RECEIPTS,` beside `repoDigest: DEFAULT_REPO_DIGEST,`, then drop the `?` in configTypes.ts and the `?? DEFAULT_RECEIPTS` in receipts/exporter.ts. DEFAULT_RECEIPTS is already exported from the browser entrypoint (browser.ts re-exports configTypes wholesale), so no other plumbing is needed.

Note for reviewers on test noise: two server tests fail in an aggregate `bun test` and neither is this change. test/orchestrator/claude-executor.test.ts asserts the dispatch MCP command is 'bun', but a Dispatch agent session exports DISPATCH_MCP_BIN, so it resolves to the installed app binary instead — green under `env -u DISPATCH_MCP_BIN`. Any agent running this suite from inside Dispatch will hit it. test/prs-api.test.ts times out at ~200s under aggregate load and is green in isolation, matching the known flake. — none
- 2026-09-01T15:44:54.135Z [run r-7bb074] finished: finished — 15 files, $14.03 — agent:wsoule679/claude
- 2026-09-01T15:57:35.615Z requested changes (run r-9a9470): Code review: 10 confirmed findings. REQUIRED before merge, ranked:
1. SEVERE — exporter.ts:178: ensureRepo adopts ANY directory containing .git, so receipts.dir '.' (or any existing repo) makes the daemon git add -A + commit --no-verify inside the USER'S OWN REPO every debounce, prune their task files, and overwrite their README. Refuse to adopt a repo it did not create: require a marker file written at init (or empty-dir/init-only), and reject a dir inside the project repo like PrWorktreeManager does.
2. SEVERE — index.ts:608: wired only to task.changed, but findings/ledger/evidence emit finding.changed/ledger.changed (or nothing) — a review's 20 findings never reach the trail until an unrelated task edit. Subscribe to all record-mutating events (finding.changed, ledger.changed, and an evidence hook or periodic sweep) — the README promises 'committed on every change'.
3. receipts.ts:226: rows in board.errors never join unexportedTaskIds, so pruneTaskFiles DELETES the last good receipt of a damaged-but-present task and commits the deletion — add them to the keep-list like the toMarkdown-throw path already does.
4. receipts.ts:265/276: findings/ledger JSONL are rewritten from parseable rows only, committing damaged records as deletions — give them the same keep-list/preserve treatment as tasks (retain the prior line for ids listSafe reported as damaged).
5. exporter.ts:111: git add/status/commit sit OUTSIDE the try/catch and the debounce timer has no guard — Bun.spawnSync THROWS on missing executable (verified), crashing the daemon from a setTimeout. Guard the whole export like BoardSyncScheduler.runGuarded; boot's exportNow must actually never throw.
6. receipts.ts:469: restoreReceipts' unguarded readFileSync on evidence entries aborts the rebuild mid-way with no report — per-file try/catch, cost the bad file, continue.
7. receipts.ts:461: evidence restore is non-transactional with a per-run idempotency guard, so an interrupted restore permanently truncates a run's evidence and re-runs count it 'skipped'. Wrap per-run in a transaction (or delete-then-insert per run) so re-runs complete partial runs.
8. exporter.ts:185: git config user.name/email only on the init path with exit status discarded — re-assert identity on every pass (or check + repair), and check the config calls' status.
9. exporter.ts:140: pass -c commit.gpgsign=false (and --no-gpg-sign) so a machine-global signing policy can't stall the daemon 30s per export.
10. api.ts:194 cleanups: expose receipts status somewhere queryable (fold into GET /api/sync or doctor) instead of dead lastResult()/lastExportedAt(); delete the unreachable inFlight/pendingRerun machinery or make it real; drop the per-event loadConfig pre-check and let runOnce's gate decide.
Run server+core tests, commit. — human:wsoule679
- 2026-09-01T15:57:43.443Z [run r-9a9470] finished: finished — 15 files, $0.00 — agent:wsoule679/claude
- 2026-09-01T15:58:17.668Z requested changes (run r-31de8c): Your previous resume finished with zero turns and made no changes. The 10 required review fixes are in the previous user message in this conversation — apply them now, starting with the two SEVERE ones (refuse to adopt a git repo the exporter did not create; subscribe the exporter to finding.changed/ledger.changed and an evidence path, not just task.changed). Run server+core tests, commit. — human:wsoule679
- 2026-09-01T16:10:20.210Z [run r-31de8c] finished: finished — 15 files, $8.56 — agent:wsoule679/claude
- 2026-09-01T16:11:43.654Z run r-31de8c merged into epic/e-99e113 — human:wsoule679
- 2026-09-01T19:10:15.362Z run r-9a9470 discarded — human:wsoule679
- 2026-09-01T19:10:15.567Z run r-7bb074 discarded — human:wsoule679
- 2026-09-01T19:10:15.789Z run r-630128 discarded — human:wsoule679
