---
id: t-2c6c71
title: "Policy engine: gates consult per-project policy, record instead of block"
status: todo
kind: task
parent: e-ad1978
milestone: null
blocked-by:
  - t-df1163
labels: []
priority: high
assignee: none
created: 2026-08-22T16:44:20.611Z
updated: 2026-08-22T16:44:44.726Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/server/src/**
  - packages/server/test/**
---

## Description

Per-project policy config (the settled ladder rung plus per-gate overrides) in core types and daemon state. Every existing gate call site consults policy: below its rung it blocks as today; at or above, it auto-decides and RECORDS — the decision lands in the ledger with the policy rung that authorized it, findings and evidence unchanged. Auto-accept scope requests and auto-retry verify are the first two demotions; auto-merge on green rides the merge queue's existing green check.

## Acceptance Criteria

## Activity
