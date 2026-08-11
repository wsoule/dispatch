---
id: t-716d89
title: the ui for the kanban needs to be a bit different…
status: in-progress
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-11T01:52:30.113Z
updated: 2026-08-11T17:00:44.872Z
external: null
writes: []
---

## Description

Merge the separate 'board' (flat status columns) and 'lanes' (epic swim lanes) view modes into a single unified kanban where epics act as expandable/collapsible headers. When expanded, an epic displays status columns with its child tasks; when collapsed, tasks hide but show a '+N hidden' badge on column headers. Only plain tasks are draggable (epics are UI containers, not objects). This removes the swimLanes toggle from BoardView and simplifies the view mode options to list/board/milestones. When viewing in the new board layout, clicking the epic header toggles visibility of its children; expanding/collapsing state is session-local. The 'No epic' lane for unparented tasks still appears at the bottom. Existing features (drag-and-drop, inline dispatch, progress bars, live run indicators) continue to work within the new structure.

## Acceptance Criteria

- Board view always shows epic grouping with expandable/collapsible headers (no swimLanes toggle)
- Clicking epic header expands to show status columns and child task cards; clicking again collapses
- Collapsed epics hide children but show '+N hidden' badge on affected column headers (showing visible count separately)
- Only plain task cards are draggable; epic headers cannot be dragged
- Dragging a task between statuses within a single epic works as before
- View mode toggle no longer offers 'lanes' as a separate option; 'board' is now the unified layout
- Expanding/collapsing state persists for the current session (localStorage not required)
- 'No epic' lane for tasks with null parent appears at the bottom, collapsible like other epics
- Empty epics (with no child tasks in configured statuses) are not rendered
- All existing features work in new layout: drag-and-drop, inline task dispatch, inline edit (priority/assignee), epic dispatch button, epic progress bar, live run state indicators, focused/archived task styling
- Keyboard navigation (j/k roving focus) still works and traverses only visible cards

## Activity
- 2026-08-11T16:57:53.215Z dispatched (claude, branch dispatch/t-716d89-the-ui-for-the-kanban-needs-to-be-a-bit-2d522b) — human:wsoule679
- 2026-08-11T17:00:44.872Z Read the current board code. Plan: TaskBoard loses `swimLanes` and always renders the epic-lane layout; each lane gets an expandable header (chevron + swatch + title + progress bar + Work/Stop + DAG button), replacing EpicCardTile (which becomes dead code and gets deleted — epics stop being draggable cards). A sticky status-header row sits above the lanes carrying per-status visible counts, the hover "+" new-task button, and the "+N hidden" badge summed over collapsed lanes. Collapsed-epic ids live in sessionStorage (session-local, no localStorage). Drop-zone ids become `lane:<i>:<status>` — today every lane registers a droppable with the same `status` id, so @dnd-kit's id-keyed container map means only one lane per status is really a drop target. j/k ordering in BoardView switches to lane-order over visible (expanded) cards only. — none
