---
id: t-8e5196
title: Build a full-page, describe-what-you-want task creator
status: todo
kind: task
parent: e-359627
milestone: null
blocked-by:
  - t-d6c287
labels: []
priority: medium
assignee: none
created: 2026-07-26T19:06:42.667Z
updated: 2026-07-27T01:27:00.223Z
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
- 2026-07-26T21:47:15.333Z requested changes (run r-75a646): continue
- 2026-07-26T21:50:26.836Z Done. Added apps/desktop/src/views/NewTaskView.tsx (composer -> editable draft -> Create task), lib/taskDraft.ts (+tests) for the draft->CreateInput mapping, and navReducer open/closeNewTask + Escape handling (+tests). App.tsx's openCreateTask now routes the header button, board/list "+", palette "New task" and the "c" shortcut to the page; CreateTaskModal stays as quick-add via a new palette entry and the page's own "Quick add…" button, and shares the pre-selected status.

Verified: 113/113 desktop tests, tsc, format, lint clean (41 lint warnings all pre-existing, none in new files). Drove the real data path against a live dispatchd with a FakePlanner registered as 'claude' — draft -> inline edits -> createTask wrote a task file with the pre-selected status, epic parent, trimmed title and the criteria folded into the body. Server-rendered the view in all four states (composer, drafting/daemon-starting, daemon-failed, draft review). No browser-level interaction test: agent-browser and Playwright are unavailable in this environment.

Two notes for the epic: (1) this branch merges t-d6c287 (unmerged dependency) so it compiles — that merge collapses to nothing once t-d6c287 lands first. (2) Draft acceptance criteria land as a bullet block inside "## Description" while the "## Acceptance Criteria" section stays empty — that's taskDraftToCreateInput's documented behavior from t-d6c287 (TaskStore.create ignores a separate criteria field), same as confirmed-plan tasks, but worth a follow-up if the empty section reads as a bug. Also unrelated/pre-existing: packages/cli/test/mcp-stdio-e2e.test.ts fails on main — its expected MCP tool list is missing dispatch_note.
- 2026-07-26T21:50:45.753Z [run r-75a646] finished: finished — 15 files, $3.01
- 2026-07-27T00:24:19.962Z run r-75a646 merged into main
- 2026-07-27T01:27:00.223Z run r-47cdd2 discarded
