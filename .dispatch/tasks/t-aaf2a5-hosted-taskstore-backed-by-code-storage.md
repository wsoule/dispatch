---
id: t-aaf2a5
title: Hosted TaskStore backed by code.storage behind the store seam
status: todo
kind: task
parent: e-2a8f00
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:45:18.994Z
updated: 2026-08-22T16:45:18.994Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/server/src/**
  - packages/server/test/**
---

## Description

The hosted counterpart of the SQLite TaskStore: an implementation of the same store interface backed by code.storage — tasks/findings/ledger as versioned files, worktrees as ephemeral branches, GitHub sync keeping the user's repo canonical. This is also the delivery vehicle for e-5434b7's shared team runtime (its mechanism was reconciled onto this seam by the 2026-08-22 spec) — coordinate the two so one implementation serves both. Backend selection follows where the project lives, never a user toggle.

## Acceptance Criteria

## Activity
