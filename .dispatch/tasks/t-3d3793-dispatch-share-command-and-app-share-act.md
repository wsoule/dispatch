---
id: t-3d3793
title: dispatch share command and app share action
status: todo
kind: task
parent: e-dff6d3
milestone: null
blocked-by:
  - t-ec7b38
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:44:53.688Z
updated: 2026-08-22T16:44:53.688Z
external: null
writes:
  - packages/cli/src/**
  - apps/desktop/src/**
---

## Description

"dispatch share <runId>" in the CLI writes the static run page to a chosen path and prints it; the app gets a Share action on run detail/review surfaces producing the same artifact (save dialog in Tauri, download in browser). No hosting, no upload — the artifact is the feature.

## Acceptance Criteria

## Activity
