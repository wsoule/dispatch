---
id: t-d3cd11
title: Per-run dev-server supervisor in dispatchd
status: todo
kind: task
parent: e-a27691
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:02.798Z
updated: 2026-08-22T16:38:02.798Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/core/src/configTypes.ts
---

## Description

Supervisor in dispatchd that starts a dev server in a run's worktree when the run reaches a reviewable state: preview command from .dispatch/config with fallback to detecting a dev script in the worktree's package.json; install step for fresh worktrees; port allocation; health check with startup timeout; stopped when the run closes; all previews swept on daemon shutdown. Non-web repos (no command found) report a defined no-preview state rather than an error. Child processes need real supervision: kill process trees, cap log output, restart-on-crash with a retry limit.

## Acceptance Criteria

## Activity
