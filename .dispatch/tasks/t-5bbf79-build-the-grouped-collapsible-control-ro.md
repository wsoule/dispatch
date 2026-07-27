---
id: t-5bbf79
title: Build the grouped, collapsible Control room feed
status: done
kind: task
parent: e-70673f
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: high
assignee: none
created: 2026-07-27T00:56:43.875Z
updated: 2026-07-27T01:31:43.152Z
external: null
---

## Description

Replace the two-column grid of SectionCards in apps/desktop/src/views/OverviewView.tsx with one continuous grouped feed (docs/design/dispatch-nocturne.dc.html, the feed builder in renderVals).

Five groups in a fixed priority order - waiting on you, failed, working, needs review, landing - so the things that need a human are always at the top and the order never shifts under the cursor. Each group gets a header row: a chevron, a state dot, the uppercase tracked label, the total count in that state, and a rule fading out to the right. Headers collapse and expand individually and the state persists while the view is open.

Each group caps how many rows it shows (the mockup uses seven for working, five for the rest) and then emits an explicit "show the other N working" row rather than silently slicing - and once expanded, a matching row to collapse back. This is the detail that makes the feed trustworthy at fifty agents, and it is why the filter bar carries a shown/total readout.

Groups with no rows are omitted entirely rather than rendering an empty header, but the feed as a whole needs a real empty state for a repo with nothing running - the current SectionCards' reassuring-not-broken tone is the bar to match.

Build this as the feed container and group mechanics only; the row itself is the next task. Keep the row-model derivation in a testable lib module rather than inline JSX, following the repo's lib + colocated test convention.

Acceptance criteria:

- Five groups render in fixed priority order, urgent first, and empty groups are omitted
- Group headers show state, label and total count, and collapse/expand individually
- Each group caps its rows and exposes the remainder behind an explicit show-more row
- An expanded group can be collapsed back to its cap
- The whole-feed empty state reads as reassuring, not broken
- The feed scrolls as one list rather than nested scroll areas
- Group ordering is stable as runs change state - rows must not reorder unpredictably under the cursor
- The row-model derivation lives in a tested lib module
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
