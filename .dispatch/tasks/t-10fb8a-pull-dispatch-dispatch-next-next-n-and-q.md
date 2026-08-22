---
id: t-10fb8a
title: 'Pull dispatch: "dispatch next / next N" and queue-ordered task_next'
status: todo
kind: task
parent: e-ba8bf1
milestone: null
blocked-by:
  - t-95328d
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:38:38.042Z
updated: 2026-08-22T16:38:38.042Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/mcp/src/**
  - packages/cli/src/**
---

## Description

Consumption end of the queue: a daemon action that dispatches the top-weighted ready task (or top N) with one call, exposed in CLI and app; the task_next MCP tool switches to queue ordering so agents asking "what's next" get the same answer the queue shows. Existing policy gates and the irreversibility floor apply unchanged. Continuous auto-dispatch stays out of scope (deferred by design).

## Acceptance Criteria

## Activity
