---
id: t-b3ad8f
title: Shrink in-repo .dispatch/ to committable config only
status: todo
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-9d89bb
  - t-880ce2
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:39:15.687Z
updated: 2026-08-22T16:39:15.687Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/cli/src/**
  - docs/**
  - README.md
---

## Description

Once the DB is the source of truth and receipts live outside the repo, the project's .dispatch/ carries only genuinely-committable config (config.yml, team.yml). Stop writing tasks/, findings.jsonl, ledger.jsonl, fix-loops.jsonl, notes.json, and inbox/ into the repo; the import task already moved their contents. Update init/docs/README so the "tasks are markdown files in your repo" story becomes "your repo holds config; state lives in the daemon with git receipts."

## Acceptance Criteria

## Activity
