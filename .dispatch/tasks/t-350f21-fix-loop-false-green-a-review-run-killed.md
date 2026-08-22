---
id: t-350f21
title: "Fix loop false green: a review run killed mid-flight settles the loop as
  complete"
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
  - fix-loop
  - resilience
priority: high
assignee: none
created: 2026-08-22T18:53:51.271Z
updated: 2026-08-22T18:53:51.271Z
external: null
writes:
  - packages/server/src/orchestrator/fixLoop.ts
  - packages/server/test/**
---

## Description

Incident 2026-08-22: fix loops for t-7cc78a and t-48a2e5 were started, their round-0 review runs were killed by a dispatchd restart (state failed, zero findings recorded), and on the next start/advance both loops settled state=complete — lastReviewedSha had been stamped when the review was DISPATCHED (fixLoop.ts:405/659), so the dead review counted as done, and settle() (fixLoop.ts:734) saw zero open findings and declared the bar cleared. Neither branch was ever actually reviewed, and complete is sticky: stop + advance-with-baseSha does not reopen (step() returns unchanged for capped/complete, fixLoop.ts:292), so there is no API path out of the false green.

Fix: a review run that terminates without completing (failed / interrupted / force-failed by reconcileOnBoot) must not count as a completed review — either clear lastReviewedSha when the review run dies, or track the review's run id and require its state=finished before settle() may treat the round as reviewed. Also give complete a reopen path (ignite or advance with explicit baseSha reopens a settled loop) so a stuck state is recoverable without hand-editing fix-loops.jsonl. Tests: kill a review run mid-round with the fake executor, assert the loop re-reviews instead of settling; assert reopen works on a complete loop.

## Acceptance Criteria

## Activity
