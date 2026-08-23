---
id: t-06e1b0
title: "v0 scoring: urgency, unblocking value, and age against the current store"
status: in-review
kind: task
parent: e-ba8bf1
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:58:15.804Z
updated: 2026-08-23T00:08:34.670Z
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
- 2026-08-22T18:58:16.527Z [run r-ac26a4] finished: failed — 0 files, $4.24 — agent:wsoule679/claude
- 2026-08-23T00:07:50.710Z requested changes (run r-df588b): The Claude API errored mid-run (usage limit, now reset). Your worktree is intact — continue from where you left off. — human:wsoule679
- 2026-08-23T00:08:18.624Z Done — 1448ec3c (core scoring + queue.weights config) and a16f36fd (GET /api/queue). Verified: core 434 pass / 0 fail; server queue+api+cache+config 62 pass / 0 fail; root build, lint (0 errors), knip, tsc all clean. Guards mutation-tested (3/1/21-by-hang/1 failures).

BLOCKER for follow-up — `DispatchConfig.queue` is optional in the type when it should be required. Adding it as required breaks `apps/desktop/src/components/settings/fixtures.test-helper.ts`, the only other full-DispatchConfig object literal in the repo (TS2741), which fails both `bun run build` and `bun run tsc` in CI. I filed a request_scope for that one file; it went undecided and returned denied, so I could not touch it. Mitigation: `queue?: QueueConfig` with `queueWeights(config)` in configTypes.ts as the single reader of the fallback — loadConfig always populates the block, so no runtime path relies on the default. To finish properly: add `queue: DEFAULT_QUEUE` (already exported from @dispatch/core/browser) to that fixture, drop the `?`, and inline queueWeights. That fixture's own doc comment says it mirrors config.test.ts's "returns defaults when file missing" case, which I did update — so it is currently stale relative to its stated contract.

Two other notes for whoever picks up the queue view: (1) the response carries the factor table (key/label/describes) alongside the weights, so the breakdown columns and weight controls should read from it rather than hardcoding the three factors — that is what makes the v1 project/initiative/due-date factors show up for free. (2) The QueueSnapshot response interface is deliberately un-exported in packages/server/src/api/queue.ts because knip gates unused exports at zero; export it when the client wrapper lands. — none
- 2026-08-23T00:08:34.670Z [run r-df588b] finished: finished — 11 files, $2.14 — agent:wsoule679/claude
