---
id: t-635095
title: "Queue view: ranked backlog with per-task factor breakdown"
status: todo
kind: task
parent: e-ba8bf1
milestone: null
blocked-by:
  - t-06e1b0
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:33.542Z
updated: 2026-08-22T16:58:29.432Z
external: null
writes:
  - apps/desktop/src/**
---

## Description

New queue surface in the app: ready tasks in weight order, each row expandable to the per-factor score breakdown (urgency, project rank, initiative rank, due-date proximity, unblocking value, age) so every ranking is explainable. Weight tuning lives in settings with live re-ranking. Reuses the shared row primitives from the redesign-foundations epic.

## Acceptance Criteria

## Activity
