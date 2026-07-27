---
id: e-ddd932
title: "Review: a full-page diff review with inline comment threads"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-07-27T00:54:26.719Z
updated: 2026-07-27T00:54:26.719Z
external: null
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
