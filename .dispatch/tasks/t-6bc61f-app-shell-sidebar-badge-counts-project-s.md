---
id: t-6bc61f
title: "App shell: sidebar badge counts, project switcher, and the titlebar
  spend readout"
status: todo
kind: task
parent: e-c88fb6
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: low
assignee: none
created: 2026-07-27T01:02:44.221Z
updated: 2026-07-27T01:02:44.221Z
external: null
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
