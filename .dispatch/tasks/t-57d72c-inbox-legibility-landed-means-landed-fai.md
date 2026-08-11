---
id: t-57d72c
title: "Inbox legibility: landed means landed, failures get their own section"
status: in-review
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - ui
priority: high
assignee: none
created: 2026-08-11T21:17:23.645Z
updated: 2026-08-11T22:59:44.705Z
external: null
writes:
  - apps/desktop/src/views/InboxView.tsx
  - apps/desktop/src/views/InboxView.test.tsx
  - apps/desktop/src/views/LandingView.tsx
  - apps/desktop/src/views/LandingView.test.tsx
  - apps/desktop/src/lib/landingHistory.ts
  - apps/desktop/src/lib/landingHistory.test.ts
---

## Description

The Inbox's embedded merge-queue section (LandingView) reads as chaos — screenshot from Wyat 2026-08-11 ~17:08: a section titled RECENTLY LANDED listing four red FAILED rows ("lint failed: $ oxlint --typ…", "test timed out after 1500s …", "run was already reviewed wh…") — things that specifically did NOT land, under a heading that says they did. Above it, "Landing — nothing in the queue" and "MERGE QUEUE 0 — Nothing is waiting to land" say the same empty thing twice.

Fix the composition:
1. Split queue history into two clearly labeled groups: "Landed" (successful merges only) and "Failed to land" (failed queue attempts), the latter with the error legible — full text on the row or expandable, not truncated monospace — and a per-row Retry (re-enqueue) action.
2. Drop failed attempts whose run has since been reviewed/merged anyway (state derivable from the run list: reviewedAt set means the failure is stale history — collapse those behind a "N stale attempts" disclosure instead of headline rows).
3. Collapse the empty-queue chrome to ONE line ("Merge queue: empty") instead of a Landing header plus a Merge queue section both saying nothing is queued.
4. A run present in Needs review whose latest queue attempt failed should carry a small "verify failed" badge on its needs-review row, so the two sections tell one story.

Keep everything inside LandingView/InboxView; pure derivation (which history entries are stale, grouping) goes in a small lib with tests — happy-dom component tests for the section split and the badge.

## Acceptance Criteria

## Activity
- 2026-08-11T21:18:11.405Z dispatched (claude, branch dispatch/t-57d72c-inbox-legibility-landed-means-landed-fai-403c41) — human:wsoule679
- 2026-08-11T22:59:10.765Z Done in be0c7178. New pure lib apps/desktop/src/lib/queueHistory.ts: groupQueueHistory splits queue history into landed (merged only) / failed (live failures) / stale (run reviewedAt set, superseded by a newer attempt, or back in the live queue — the last rule keeps a just-retried failure from headlining next to its own queue entry). LandingView: empty queue is one line ("Merge queue: empty", no Landing header), "Landed" and "Failed to land" sections, full error text on failed rows, per-row Retry via handleEnqueueMerge with inline 409 errors, stale attempts behind an "N stale attempts" disclosure. InboxView: "verify failed" badge on needs-review rows whose latest attempt failed (suppressed while re-queued). Verified: 1315 desktop tests pass across 122 files, tsc clean, lint 0 errors, knip clean. Three guard mutations recorded (2/1/1 tests killed). — none
- 2026-08-11T22:59:44.705Z [run r-403c41] finished: finished — 6 files, $15.05 — agent:wsoule679/claude
