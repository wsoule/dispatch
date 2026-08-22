---
id: e-99e113
title: "Storage spine: daemon-owned DB with git receipts"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - storage-spine
  - planning-engine
priority: high
assignee: none
created: 2026-08-22T16:37:16.279Z
updated: 2026-08-22T17:33:44.256Z
external: null
writes: []
---

## Description

Agreed direction (2026-08-22 discussion, follows docs/design/lovable-direction.md): dispatchd becomes the single owner of orchestration state, backed by SQLite locally, exposed through the existing daemon HTTP/WS channel and MCP tools. Implemented as a second TaskStore behind the existing seam (packages/core/src/store.ts) — the same seam the future hosted/code.storage backend will use.

Git's role changes from sync layer to receipt log: the daemon exports the audit trail (ledger, findings, decisions, task history snapshots) to a git-versioned location OUTSIDE the project repo (e.g. ~/.dispatch/projects/<id>/receipts). The project repo's .dispatch/ shrinks to genuinely-committable config (config.yml, team.yml) — no more findings.jsonl/ledger.jsonl churn in project diffs. One-time migration imports existing .dispatch/tasks/*.md into the DB, preserving originals in the receipt log.

This epic is the foundation for the planning hierarchy, layered memory, and planning queue epics — real-time reads/writes through the daemon are a prerequisite for a scheduler recomputing weights and for shared agent memory.

## Acceptance Criteria

## Activity
- 2026-08-22T17:33:44.256Z [epic] integration branch epic/e-99e113 created from main — none
