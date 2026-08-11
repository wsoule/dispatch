---
id: t-29ccd6
title: "Server: let a plan remember which inbox items started it, and settle
  them on confirm"
status: todo
kind: task
parent: e-61052f
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-11T02:11:12.338Z
updated: 2026-08-11T02:11:12.338Z
external: null
writes:
  - packages/server/src/orchestrator/plan.ts
  - packages/server/src/api.ts
  - packages/server/test/plan-epic-api.test.ts
risk: elevated
---

## Description

Add sourceInboxIds tracking to PlanRecord/PlanManager so a plan started from a brain-dump group can, once confirmed, mark those inbox items converted and record the origin in the created doc's Activity log. Mirrors the existing sourceNoteId/linkNoteToTask pattern, but for a list of items feeding one plan instead of one note per plan.

Acceptance criteria:

- PlanRecord gains an optional sourceInboxIds: string[]; PlanManager.startPlan accepts and stores it
- POST /api/plan accepts an optional inboxIds body field, validates each id exists in the inbox store and isn't already linked, and threads the valid subset through to startPlan
- PlanManager.confirm(), when the record carries sourceInboxIds, calls InboxStore.markConverted linking every source id to the new epicId (or the sole task id when there's no epic)
- The same confirm() call appends one Activity bullet to that epic/task's body naming the source brain-dump captures, using the existing appendActivity/store.update pattern already used in confirm() for the undeclared-writes note
- confirmPlan's API handler broadcasts { type: 'inbox.changed' } after a confirm that touched source inbox ids
- A packages/server test starts a plan with inboxIds, confirms it, and asserts the inbox items are done+linked and the created doc's Activity section names the source captures

## Acceptance Criteria

## Activity
