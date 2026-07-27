---
id: t-dba7ee
title: Build the Control room feed row with inline attention and per-state actions
status: todo
kind: task
parent: e-70673f
milestone: null
blocked-by:
  - t-5bbf79
labels: []
priority: high
assignee: none
created: 2026-07-27T00:56:59.804Z
updated: 2026-07-27T00:56:59.804Z
external: null
---

## Description

Build the feed row itself (docs/design/dispatch-nocturne.dc.html, the shown.forEach block inside the feed builder). This is where the Control room earns its density.

One row is a fixed column grid: state dot plus state label, task title, epic, an activity column, elapsed time right-aligned with tabular-nums, and actions right-aligned. What fills the activity column depends on state - a working agent shows what it is doing right now with a blinking caret, a run needing review shows its diff totals and turn count, a landing run shows which verify step it is on. Working rows also carry a thin progress bar along the bottom edge.

Urgent rows - waiting and failed - differ in three ways: a tinted background and hairline, slightly heavier title, and a second line beneath carrying the substance. For waiting that is the actual question the agent asked plus the command it wants to run; for failed it is the failure reason plus the run id. That second line is the whole point: the user should be able to approve or retry from the feed without opening anything.

Actions are per-state: waiting gets Approve and Deny, failed gets Retry and Read the error, review gets Review, landing gets Cancel. Working gets none - there is nothing to decide. Actions must stopPropagation so they do not also trigger the row's open behavior, and the row opens to the surface appropriate to its state (review to the Review screen, everything else to run detail).

Colors from the run-state tokens only. Reuse the primitives from the foundations epic rather than restyling inline.

Acceptance criteria:

- The row renders all columns with correct per-state activity content and elapsed time
- Working rows show live activity and a progress bar; review and landing rows show their own summary
- Urgent rows tint, emphasize their title, and show the real question or failure reason with the relevant command
- Per-state actions are correct, act on the real run, and do not trigger the row's open behavior
- Approving from the feed resolves the approval without navigating away
- Opening a row lands on the right surface for its state
- Titles, epics and activity text truncate cleanly rather than wrapping or overflowing the grid
- Row and action states are covered by unit tests on the derivation module
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
