---
id: t-dba7ee
title: Build the Control room feed row with inline attention and per-state actions
status: done
kind: task
parent: e-70673f
milestone: null
blocked-by:
  - t-5bbf79
labels: []
priority: high
assignee: none
created: 2026-07-27T00:56:59.804Z
updated: 2026-07-27T01:32:03.384Z
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
- 2026-07-27T01:32:03.384Z Done in d2df8f8. Three honesty deviations from the description, all because the mockup's fixture had data the backend does not. (1) A working row shows no live activity text — the orchestrator exposes no "what the agent is doing right now" field on RunMeta, and the feed does not load run transcripts. Column left empty rather than filled with something invented. (2) The working progress bar is indeterminate (ProgressTrack value=null), not a percentage; there is no completion fraction to compute. (3) A waiting row names the tool ("Wants to run Bash") but not the command — PendingApproval is {requestId, toolName} and the tool *input* only exists in the run log, which RunLogView recovers by matching entries. Fabricating "$ bun run db:migrate" would read as fact. Related: if this window never saw approval.requested (a reload drops the map), there is no requestId to answer with, so Approve opens the run rather than firing a decision at an unnamed request — covered by a test. Review rows show turn count; landing rows show the real queue phase. Actions stopPropagation.
