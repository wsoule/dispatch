---
id: t-f215d8
title: Notify for enrich, note, and inbox-enrich planner questions
status: backlog
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-04T12:48:21.336Z
updated: 2026-08-04T12:48:21.336Z
external: null
writes:
  - apps/desktop/src/hooks/useTransitionNotifications.ts
  - apps/desktop/src/hooks/useDispatchProject.ts
  - apps/desktop/src/lib/notificationEdges.ts
  - apps/desktop/src/App.tsx
---

## Description

v0.15.0 added notifications when a planner is waiting on an answer, but only for the Plans-view plan record and for task drafts. Three other planner slots ask questions and notify for none of them.

`useTransitionNotifications` (apps/desktop/src/hooks/useTransitionNotifications.ts) receives only `planRecord`. `useDispatchProject` also holds `enrichPlanRecord`, `notePlanRecord`, and `inboxEnrichPlanRecord`, and none are passed in. So a question from the "Add detail" enrich pass is only discoverable by having that task's detail dialog already open — which is exactly the "nothing tells me a planner is waiting" complaint v0.15.0 set out to fix.

The detector itself needs no change: `diffQuestionNotifications` already takes a single `planRecord` and keys askers as `plan:<id>`, so it generalises to a list of plan records without touching its logic.

Acceptance criteria:
- An enrich plan that asks a question fires a notification and writes an inbox row
- The same holds for the note-enrich and inbox-enrich plan slots
- Clicking the inbox row lands somewhere that can actually answer the question (the enrich form lives in TaskDetailDialog, so the target likely needs to open that task's peek/dialog rather than the Plans view)
- The existing plan and draft notification behaviour is unchanged, and the detector's tests still pass

Context: `.superpowers` ledger for this work is gone with the merged branch; the finding came from the whole-branch review of the planner-questions work (minor #6).

## Acceptance Criteria

## Activity
