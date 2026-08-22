---
id: t-1aaef1
title: Inject layered memory into dispatched agent context
status: todo
kind: task
parent: e-4ba988
milestone: null
blocked-by:
  - t-d53d40
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:38:27.283Z
updated: 2026-08-22T16:38:27.283Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
---

## Description

When dispatchd launches a run, compose the task's memory stack — milestone memory layered over project memory over initiative memory, clearly labeled by level — into the agent's context alongside the task body. Empty levels are omitted. Cap total injected size with a deterministic truncation order (oldest tactical entries first) so a noisy milestone can't crowd out the task itself.

## Acceptance Criteria

## Activity
