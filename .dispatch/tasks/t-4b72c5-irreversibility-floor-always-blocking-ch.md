---
id: t-4b72c5
title: "Irreversibility floor: always-blocking checks regardless of policy"
status: todo
kind: task
parent: e-ad1978
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:44:23.378Z
updated: 2026-08-22T16:44:23.378Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
---

## Description

The floor the ladder can never lower: force-push, deletes outside declared writes, and spend above the budget cap always block for a human, at every policy rung, in both lenses. Implemented as a distinct check layer the policy engine cannot demote, with tests asserting each floor item still blocks at the maximum autonomy rung. Membership comes from the design task's decision doc.

## Acceptance Criteria

## Activity
