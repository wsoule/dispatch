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
updated: 2026-08-22T16:38:20.588Z
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
