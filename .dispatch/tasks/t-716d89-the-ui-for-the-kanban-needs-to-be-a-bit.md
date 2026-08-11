---
id: t-716d89
title: the ui for the kanban needs to be a bit different…
status: done
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-11T01:52:30.113Z
updated: 2026-08-11T18:01:55.162Z
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
- 2026-08-11T17:25:24.146Z Shipped as eb595933. TaskBoard now always renders the epic-lane layout with a new EpicLaneHeader (chevron toggle, epic swatch, done/total progress bar, open-epic + dependency-graph buttons, concurrency stepper and Work/Stop); EpicCardTile is deleted, so epics are never draggable. A shared sticky status header carries the per-status visible count, the hover "+" new-task button, and the "+N hidden" badge summed over collapsed lanes. Collapse state is sessionStorage-backed, so it survives a switch to List view and back but not a restart. Two fixes fell out of the merge: drop zones are now keyed `lane:<index>:<status>` (identical bare-status ids meant @dnd-kit only registered one lane per status as a real drop target, so dragging inside any other lane did nothing), and j/k keep working while focus sits on a lane header instead of going dead right after you click one to expand it.

Heads-up for a human: apps/desktop/e2e/views.spec.ts-snapshots/tasks-{dark,light}-darwin.png are full-page shots of this exact view and will now mismatch. They need `bun run e2e:update` on a machine where Playwright can actually launch — this shell cannot (its webServer can't posix_spawn git), and regenerating baselines from a worktree is not safe. The layout also has not had a live visual check for the same reason; the sticky header/lane column alignment is asserted only structurally. — none
- 2026-08-11T17:25:52.607Z [run r-2d522b] finished: finished — 16 files, $10.98 — agent:wsoule679/claude
- 2026-08-11T18:01:55.162Z run r-2d522b merged into main — human:wsoule679
