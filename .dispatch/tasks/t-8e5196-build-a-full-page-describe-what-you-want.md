---
id: t-8e5196
title: Build a full-page, describe-what-you-want task creator
status: in-review
kind: task
parent: e-359627
milestone: null
blocked-by:
  - t-d6c287
labels: []
priority: medium
assignee: none
created: 2026-07-26T19:06:42.667Z
updated: 2026-07-26T20:52:37.142Z
external: null
---

## Description

Create a Linear-style full-page task-creation view that mirrors the Plans view: a large 'Describe the task…' composer where the user types natural language, a generated single-task draft they can edit inline (reusing the field/editing patterns from PlanTaskRow and CreateTaskModal), and a save action. Make this the primary 'New task' entry point wired through App.tsx's openCreateTask, the command palette 'New task' command, and the board column '+' (onNewTask), while keeping CreateTaskModal available as a quick-add fallback. Pre-selecting a status from a board column should still work.

Acceptance criteria:

- A dedicated full-page task-creation view exists (styled consistently with PlansView) with a natural-language composer and an editable generated task draft
- The view calls the natural-language single-task endpoint, lets the user edit the resulting fields, and saves via the existing createTask/handleCreate path
- The header 'New task' button, command palette 'New task' command, and board column '+' route to the new page (via the openCreateTask/onNewTask wiring in App.tsx and TaskBoard.tsx), and a status passed from a board column pre-selects that status
- CreateTaskModal remains reachable as a quick-add fallback so structured entry is not lost
- Keyboard/escape and daemon-unavailable behaviors match the existing views

## Acceptance Criteria

## Activity
- 2026-07-26T20:35:35.422Z dispatched (claude, branch dispatch/t-8e5196-build-a-full-page-describe-what-you-want-47cdd2)
- 2026-07-26T20:37:31.746Z Starting. Depends on t-d6c287 (natural-language single-task endpoint), which is finished but not yet merged to main — its branch adds `client.draftTask()`, `TaskDraft`, `taskDraftToCreateInput()`, and `data.handleDraftTask`. Merging that branch into this one so the UI compiles and runs end-to-end; the overlap collapses once t-d6c287 lands first.
- 2026-07-26T20:52:37.142Z [run r-47cdd2] finished: failed — 0 files, $9.29
