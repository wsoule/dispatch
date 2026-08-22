---
id: e-ba8bf1
title: "Planning queue: weighted scoring, transparent ranking, human pull"
status: todo
kind: epic
parent: null
milestone: null
blocked-by:
  - e-be4827
labels:
  - planning-engine
  - queue
priority: high
assignee: none
created: 2026-08-22T16:37:28.275Z
updated: 2026-08-22T16:37:45.870Z
external: null
writes: []
---

## Description

Agreed direction (2026-08-22): replace planning meetings with a scoring service in the daemon that computes each ready task's weight from named factors — task urgency, project rank within initiative, initiative rank, milestone due-date proximity, plus dependency-unblocking value and task age — each with a user-tunable weight in config. The queue view shows the factor breakdown per task so the ranking is explainable, never a black box.

v1 consumption is PULL: a sorted backlog with explicit "dispatch next" / "dispatch next N" actions, and the task_next MCP tool reads this ordering. Continuous auto-dispatch is deliberately deferred — the ordering logic is identical, so it layers on later behind the policy system (autonomy with receipts, irreversibility floor per lovable-direction.md).

Blocked by the planning-hierarchy epic (factors reference initiative/project rank and milestone dates).

## Acceptance Criteria

## Activity
