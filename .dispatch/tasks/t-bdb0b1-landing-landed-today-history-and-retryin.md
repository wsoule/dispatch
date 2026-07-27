---
id: t-bdb0b1
title: "Landing: landed-today history and retrying a blocked entry"
status: done
kind: task
parent: e-3734d7
milestone: null
blocked-by:
  - t-74a60a
labels: []
priority: low
assignee: none
created: 2026-07-27T00:58:46.371Z
updated: 2026-07-27T01:39:46.372Z
external: null
---

## Description

Finish Landing with the second band and the retry path (docs/design/dispatch-nocturne.dc.html, historySrc and the queue retry binding in renderVals).

Landed today: a compact history below the queue, one row per completed entry with the task title, a merged/failed tag, the failure reason on failed rows, and how long ago it finished. Failed rows name the actual command that failed ("verify failed: bun run typecheck") rather than just saying it failed. Collapsed to the most recent few behind an explicit show-all-N-from-today row, matching how the mockup handles the same problem in the feed.

Retry: a blocked or failed entry can be re-checked in place. The recheck endpoint exists per the API task; this wires the action, invalidates the queue query so the panel reflects the outcome without a manual refresh, and keeps the reason visible next to the action while it is still blocked. Retry must be hidden while an entry is mid-flight - rebasing, verifying or merging - since re-entering a running entry is not meaningful.

There is an existing task in the backlog covering the Retry button for merge-queue entries blocked on checkout; check for it and either fold it in or mark the overlap rather than shipping two Retry buttons.

Colors from tokens only.

Acceptance criteria:

- Landed-today lists completed entries with outcome, elapsed and the naming of what failed
- History is collapsed to a few rows with an explicit show-all
- Retry is available on blocked and failed entries and hidden while an entry is mid-flight
- Retry re-checks the entry and the view reflects the outcome without a manual refresh
- The block reason stays visible next to the action while the entry is still blocked
- Overlap with the existing merge-queue Retry task is resolved, not duplicated
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
