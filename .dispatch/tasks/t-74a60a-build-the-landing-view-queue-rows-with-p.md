---
id: t-74a60a
title: "Build the Landing view: queue rows with per-check progress"
status: todo
kind: task
parent: e-3734d7
milestone: null
blocked-by:
  - t-982746
  - t-cfce10
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:58:32.826Z
updated: 2026-07-27T00:58:32.826Z
external: null
---

## Description

Build the Landing screen (docs/design/dispatch-nocturne.dc.html, the isLanding block) as a new view in apps/desktop/src/views/, added to the sidebar and the nav reducer in apps/desktop/src/lib/appNav.ts with a live count badge.

The merge queue band: one row per entry showing its queue position, the task title, the step it is on ("running typecheck", or "merged" when done), elapsed time since enqueue, and beneath that a segmented progress strip - one segment per verify step, each reading as passed, active or pending. A failed or blocked entry tints, states its reason in place of the step, and offers Retry.

Use the segmented progress primitive from the foundations epic rather than building a second one, and drive every segment from the real per-step state the API task exposes. No timers, no simulated advancement - if a step's state is unknown it renders as pending, not as progress.

The header line reports the queue summary and reinforces what the queue is for ("tests run before anything lands"). An empty queue needs a real empty state.

Colors from the run-state tokens only.

Acceptance criteria:

- Entries render in queue order with position, title, current step and elapsed time
- The segmented strip shows one segment per real verify step with correct passed/active/pending state
- No progress is simulated - segment state comes only from queue state
- Blocked and failed entries tint and state their reason where the step would be
- The view is in the sidebar with a badge that matches the row count, and is wired through the nav reducer
- The queue stays live while the view is open via the existing data-changed plumbing
- An empty queue reads as reassuring
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
