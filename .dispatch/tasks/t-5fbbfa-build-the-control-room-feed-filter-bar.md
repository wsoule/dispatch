---
id: t-5fbbfa
title: Build the Control room feed filter bar
status: done
kind: task
parent: e-70673f
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:56:29.318Z
updated: 2026-07-27T01:31:34.117Z
external: null
---

## Description

Add the filter band that sits between the ribbon and the feed in the mockup (docs/design/dispatch-nocturne.dc.html, the feedQuery/chips/shownLabel/collapseAll bindings in renderVals).

Four pieces on one row. A search input matching on task title, task id and epic name together, so "worktree", "t-9f2a41" and "Runtime" all work without a mode switch. A set of toggleable status chips (waiting, failed, working, review, landing), each carrying its own count, multi-selectable and OR-combined - and shared with the ribbon, so clicking a ribbon cell sets the matching chip and the two never disagree about what is filtered. An "N of M shown" readout, which is what makes the feed's per-group caps honest rather than a silent truncation. And a collapse-all/expand-all toggle over the feed's group headers.

Filter state belongs wherever the feed can read it without prop-drilling through every row; follow how the existing views manage local view state rather than introducing a new pattern.

Colors from tokens only.

Acceptance criteria:

- The query filters on title, id and epic in one field, case-insensitively
- Status chips toggle independently, combine as OR, and show per-state counts
- Chip state and ribbon clicks are the same state - selecting either updates both
- The shown/total readout is accurate including the effect of per-group caps
- Collapse-all and expand-all act on every group and the label reflects which action is next
- Clearing the query and chips returns the feed to its full grouped state
- Unit tests cover the match predicate and the shown/total arithmetic
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
