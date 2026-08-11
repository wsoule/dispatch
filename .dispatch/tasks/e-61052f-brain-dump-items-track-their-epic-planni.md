---
id: e-61052f
title: Brain-dump items track their epic-planning lifecycle end-to-end
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-11T02:11:12.336Z
updated: 2026-08-11T02:11:12.336Z
external: null
writes: []
---

## Description

"Group into an epic" / "Make an epic" on the brain dump currently just seeds the Plans composer with combined text — the originating inbox items are never linked to the resulting plan. Once the planner creates tasks, those items don't change state, never leave the inbox, and the created epic/task carries no record of where it came from. This closes that loop: a plan started from a brain-dump group remembers which inbox items fed it, those items show a "planning" state while the plan is in flight, they get marked converted (and drop out of the open inbox) once the plan is confirmed, and the created epic/task's Activity log records which captures it came from.

## Acceptance Criteria

## Activity
