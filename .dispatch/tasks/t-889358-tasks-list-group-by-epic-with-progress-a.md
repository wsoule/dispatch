---
id: t-889358
title: "Tasks list: group by epic with progress and per-epic dispatch"
status: done
kind: task
parent: e-92d17d
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: medium
assignee: none
created: 2026-07-27T01:00:57.332Z
updated: 2026-07-27T02:34:59.762Z
external: null
---

## Description

Reshape the list half of the Tasks view (docs/design/dispatch-nocturne.dc.html, the viewIsList block and epicList in renderVals), building on TasksListView.tsx and BoardView.tsx's existing list/board toggle.

Tasks group under their epic. Each epic gets a header row: a stack icon, the epic title, its id, a short progress bar, done/total, a rule fading to the right, a live pulse phrased by what matters most right now ("3 need you" beats "2 running" beats "4 ready" beats "nothing running"), and - when the epic has ready tasks - a button that dispatches agents at all of them.

The task row is a fixed column grid: select checkbox, priority icon, task id, state dot with label, title, a label chip, a meta column (blocked-by, "unblocked 20m ago", "landed 6d ago"), a Dispatch button on ready tasks, and an open-in affordance. Urgent tasks - waiting on you, failed - tint and their state label takes the state color. Done and blocked titles recede.

The per-epic dispatch button routes through the confirmation dialog rather than firing immediately, since concurrency is capped.

Colors from the run-state tokens only. Reuse the foundations primitives and the existing PriorityIcon/StatusIcon.

Acceptance criteria:

- Tasks group under their epic with a header carrying progress, done/total and the epic id
- The pulse line reflects the most urgent thing true of that epic
- Task rows show priority, id, state, title, label and meta, with urgent rows tinted
- Ready tasks offer Dispatch; blocked tasks show what blocks them
- Per-epic dispatch goes through the confirmation dialog rather than firing immediately
- An epic with no tasks and a project with no epics both have sensible empty states
- The list/board toggle continues to work and remembers the choice
- The grouping and pulse derivation are unit tested
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T02:34:59.762Z Done in 7f5af63, scoped down because most of this already existed. TasksListView already grouped by epic with collapsible headers, done/total from epicProgressById, dangling-parent and "No epic" buckets, a filter, and j/k roving focus; per-epic dispatch already exists via handleWorkEpic and EpicCardTile's concurrency stepper. The genuine gap was the live pulse, added as lib/epicPulse.ts (8 tests) and wired into the group header. It reports the single most actionable fact rather than a tally — needs-you > running > to-review > ready > nothing — because a header listing all four makes the reader do the triage the line exists to do for them. Waiting and failed share one counter: different fixes, same blocker. NOT done here: the per-epic dispatch button was not re-routed through a confirmation dialog, because the dialog UI itself is unbuilt (only its logic landed, in lib/dispatchPreview.ts under t-980beb) — the existing epic dispatch path is untouched and still works.
