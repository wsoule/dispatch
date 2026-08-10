---
id: t-9cf509
title: Handoff affordance in the desktop UI
status: todo
kind: task
parent: e-ff5a2c
milestone: null
blocked-by:
  - t-11182a
labels:
  - team
  - ui
priority: medium
assignee: none
created: 2026-08-10T22:48:17.715Z
updated: 2026-08-10T22:48:17.715Z
external: null
writes: []
---

## Description

Surface the handoff bundle flow in the app: a "Hand off" action on run detail and task peek for eligible runs (live-stopped, failed, interrupted-dirty, finished-unmerged), showing what the bundle will contain (branch, survey summary, note field) before creating it; and a "Pick up" entry point that lists open handoffs for the project and dispatches the fresh-strategy pickup run.

Handoffs waiting for pickup should be visible where attention already flows — the Control room feed and/or a badge, consistent with how approval.requested and question.asked surface today. Existing ledger handoff entries (from the record_handoff wiring task) render on the task detail; this task makes them actionable rather than just visible.

## Acceptance Criteria

## Activity
