---
id: e-92d17d
title: "Tasks: epic-grouped list, board lanes, and bulk dispatch"
status: done
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:55:02.121Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Reshape the Tasks surface to the mockup's version (docs/design/dispatch-nocturne.dc.html, the isTasks block; logic in epicList, board, lanes and the dispatch dialog in renderVals). Today this is BoardView.tsx with a list/board toggle over TaskBoard.tsx and TasksListView.tsx, plus TaskDetailDialog.tsx for the peek.

The organizing idea the mockup adds is that the epic is the unit of dispatch, not the task. Both views group by epic and give each epic a header carrying its progress bar, done/total, a live pulse ("3 need you" / "2 running" / "4 ready"), and a dispatch button that sends agents at every ready task in that epic at once. The board goes further: instead of one set of columns, each epic gets its own lane of six state columns (blocked, ready, working, needs you, in review, done), so a wide repo reads as a grid of epics against states rather than one long column per state. Needs you deliberately merges waiting and failed, because both mean the same thing to the user.

Bulk dispatch needs a confirmation step, because concurrency is capped: the dialog lists which ready tasks start now and which queue, given how many slots are already busy. That preview is the point of the dialog - dispatching twelve tasks into eight slots should not silently drop four.

The peek panel gains acceptance criteria with checkboxes, a sessions list, a self-review toggle, a model picker beside Dispatch, and a blocked-by list that states plainly when nothing is holding the task up.

Colors come only from the foundations epic's tokens.

Acceptance criteria:

- Both list and board group tasks by epic, with per-epic progress, done/total and a live pulse line
- Each epic can dispatch all of its ready tasks in one action
- The board lays out six state columns per epic lane, with needs-you merging waiting and failed
- Multi-select works in the list, and the bulk bar can dispatch, set priority and move to an epic across the selection
- The dispatch dialog previews which tasks start now versus queue against the real concurrency cap, and never silently drops any
- The peek shows description, acceptance criteria with per-criterion state, sessions, properties, self-review and blockers
- Blocked tasks name what blocks them; unblocked ones say so
- Empty columns and lanes hold their shape rather than collapsing the grid

## Acceptance Criteria

## Activity
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
