---
id: t-880ce2
title: "One-time import: existing .dispatch markdown and JSONL into the daemon DB"
status: todo
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-c6dbd3
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:56.447Z
updated: 2026-08-22T16:38:56.447Z
external: null
writes:
  - packages/cli/src/**
  - packages/core/src/**
  - packages/core/test/**
---

## Description

Migration command that imports a project's existing .dispatch/tasks/*.md, findings.jsonl, ledger.jsonl, fix-loops.jsonl, notes, and inbox into the daemon's SQLite store, preserving ids, timestamps, and blockedBy edges. Idempotent and dry-runnable; originals are preserved into the receipt log rather than deleted. Runs automatically on first daemon start against a legacy project, with a clear report of what moved.

## Acceptance Criteria

## Activity
