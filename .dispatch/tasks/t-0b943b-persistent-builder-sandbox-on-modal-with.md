---
id: t-0b943b
title: Persistent builder sandbox on Modal with live dev server
status: todo
kind: task
parent: e-2a8f00
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:45:26.026Z
updated: 2026-08-22T16:45:26.026Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - apps/demo/**
---

## Description

Builder sessions hold a persistent Modal sandbox with a live dev server (Lovable's model): agent runs execute inside it, the preview proxies out the same path as local (/preview/<runId>/), hibernate on idle per the Modal design task, metered in sandbox-minutes. Session caps, TTL sweeps, and rate limiting generalize from apps/demo's existing per-visitor dispatchd host.

## Acceptance Criteria

## Activity
