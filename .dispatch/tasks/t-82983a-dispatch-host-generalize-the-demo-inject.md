---
id: t-82983a
title: "__DISPATCH_HOST__: generalize the demo injection seam, complete isTauri
  fallbacks"
status: todo
kind: task
parent: e-2a8f00
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:45:22.368Z
updated: 2026-08-22T16:45:22.368Z
external: null
writes:
  - apps/desktop/src/**
  - apps/demo/**
  - packages/demo/src/**
---

## Description

Generalize apps/demo's __DISPATCH_DEMO__ token-injection seam to __DISPATCH_HOST__ so the same desktop bundle serves demo and hosted product. Complete the documented isTauri() browser fallbacks in lib/tauri.ts: registry → server-side project list, native dialogs → in-app repo picker, editor/Finder actions → hidden. Only 6 of ~443 desktop source files import @tauri-apps/* and nothing on the task/run/review path does — this task closes the remainder.

## Acceptance Criteria

## Activity
