---
id: t-e2d9d6
title: Stop persisted inbox rows dead-ending on drafts and plans that no longer exist
status: backlog
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: low
assignee: none
created: 2026-08-04T12:48:41.979Z
updated: 2026-08-04T12:48:41.979Z
external: null
writes:
  - apps/desktop/src/lib/inbox.ts
  - apps/desktop/src/App.tsx
  - apps/desktop/src/components/shell/InboxPanel.tsx
---

## Description

The notification inbox persists to localStorage, but the things its new `draft` and `plan` targets point at live only in dispatchd's memory. After a daemon restart — or a draft eviction, or a dismiss in another window — the row survives and the target does not.

Two concrete symptoms:
- A `{kind:'draft'}` row navigates to the draft page, which correctly renders "That draft is no longer available" but is a dead end the user has to back out of manually.
- A `{kind:'plan'}` row carries a `planId` that `navigateFromInbox` (apps/desktop/src/App.tsx) ignores entirely — it just calls `selectProjectView('plans')`. Today that cannot diverge, because the same single `planRecord` feeds both the detector and PlansView, so the id buys nothing and silently would not be honoured if a second plan slot were ever added.

Worth deciding rather than patching blindly: either resolve targets at click time and prune rows whose target is gone, or mark rows stale in the panel so they read as history rather than as actions. Pruning on daemon restart is probably the cleaner story given drafts are explicitly non-durable (see PlanManager's own doc comment — "a plan that was still running when dispatchd restarts is simply gone").

Acceptance criteria:
- Clicking an inbox row whose draft no longer exists does not strand the user on a dead-end page
- A `{kind:'plan'}` row either honours its `planId` or stops carrying one
- Rows for still-live drafts and plans behave exactly as they do now
- inbox.ts stays pure and its tests still pass

Context: raised as minor #7 in the whole-branch review of the planner-questions work shipped in v0.15.0.

## Acceptance Criteria

## Activity
