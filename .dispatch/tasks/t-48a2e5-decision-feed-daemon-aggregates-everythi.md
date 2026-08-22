---
id: t-48a2e5
title: "Decision feed: daemon aggregates everything awaiting a human"
status: in-progress
kind: task
parent: e-6cfcc7
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:58:37.817Z
updated: 2026-08-22T18:00:48.300Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/core/src/**
  - packages/core/test/**
---

## Description

One daemon-owned feed of items awaiting a human, each with kind, task/run reference, age, and resolution state: gates awaiting decision, agent input requests (ask_user), verify failures that exhausted the fix-loop cap, and stalled/orphaned runs. Exposed over the existing HTTP/WS channel with live updates; items resolve automatically when the underlying thing is decided or the run moves on. This is the model layer only — surfaces and delivery are separate tasks. Designed so the future policy engine's blocking-vs-recorded split slots in as the feed's filter.

## Acceptance Criteria

## Activity
- 2026-08-22T17:33:45.385Z dispatched (claude, branch dispatch/t-48a2e5-decision-feed-daemon-aggregates-everythi-66e2c7) — human:wsoule679
- 2026-08-22T17:37:39.250Z Design settled after reading the four sources. The feed will be DERIVED, not a second store: DecisionFeed recomputes from the live registries (Orchestrator.pendingApprovals(), QuestionRegistry.listOpen(), ScopeRequestRegistry.listOpen(), FixLoopStore capped states, Orchestrator.list() for stalled/orphaned runs). That gets "items resolve automatically when the underlying thing is decided" for free — a decided scope request simply stops being derived. Live updates ride the existing EventBus.subscribe() seam: one listener maps the source events (approval.requested, question.*, scope.*, fixloop.*, run.changed, run.survey) to a single `decisions.changed` broadcast, and only when the snapshot signature actually changed, so no producer site needs touching. Policy hook: each item carries a `disposition` ('blocking' | 'recorded') from an injectable classifier, and GET /api/decisions takes a disposition filter — that is the seam e-ad1978's blocking-vs-recorded split slots into. Staying inside declared writes (packages/server only, no packages/core — r-d236d7 has core claimed); the typed client method in packages/client is deliberately left to the surface task, since this one is model-layer only. — none
- 2026-08-22T17:55:26.115Z [run r-66e2c7] flagged interrupted-dirty: 6 uncommitted path(s) found — none
- 2026-08-22T17:57:11.938Z dispatched (claude, branch dispatch/t-48a2e5-decision-feed-daemon-aggregates-everythi-0bd9bd) — human:wsoule679
- 2026-08-22T18:00:48.299Z Recovered r-66e2c7's uncommitted work into this worktree (r-0bd9bd). It was further along than "early-stage": a complete derived-feed implementation (decisionFeed.ts), GET /api/decisions, the decisions.changed event, index.ts wiring, and two test files. Before reusing it I re-verified every assumption it made against the real code here rather than trusting it: QuestionRegistry.listOpen/askedAt, ScopeRequestRegistry.listOpen/requestedAt/paths/reason, FixLoopState (taskId/round/cap/state='capped'/stopReason/updatedAt) and that FixLoopStore.list() swallows read errors rather than throwing, Orchestrator.list()/pendingApprovals() field-for-field, RunMeta.baseDiscarded/archivedAt/reviewedAt/survey.postFailCommits, TaskDoc.meta.title, and that all ten names in TRIGGER_EVENTS are real ServerEvent types. All correct. Gates so far: server tsc clean, lint 0 errors (42 warnings, all pre-existing and none in these files), knip clean, 16/16 unit tests and 7/7 API tests pass. Now doing an adversarial self-review of the ported code before committing — inherited work gets the same scrutiny as written work. — none
