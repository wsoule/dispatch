---
id: t-4545da
title: "Epic→milestone migration: identity, branches, and merge queue survive"
status: todo
kind: task
parent: e-be4827
milestone: null
blocked-by:
  - t-5b7255
labels: []
priority: high
assignee: none
created: 2026-08-22T16:38:20.588Z
updated: 2026-08-22T16:58:43.445Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/server/src/**
  - packages/server/test/**
---

## Description

Migrate existing epics to milestones. This is the riskiest task in the hierarchy epic: epic identity is woven into branch names, stacked dispatch, and the merge queue. Existing e-* ids must remain valid (as milestone ids or via an alias layer) so in-flight epic branches, run records, and ledger references never dangle. Unparented milestones land in a default project. Write the migration as a reversible, dry-runnable step with tests over a fixture project containing in-flight epic branches.

## Acceptance Criteria

## Activity
- 2026-08-22T16:58:43.445Z Audit amendment (2026-08-22): migration input includes the legacy free-text task.milestone field (packages/core/src/types.ts:23-26, "grouping above epics" — opposite of the new milestone-below-project). Mapping: distinct legacy milestone values become projects; tasks keep their epic (→ new milestone), and that milestone's project is inferred from the tasks' legacy values where consistent, defaulting to the default project where absent or conflicting. The dry-run report must list every legacy value and where it landed. Field is removed from the schema at the end of this migration. — none
