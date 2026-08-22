---
id: t-06e1b0
title: "v0 scoring: urgency, unblocking value, and age against the current store"
status: in-progress
kind: task
parent: e-ba8bf1
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:58:15.804Z
updated: 2026-08-22T17:33:47.232Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/server/src/**
  - packages/server/test/**
---

## Description

From the 2026-08-22 audit: the full weight function waits on the storage spine and hierarchy (~9 tasks of infrastructure before any planning payoff), but the scoring function is pure and backend-agnostic by design, and three of its factors already exist in today's store — task urgency/priority, unblocking value (blockedBy graph), and age. Ship the scoring core now over just those factors, with tunable weights and the per-factor breakdown, ordering ready (unblocked, todo) tasks via the existing daemon. The full scoring-service task upgrades this in place by adding project rank, initiative rank, and due-date proximity when the hierarchy lands — same function, more factors. Starts weight tuning on real work months earlier.

## Acceptance Criteria

## Activity
- 2026-08-22T17:33:47.232Z dispatched (claude, branch dispatch/t-06e1b0-v0-scoring-urgency-unblocking-value-and-167969) — human:wsoule679
