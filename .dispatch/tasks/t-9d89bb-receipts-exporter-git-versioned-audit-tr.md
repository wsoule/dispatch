---
id: t-9d89bb
title: "Receipts exporter: git-versioned audit trail outside the project repo"
status: in-progress
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-c6dbd3
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:52.987Z
updated: 2026-09-01T15:42:38.022Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/core/src/**
  - packages/core/test/**
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
