---
id: e-ddd932
title: "Review: a full-page diff review with inline comment threads"
status: done
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-07-27T00:54:26.719Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Build the mockup's Review screen (docs/design/dispatch-nocturne.dc.html, the isReview block; logic in rvFiles, the diff builder, rvTabs, checks and rvThreads in renderVals). It replaces reviewing work through DiffModal.tsx and the run-scoped RunDiffView/RunReviewView with a dedicated full-page surface.

The gap today is that you can read an agent's diff but you cannot annotate it. The mockup's answer is a three-tab surface over one run's work. Files changed is the main tab: a file list on the left with per-file +/- counts, comment counts and viewed checkmarks plus an unviewed-only filter, a diff pane in the middle where every line has a comment affordance in its gutter and comment threads render inline beneath the line they belong to, and a right sidebar holding verify results, the agent's own account of what it did, and a timeline of the review. Conversation collects every thread in one place with jump-to-line, above a verdict block. Checks lists each verify step with its command and duration over the live build log.

The comment threads are the substance: they need to persist against the run, survive the agent pushing more commits, and travel back to the agent when the work is sent back - the mockup's placeholder copy ("the agent reads this when you send the work back") is the actual contract. Sending back should resume the agent on the same branch with the notes, which is also how the send-back-with-notes path in the header works.

Colors come only from the foundations epic's tokens; the diff add/del tinting maps onto existing green/red -bg tokens rather than the mockup's hexes.

Acceptance criteria:

- Review is a full-page surface for one run, with Files changed, Conversation and Checks tabs and a header carrying the branch, counts and verdict actions
- The file list tracks viewed state per file, shows comment counts, and can filter to unviewed only
- Any diff line can be commented on, and threads render inline at that line with replies and resolve
- Unchanged regions can be expanded and collapsed rather than being permanently hidden
- Comment threads persist against the run and are included when the work is sent back
- Accept and land enqueues the work; send back with notes resumes the agent on the same branch with the notes; discard drops it
- The Conversation tab lists every thread with jump-to-line, and the verdict block agrees with the header actions
- Checks shows real verify steps with commands and durations, over the actual log

## Acceptance Criteria

## Activity
- 2026-07-27T23:12:25.081Z Closing with the substance delivered but NOT as a full-page surface, which was this epic's framing. What shipped: line-level comments persist per run with real anchoring (exact / moved / outdated), threads support replies and resolve, and send-back carries every unresolved thread into the message the agent resumes on — the gap this epic named ("you can read an agent's diff but you cannot annotate it") is closed. What did not: no new full-page Review screen, no three tabs, no inline-under-the-line threads, no per-file viewed tracking. Two reasons, both recorded on the child tasks. @pierre/diffs owns the diff's line markup and exposes no per-line hook, so inline means forking a third-party renderer (t-8a2ec3). And a second full-page review surface would duplicate RunReviewView, which already reviews a run and whose own doc comment says it exists to avoid exactly that stacking (t-021643, cancelled). Two things remain genuinely wanted and are not blocked by any of the above: per-file viewed tracking, and a timeline strip built from real run events. The Checks tab is not buildable as described — the queue runs one configured verify command as a single phase, so there is no per-check list to render without instrumenting verify server-side first.
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
