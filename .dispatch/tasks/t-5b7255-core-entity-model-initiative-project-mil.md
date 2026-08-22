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
updated: 2026-08-22T16:58:40.673Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
---

## Description

Add initiative, project, and milestone entity types to packages/core (types.ts, ids.ts, describe.ts, store schema). Initiatives hold a rank order; projects hold a rank order within their initiative; milestones (the renamed epic) gain a target date and belong to a project. Tasks gain an urgency field (urgent/high/normal/low, matching Linear's priority scale). No UI, no migration in this task — types, store operations, and tests only.

## Acceptance Criteria

## Activity
- 2026-08-22T16:58:40.673Z Audit amendment (2026-08-22): tasks ALREADY have a `milestone` field (packages/core/src/types.ts:23-26), a free-text "Linear-style grouping above epics" — the name this task introduces, with inverted semantics (new milestones sit BELOW projects). The entity model must account for it: existing task.milestone values encode grouping intent and should seed PROJECT names, and the old free-text field is retired in favor of the structured hierarchy. Coordinate with the epic→milestone migration task (t-4545da), which carries the data-mapping side. — none
