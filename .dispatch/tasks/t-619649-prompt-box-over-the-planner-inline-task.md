---
id: t-619649
title: "Prompt box over the planner: inline task graph, dispatch on confirm"
status: todo
kind: task
parent: e-16ef06
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:44:57.337Z
updated: 2026-08-22T16:44:57.337Z
external: null
writes:
  - apps/desktop/src/**
  - packages/server/src/**
  - packages/server/test/**
  - packages/client/src/**
---

## Description

Wire the builder shell's prompt area to the existing planner (packages/server/src/orchestrator/planner.ts): free-text prompt in, proposed task graph rendered inline — milestone + tasks with titles, writes, and order — editable before anything is created. Confirm files the real tasks through the normal store and dispatches; cancel discards. Nothing is created or run before confirm, and everything created is ordinary task state visible from the engineer lens.

## Acceptance Criteria

## Activity
