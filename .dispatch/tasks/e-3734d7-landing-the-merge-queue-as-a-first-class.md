---
id: e-3734d7
title: "Landing: the merge queue as a first-class view"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:54:10.468Z
updated: 2026-07-27T00:54:10.468Z
external: null
---

## Description

Build the mockup's Landing screen (docs/design/dispatch-nocturne.dc.html, the isLanding block; logic in the queue builder and historySrc in renderVals). The second of two screens with no equivalent in the app today - though unlike Brain dump, the backend already exists.

packages/server/src/orchestrator/mergeQueue.ts already runs the queue. The desktop app only exposes it through QueueMergeControl, a control attached to a single run, so there is no way to see the queue as a queue: what is in line, what position, which check each entry is on, and what failed. Landing is that view.

Two bands. The merge queue itself: one row per entry with its position, title, the step it is currently on, elapsed time, and a four-segment progress strip (install, typecheck, tests, merge) where completed segments read as passed, the current one as active, and the rest as pending. A failed entry tints, names the failure, and offers Retry. Below it, landed today: a compact history of what merged and what did not, with the failure reason on failed entries, collapsed to the most recent few behind a show-all.

The mockup's progress strip is fixture-driven and derives its step from a tick counter. The real version must read actual check state from the merge queue rather than simulate it, which is the main piece of work here. Colors come only from the foundations epic's tokens.

Acceptance criteria:

- Landing lists real merge-queue entries in queue order with their position and elapsed time
- Each entry shows which verify step it is on, with per-step state that reflects the queue rather than a timer
- A blocked or failed entry names why, and Retry re-runs it and reflects the outcome without a manual refresh
- Landed-today history shows merged and failed entries, with the failure reason on the failed ones
- History is collapsed to a few entries with an explicit show-all
- Queue state stays live while the view is open, and the sidebar badge agrees with the row count
- The existing QueueMergeControl and this view do not disagree about an entry's state

## Acceptance Criteria

## Activity
