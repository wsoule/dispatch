---
id: t-0ee249
title: dispatchd serves the app bundle to browsers in team-serve mode
status: todo
kind: task
parent: e-5f3530
milestone: null
blocked-by:
  - t-4c017f
labels: []
priority: high
assignee: none
created: 2026-08-22T16:58:53.108Z
updated: 2026-08-22T16:58:53.108Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - apps/desktop/src/**
---

## Description

In team-serve mode the daemon serves the desktop web bundle at its root, so a teammate needs only a URL and their token — no install. Generalizes what apps/demo already does (serving the bundle with token injection) into dispatchd proper, using the __DISPATCH_HOST__ seam where it helps. The isTauri() fallbacks carry the browser experience; anything still Tauri-only (registry, native dialogs, editor/Finder) hides or falls back per the documented paths.

## Acceptance Criteria

## Activity
