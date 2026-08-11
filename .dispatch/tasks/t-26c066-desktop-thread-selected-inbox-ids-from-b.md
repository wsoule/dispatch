---
id: t-26c066
title: "Desktop: thread selected inbox ids from Brain dump through to plan submission"
status: todo
kind: task
parent: e-61052f
milestone: null
blocked-by:
  - t-7c90d2
labels: []
priority: high
assignee: none
created: 2026-08-11T02:11:12.341Z
updated: 2026-08-11T02:11:12.344Z
external: null
writes:
  - apps/desktop/src/App.tsx
  - apps/desktop/src/views/BrainDumpView.tsx
  - apps/desktop/src/views/PlansView.tsx
  - apps/desktop/src/hooks/useDispatchProject.ts
---

## Description

Carry the ids behind "Group into an epic" / "Make an epic" through the existing seed-the-composer flow so they're attached when the user actually submits the plan.

Acceptance criteria:

- BrainDumpView's onPlanText gains an optional second inboxIds: string[] argument; the multi-select 'Group into an epic' button and each group's 'Make an epic' button pass their item ids, the existing single-item 'Plan it' call passes none
- App.tsx's plan-seed state carries the ids alongside the seeded text through to PlansView as a new initialInboxIds prop
- PlansView seeds a one-shot pendingInboxIds from initialInboxIds the same way it already seeds initialPrompt, and passes it to handleSubmitPrompt when the user clicks 'Plan work…'
- useDispatchProject's handleSubmitPrompt forwards inboxIds through to client.startPlan
- Editing the seeded prompt text before submitting does not drop the attached ids

## Acceptance Criteria

## Activity
