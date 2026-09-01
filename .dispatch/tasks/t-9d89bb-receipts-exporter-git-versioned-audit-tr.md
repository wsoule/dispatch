---
id: t-9d89bb
title: "Receipts exporter: git-versioned audit trail outside the project repo"
status: working
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-c6dbd3
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:52.987Z
updated: 2026-09-01T14:46:17.787Z
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
