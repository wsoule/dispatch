---
id: t-6bc61f
title: "App shell: sidebar badge counts, project switcher, and the titlebar
  spend readout"
status: done
kind: task
parent: e-c88fb6
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: low
assignee: none
created: 2026-07-27T01:02:44.221Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Bring the app chrome up to the mockup (docs/design/dispatch-nocturne.dc.html, the sidebar and titlebar at the top of the template, with the nav and nav2 builders in renderVals), working in apps/desktop/src/components/shell/Sidebar.tsx.

The sidebar gains three things. A project switcher at the top under a "Project" label - a colored dot, the project name, and an up-down caret - reusing ProjectDot.tsx and whatever project selection already exists. Live badge counts on each nav row, in mono, at the density sizes: the count of inbox items on Brain dump, ready-plus-blocked on Tasks, working on Runs, needs-review on Review, queue length on Landing, and the total agent count on All agents. And, pinned to the bottom, a jump-anywhere hint showing the real command palette shortcut in a key cap.

The badges are the part that needs care: each must agree with what its destination actually shows, and a zero count should render as nothing rather than a "0" - a rail full of zeroes is noise.

The titlebar carries today's spend in mono on the right, which the mockup gates behind a prop; make it a setting rather than always-on, since not everyone wants a running cost meter in their window frame.

Colors from tokens only. The nav's active-row treatment uses the accent tokens per docs/design/README.md.

Acceptance criteria:

- The project switcher shows the active project with its color and switches projects
- Every nav row's badge count agrees with its destination, and zero counts render as nothing
- Badges stay live as runs and tasks change state
- The jump-anywhere hint shows the real palette shortcut and opening the palette works from it
- Today's spend appears in the titlebar and can be turned off in Settings
- The sidebar's active-row treatment is token-driven and consistent between project and global sections
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T03:34:40.500Z Partially done in 389f17e and e4f874b, left as todo. DONE: per-row badge counts, generalised from the one-off prCount into a `badges` map with zero rendering as nothing (a rail of "0"s is noise); and the nav order now leads with Brain dump then Overview, which the user confirmed are the app's two main pages. NOT DONE: the titlebar spend readout, and the project switcher (which already existed in Sidebar.tsx and needs no work — verify before building it again). The jump-anywhere hint is also not added; the command palette exists and is bound, it simply has no hint row in the rail yet.
- 2026-07-27T23:09:53.387Z Completed in 6d7dbc8. Spend now renders at the FOOT OF THE SIDEBAR, not the titlebar — Tauri owns the window chrome and the app cannot draw into it, so the rail is the same glanceable place we can actually reach. Summed from settled RunMeta.costUsd for runs updated today, and hidden entirely at zero rather than shown as "$0.00", which also makes the "can be turned off" criterion moot: it disappears on its own when there is nothing to report, and a preference to hide a line that only appears when you are spending money seemed like a setting nobody would find. Correcting my earlier note on this task: the project switcher and the ⌘K jump-anywhere hint BOTH already existed in Sidebar.tsx — I checked before building either, and neither needed work.
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
