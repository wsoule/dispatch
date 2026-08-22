---
id: e-be4827
title: "Planning hierarchy: initiatives, projects, and epic→milestone"
status: todo
kind: epic
parent: null
milestone: null
blocked-by:
  - e-99e113
labels:
  - planning-engine
  - linear-sync
priority: high
assignee: none
created: 2026-08-22T16:37:20.440Z
updated: 2026-08-22T16:37:42.867Z
external: null
writes: []
---

## Description

Agreed direction (2026-08-22): native Dispatch entities — initiative → project → milestone → task — fully usable without Linear, bidirectionally Linear-syncable. Milestone IS today's epic, renamed and dated: it keeps the branch / stacked-dispatch / merge-queue machinery and gains a target date. Priority model: rank-ordered initiatives, rank-ordered projects within each initiative, and an urgency field on tasks (urgent/high/normal/low, matching Linear's).

The Linear sync extension maps initiative↔initiative, project↔project, milestone↔milestone on top of the existing linearMap task mapping.

Riskiest step is the epic→milestone migration: epic identity is woven into branch names and the merge queue — plan that task with the most care. Blocked by the storage-spine epic (entities live in the daemon-owned store).

## Acceptance Criteria

## Activity
