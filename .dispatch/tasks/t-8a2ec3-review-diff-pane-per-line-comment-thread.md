---
id: t-8a2ec3
title: "Review diff pane: per-line comment threads and expandable unchanged regions"
status: todo
kind: task
parent: e-ddd932
milestone: null
blocked-by:
  - t-46b6eb
  - t-021643
labels: []
priority: high
assignee: none
created: 2026-07-27T00:59:36.050Z
updated: 2026-07-27T00:59:36.050Z
external: null
---

## Description

Build the diff pane at the center of the Review screen's Files changed tab (docs/design/dispatch-nocturne.dc.html, the diff builder and the l.hasThread / l.composing blocks in renderVals). Start from the existing RunDiffView.tsx rather than a fresh diff renderer.

Layout per line: an old line number, a new line number, a comment affordance in the gutter, and the line content in monospace with added and removed lines tinted. The pane has its own header carrying the current file path, its +/- counts and a Viewed checkbox.

Two behaviors are the substance. Commenting: clicking a line's gutter opens a composer anchored beneath that line, labelled with the line number, with the copy stating where the note goes ("This goes back with the work"). Submitting adds a thread; existing threads render inline beneath their line with author, time, resolve, and a reply composer. Threads must not disturb the diff's line alignment when they open. And expandable context: unchanged regions between hunks collapse to a single row that states how many lines are hidden and expands in place, both directions.

Added/removed tinting uses the existing green/red -bg tokens per docs/design/README.md, not the mockup's hexes. The mockup's diff is a fixture; this reads the run's real diff.

Acceptance criteria:

- The real diff for the selected file renders with old/new line numbers and added/removed tinting from tokens
- Any line can be commented on from its gutter, with a composer anchored to that line
- Existing threads render inline at their line with author, time, resolve and reply
- Opening a thread or composer does not break the diff's line alignment
- Collapsed unchanged regions state how many lines are hidden and expand and collapse in place
- The pane header shows the file, its diff counts and a working Viewed toggle
- Long lines are handled without breaking the grid, and large diffs stay responsive
- Threads reflect the anchoring behavior decided in the persistence task, including when a line has moved
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
