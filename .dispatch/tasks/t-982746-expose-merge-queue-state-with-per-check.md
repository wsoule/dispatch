---
id: t-982746
title: Expose merge-queue state with per-check detail over the API and SDK
status: todo
kind: task
parent: e-3734d7
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:58:17.738Z
updated: 2026-07-27T00:58:17.738Z
external: null
---

## Description

The merge queue already runs in packages/server/src/orchestrator/mergeQueue.ts, but the desktop app can only see it one entry at a time through QueueMergeControl. The Landing view needs the queue as a whole, with enough per-entry detail to draw the progress strip honestly.

Work out what the queue already tracks versus what the view needs and close the gap. Per entry: its position in line, the task and run it belongs to, when it was enqueued, its current phase, and the state of each verify step it has run or will run - the mockup's four are install, typecheck, tests and merge, but the real step list should come from the configured verify command rather than being hardcoded to four. A blocked or failed entry needs its reason, including the offending paths where the block is a dirty checkout. Also needed: today's completed entries, merged and failed, with the failure reason.

The important constraint is that the view must not simulate progress. The mockup derives its step from a tick counter because it has no backend; the real thing reads actual step state. If the queue does not currently record per-step state, adding that is the substance of this task.

Expose it on the server and the client SDK following the surrounding conventions, and emit the existing data-changed signal on queue transitions so the view stays live without its own polling loop.

Acceptance criteria:

- The full queue is readable in order with position, task, run, enqueue time and current phase per entry
- Per-step verify state is real, recorded by the queue, and the step list derives from the configured verify command rather than a hardcoded four
- Blocked and failed entries carry a reason, including offending paths for a dirty checkout
- Completed-today entries are readable with merged/failed outcome and failure reason
- A retry/recheck operation is exposed and reports its outcome
- Queue transitions emit the existing data-changed signal
- Tests cover the queue read model and per-step state transitions
- QueueMergeControl continues to work against the same state, with no second source of truth
- bun run format, bun run lint and the server/client tsc/tests are green

## Acceptance Criteria

## Activity
