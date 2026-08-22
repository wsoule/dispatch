---
id: t-d78f3a
title: "Preview proxy: /preview/runId through the daemon"
status: todo
kind: task
parent: e-a27691
milestone: null
blocked-by:
  - t-d3cd11
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:41.125Z
updated: 2026-08-22T16:38:49.575Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
---

## Description

HTTP + WS proxy in dispatchd from /preview/<runId>/ to the run's allocated dev-server port, following the shape apps/demo already proves (path-prefixed proxying behind /s/<id>/). Handles WebSocket upgrade for HMR, rewrites/withstands absolute-path asset requests, returns the defined no-preview state when the supervisor reports none, and 404s for unknown or stopped runs.

## Acceptance Criteria

## Activity
