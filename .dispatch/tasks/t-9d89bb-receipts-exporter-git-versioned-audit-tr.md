---
id: t-9d89bb
title: "Receipts exporter: git-versioned audit trail outside the project repo"
status: todo
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-c6dbd3
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:52.987Z
updated: 2026-08-22T16:38:52.987Z
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
