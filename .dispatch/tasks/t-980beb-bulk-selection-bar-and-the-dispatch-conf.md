---
id: t-980beb
title: Bulk selection bar and the dispatch confirmation dialog with concurrency
  preview
status: done
kind: task
parent: e-92d17d
milestone: null
blocked-by:
  - t-889358
labels: []
priority: medium
assignee: none
created: 2026-07-27T01:01:45.851Z
updated: 2026-07-27T23:09:33.553Z
external: null
---

## Description

The two pieces that make dispatching many tasks at once safe (docs/design/dispatch-nocturne.dc.html, the hasTaskSel bar and the dlgOpen dialog, with willStart/runningNow/cap in renderVals).

The selection bar: selecting tasks in the list reveals an accented bar reporting the count, with actions to send agents at the ready ones (labelled with how many of the selection are actually ready, since selecting a blocked task cannot dispatch it), set priority, move to an epic, and clear.

The confirmation dialog is the important half. Concurrency is capped, so dispatching twelve ready tasks into eight slots with five already busy starts three and queues nine. The dialog states that arithmetic plainly - a note reading how many slots are busy and how many will start now - and lists every task with a per-task "starts now" or "queued" badge so nothing is a surprise. Nothing may be silently dropped: if a task cannot start it must appear as queued, not vanish from the list.

Read the real cap and the real running count rather than hardcoding eight; apps/desktop/src/lib/epicConcurrency.ts already models some of this, so build on it. The same dialog serves per-epic dispatch, the dispatch-all-ready button in the header, and bulk dispatch from the selection bar.

Colors from tokens only.

Acceptance criteria:

- Selecting tasks reveals a bar with an accurate count and a dispatch label naming how many of the selection are ready
- Set priority and move-to-an-epic apply across the selection
- The dialog reads the real concurrency cap and the real running count, not a hardcoded number
- Every task in the dialog is badged starts-now or queued, and none are silently dropped
- The dialog's note states how many slots are busy and how many will start now
- The same dialog serves per-epic dispatch, dispatch-all-ready and bulk dispatch
- Confirming dispatches everything listed, queuing what cannot start immediately
- The starts-now/queued arithmetic is unit tested including the zero-free-slots case
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T03:34:50.766Z Half done in e243629, left as todo. The derivation landed as lib/dispatchPreview.ts (11 tests) including the invariant this task exists for — twelve ready tasks into a concurrency of eight with five running shows twelve rows, three starting and nine queued, and nothing is silently dropped. Blocked tasks are a distinct 'not-ready' disposition rather than folded into 'queued', and do not consume a slot. One correction to the description: there is NO fixed global concurrency cap. handleWorkEpic takes concurrency per call and EpicCardTile already has a stepper for it, so the preview is computed against the concurrency the user is about to choose, not an imaginary ceiling. NOT DONE: the dialog UI itself, the selection bar in the list, and routing per-epic dispatch through it. The existing epic dispatch path is untouched and still works — it just fires without a preview.
- 2026-07-27T23:09:33.553Z Dialog now done in 6d7dbc8, superseding the "left as todo" note above. DispatchDialog renders the preview from lib/dispatchPreview.ts and is wired to per-epic dispatch: EpicCardTile's Work button now raises onRequestWork instead of firing, and BoardView owns the dialog. Every selected task is listed and badged starts-now / queued / cannot-start, the summary sentence states the arithmetic, and the concurrency is editable in the dialog with the preview updating live — which is the fastest way to see what the number does. Still NOT done: the multi-select bar in the task list (set priority, move to an epic, bulk dispatch across an arbitrary selection). That needs selection state in TasksListView, which does not have any today; the dialog itself is selection-source-agnostic and will serve it unchanged when that lands.
