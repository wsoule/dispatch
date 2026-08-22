---
id: t-06e1b0
title: "v0 scoring: urgency, unblocking value, and age against the current store"
status: in-progress
kind: task
parent: e-ba8bf1
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:58:15.804Z
updated: 2026-08-22T18:52:06.817Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/server/src/**
  - packages/server/test/**
---

## Description

From the 2026-08-22 audit: the full weight function waits on the storage spine and hierarchy (~9 tasks of infrastructure before any planning payoff), but the scoring function is pure and backend-agnostic by design, and three of its factors already exist in today's store — task urgency/priority, unblocking value (blockedBy graph), and age. Ship the scoring core now over just those factors, with tunable weights and the per-factor breakdown, ordering ready (unblocked, todo) tasks via the existing daemon. The full scoring-service task upgrades this in place by adding project rank, initiative rank, and due-date proximity when the hierarchy lands — same function, more factors. Starts weight tuning on real work months earlier.

## Acceptance Criteria

## Activity
- 2026-08-22T17:33:47.232Z dispatched (claude, branch dispatch/t-06e1b0-v0-scoring-urgency-unblocking-value-and-167969) — human:wsoule679
- 2026-08-22T17:36:53.613Z Starting. Plan: (1) new pure `packages/core/src/scoring.ts` — browser-safe, `now` injected, factor-table shape (urgency / unblocking / age) so the v1 task adds project rank, initiative rank, and due-date proximity by appending rows rather than rewriting; each factor returns a normalized 0..1 value + a `detail` string, total = sum(value*weight). (2) `queue.weights` config block in configTypes/config with defaults + ConfigPatch support, so the queue-view task can tune weights from Settings without touching core. (3) `GET /api/queue` in a new `packages/server/src/api/queue.ts` (one route registration in api.ts) returning ranked ready tasks with per-factor breakdowns — on-demand like /api/landing, with the existing `task.changed`/`config.changed` WS events as the refetch signal. Keeping the footprint small in server/src and core/src since r-66e2c7 and r-d236d7 are live on the same globs. — none
- 2026-08-22T17:57:12.755Z dispatched (claude, branch dispatch/t-06e1b0-v0-scoring-urgency-unblocking-value-and-ece301) — human:wsoule679
- 2026-08-22T18:02:45.311Z Scoring core landed: packages/core/src/scoring.ts + test/scoring.test.ts (17 pass). Shape: private FACTORS table of {key,label,describes,read(task,ctx)} rows -> the v1 task appends `project`/`initiative`/`dueDate` rows and a ScoringContext field rather than rewriting. Each factor returns a normalized 0..1 value + a `detail` string; score is the weighted *mean* (sum(value*weight)/sum(weights)) so it always reads 0..1 regardless of weight scale and per-factor `contribution` sums back to it. Urgency derives from PRIORITY_ORDER (urgent 1.0 -> none 0). Unblocking counts *transitive* live dependents via a reversed-blockedBy walk with a seen-set (cycle-safe, diamond-deduped), curved as n/(n+3) so it never depends on batch composition. Age ramps linearly to a 30d horizon then pins. `now` injected, no node:* imports. Next: queue.weights config block, then GET /api/queue. — none

- 2026-08-22T18:03:48.489Z [run r-ece301] flagged interrupted-dirty: 6 uncommitted path(s) found — none
- 2026-08-22T18:08:01.592Z requested changes (run r-4c6efa): You were interrupted by a dispatchd restart (a dev build was bouncing the daemon — now resolved). Your worktree and progress are intact; the survey above lists what was uncommitted. Continue from where you left off, re-verifying anything mid-flight when you stopped. — human:wsoule679
- 2026-08-22T18:51:35.160Z [run r-4c6efa] flagged interrupted-dirty: 11 uncommitted path(s) found — none
- 2026-08-22T18:52:06.817Z requested changes (run r-ac26a4): Interrupted by another dispatchd restart; worktree intact, continue from where you left off. — human:wsoule679
