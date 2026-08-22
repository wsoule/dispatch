---
id: t-57000b
title: "Delivery beyond the app: OS notifications and webhook"
status: todo
kind: task
parent: e-6cfcc7
milestone: null
blocked-by:
  - t-48a2e5
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:59:04.585Z
updated: 2026-08-22T16:59:04.585Z
external: null
writes:
  - apps/desktop/src/**
  - packages/server/src/**
  - packages/server/test/**
---

## Description

When the app is backgrounded or closed: OS-level notifications via Tauri for feed items that block progress (input requests, gates), and a configurable webhook in .dispatch config posting feed items as JSON (the seam for Slack or anything else — no per-service integrations in v1). Per-kind notification toggles so verify-failure noise is tunable separately from input requests.

## Acceptance Criteria

## Activity
