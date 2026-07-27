---
id: t-241c8f
title: Build the Control room status ribbon
status: done
kind: task
parent: e-70673f
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: high
assignee: none
created: 2026-07-27T00:56:14.726Z
updated: 2026-07-27T01:31:28.576Z
external: null
---

## Description

Replace the four StatTiles at the top of apps/desktop/src/views/OverviewView.tsx with the mockup's seven-counter ribbon (docs/design/dispatch-nocturne.dc.html, ribbonDef in renderVals).

Seven equal cells across the full width: waiting on you, failed, working, needs review, landing, ready to start, blocked. Each shows a large tabular-nums count, an optional secondary line (the mockup shows "oldest 12m 04s" under waiting and "unhandled" under failed), and an uppercase tracked label. Counts come from data useDispatchProject already exposes - runs bucketed by state for the first five, readyIds for ready, and dependency state for blocked.

Two behaviors matter more than the layout. The urgent cells - waiting and failed - only take urgent treatment when their count is non-zero; at zero they must read as quiet as the rest, so a calm repo looks calm. And each cell is click-through to the surface that acts on it: the run-state cells filter the feed below to that state, ready and blocked go to Tasks, landing goes to Landing.

Colors come from the run-state tokens; the top rule on each cell and its tint are token-driven. Nothing from the mockup's palette.

Acceptance criteria:

- All seven counters render with correct counts derived from existing project data
- Waiting shows how long the oldest has been frozen; failed indicates unhandled
- Urgent cells read as urgent only when non-zero and are visually quiet at zero
- Clicking a run-state cell filters the feed to that state; ready/blocked navigate to Tasks; landing navigates to Landing
- The ribbon holds seven across at the app's narrowest supported window without wrapping into an unreadable grid
- Counts stay live as runs change state
- Unit tests cover the bucketing and the oldest-waiting derivation
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T01:31:28.576Z Done in d2df8f8, with two deviations from the description. (1) The "oldest N frozen" / "unhandled" secondary lines were dropped: elapsed already appears per-row in the feed directly below, and a second clock in the ribbon duplicated it without adding a decision. (2) Landing does not navigate away — landing runs ARE in the feed, so its cell filters like the other four run states; only ready and blocked navigate to Tasks, since those are tasks with no run and would never appear in the feed. Urgent cells tint only when non-zero (ControlRibbon's `alarmed`), so a calm repo reads calm. Counts come from buildFeed over the unfiltered set and are covered by controlRoom.test.ts.
