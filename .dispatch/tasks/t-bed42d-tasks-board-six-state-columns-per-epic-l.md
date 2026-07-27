---
id: t-bed42d
title: "Tasks board: six state columns per epic lane"
status: todo
kind: task
parent: e-92d17d
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: medium
assignee: none
created: 2026-07-27T01:01:12.357Z
updated: 2026-07-27T01:01:12.357Z
external: null
---

## Description

Reshape the board half of the Tasks view (docs/design/dispatch-nocturne.dc.html, the viewIsBoard block with board, lanes and colDefs in renderVals), building on TaskBoard.tsx and the existing grouping in apps/desktop/src/lib/boardGrouping.ts.

The change from a conventional board: instead of one set of columns holding every task, the six state columns repeat per epic. Each epic is a lane - its own header row with progress and dispatch, then a six-column grid of just that epic's tasks. A sticky column header strip at the top of the scroll area names the six states with their overall counts. The result reads as a grid of epics against states, which is the view that answers "which epic is stuck" rather than "what is in review".

The six columns are blocked, ready, working, needs you, in review, done. Two of them merge states deliberately: needs you covers both waiting-on-you and failed, because both mean the same thing to the user; in review covers needs-review and landing. Keep that merge - it is the point.

Cards are compact: state dot, task id, a short meta word (running / blocked / ready), the title, and a Send agent button on ready cards. Empty columns keep their shape with a faint placeholder so the grid does not collapse and misalign lanes.

Colors from the run-state tokens only.

Acceptance criteria:

- Each epic renders as a lane of six state columns, with a sticky header strip naming the states and their overall counts
- Needs-you merges waiting and failed; in-review merges needs-review and landing
- Cards show state, id, meta and title, with Send agent on ready cards
- Empty columns hold their shape so lanes stay aligned
- Epic lane headers carry progress, done/total, pulse and per-epic dispatch, consistent with the list view
- The board scrolls both directions without losing the sticky header or misaligning columns
- Column assignment is unit tested, including the two merged columns
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
