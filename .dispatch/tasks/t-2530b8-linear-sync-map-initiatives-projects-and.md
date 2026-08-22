---
id: t-2530b8
title: "Linear sync: map initiatives, projects, and milestones bidirectionally"
status: todo
kind: task
parent: e-be4827
milestone: null
blocked-by:
  - t-5b7255
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:38:23.703Z
updated: 2026-08-22T16:38:23.703Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/server/src/**
  - packages/server/test/**
---

## Description

Extend the existing linearMap task sync with initiative↔initiative, project↔project, milestone↔milestone mappings, including rank orders, urgency/priority, and milestone target dates, both directions. Conflict policy matches the existing task sync's. Dispatch remains fully functional with no Linear connection — sync is additive.

## Acceptance Criteria

## Activity
