---
id: t-c6dbd3
title: "dispatchd becomes single writer: all task I/O through the daemon store"
status: in-progress
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-7cc78a
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:17.943Z
updated: 2026-08-23T01:15:42.851Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/mcp/src/**
  - packages/cli/src/**
---

## Description

Route every task/finding/ledger read and write through dispatchd's SQLite-backed store: daemon HTTP/WS endpoints, MCP tools (task_save, task_list, task_get, task_next, record_* tools), and CLI commands all talk to the daemon instead of touching files directly. The daemon is the only process holding the DB. Existing two-tier token auth (agentToken/appToken) is unchanged. UI real-time updates ride the existing WS channel — no polling.

## Acceptance Criteria

## Activity
- 2026-08-23T01:15:42.851Z dispatched (claude, branch dispatch/t-c6dbd3-dispatchd-becomes-single-writer-all-task-e0be91) — human:wsoule679
