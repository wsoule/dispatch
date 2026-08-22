---
id: t-5b7255
title: "Core entity model: initiative, project, milestone types and schema"
status: todo
kind: task
parent: e-be4827
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:37:51.474Z
updated: 2026-08-22T16:37:51.474Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
---

## Description

Add initiative, project, and milestone entity types to packages/core (types.ts, ids.ts, describe.ts, store schema). Initiatives hold a rank order; projects hold a rank order within their initiative; milestones (the renamed epic) gain a target date and belong to a project. Tasks gain an urgency field (urgent/high/normal/low, matching Linear's priority scale). No UI, no migration in this task — types, store operations, and tests only.

## Acceptance Criteria

## Activity
