---
id: t-48a2e5
title: "Decision feed: daemon aggregates everything awaiting a human"
status: done
kind: task
parent: e-6cfcc7
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:58:37.817Z
updated: 2026-08-23T00:38:22.710Z
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

- 2026-08-22T18:03:48.403Z [run r-0bd9bd] flagged interrupted-dirty: 6 uncommitted path(s) found — none
- 2026-08-22T18:07:56.563Z requested changes (run r-fe1a71): You were interrupted by a dispatchd restart (a dev build was bouncing the daemon — now resolved). Your worktree and progress are intact; the survey above lists what was uncommitted. Continue from where you left off, re-verifying anything mid-flight when you stopped. — human:wsoule679
- 2026-08-22T18:11:00.127Z Self-review found two real bugs in the inherited code, both in change detection, both now fixed test-first with mutation evidence (1 test fails on each revert).

(1) A read consumed the notification. `signature` was doing double duty as "what the feed contains now" (advanced by every recompute, including the one behind GET /api/decisions) and "what subscribers were last told". So a client polling in the window between a source write and the event it triggers moved the baseline forward, and the event then compared the new state against itself — suppressing decisions.changed for every other connected client. Split out a `broadcastSignature` that only advances when we actually broadcast.

(2) An in-place escalation reached no one. The signature was keyed on `id:state`, but an item can change materially while both hold still: orchestrator.stampOrphanWork() attaches a survey to an already-`failed` run, escalating the feed item's reason from 'failed' to 'orphan-commits' with the same id and the same 'open' state. That is precisely what run.survey is in TRIGGER_EVENTS for, and the signature could not see it. Now keyed on id+state+reason+summary — deliberately excluding since/ageMs, since age moves on every recompute and an approval whose run has gone falls back to now, so folding either in would broadcast on a loop.

Also checked and found NOT to be problems: orphaned questions/scope-requests on dead runs (index.ts onRunTerminal already closes them, which is what gives the feed its auto-resolve property); FixLoopStore.list() throwing on an unreadable store (it swallows read errors); and base-discarded outranking run state (orchestrator's own comment at the set site calls that flag "the ONLY record that a run needs human attention", confirming the ordering). — none
- 2026-08-22T18:30:35.612Z Done and committed on dispatch/t-48a2e5-...-0bd9bd: c29ec119 (the feed) and 4820d65d (the escalation fix).

Verification, stated plainly. Green: root tsc across every package (load-bearing, since ApiContext gained a required field), lint 0 errors with no suppressions added, knip clean, format:check clean, and 25/25 decision-feed tests against the final committed state. Both pre-commit hooks ran tsc + lint + format.

Not green, and I want this on the record rather than buried: the full packages/server suite does not pass in this sandbox, and I did not get it to complete — it is slow enough that I stopped it partway. Every failure I saw was in PR-review-agent, GET /api/impact, or DepMapCache, all with "timed out after 5000ms" beside environmental warnings (merge driver not on PATH, "no trunk resolvable", dangling processes, and the carto unavailability recorded nine times in this task's own hazard log). Re-running those three files in isolation still fails 4/138, which rules out parallel load as the cause. I tried to prove them pre-existing by checking out the base commit, but the permission classifier blocked it and I did not work around it — so "unrelated and environmental" is well-evidenced, not proven against a baseline. Worth a human eye if these are not already known-red locally.

One methodology note against myself: my first full-suite run reported a decision-feed failure, and that was my fault, not the code's — I was editing source while the suite ran, so it reached the file mid-mutation-test. I discarded that run and re-ran against stable committed files rather than reporting the tainted numbers.

Scope: packages/server only, all within declared writes. No packages/core (r-664ec2/r-d236d7 have it claimed) and no packages/client method — the typed client belongs to the surface task, since this one is model-layer only. — none
- 2026-08-22T18:30:59.442Z [run r-fe1a71] finished: finished — 6 files, $6.39 — agent:wsoule679/claude
- 2026-08-23T00:13:49.291Z requested changes (run r-297e7b): Code review of your branch is complete. REQUIRED fixes before merge:

1. (MEDIUM) stalledReason() in decisionFeed.ts:182-189 never resolves items for superseded runs: a failed/interrupted-dirty run that has a successor (some run with resumedFrom === its id) must NOT be flagged run-stalled — its successor carries the work. The orchestrator already guards this exact case at orchestrator.ts:1571; mirror it. Also exclude kind:'review' runs from run-stalled (the capped fix-loop item already represents that state). Add a test: dead run + resumed successor produces no stalled item.

2. (PERF) FixLoopStore.list() does readFileSync + full JSON.parse of fix-loops.jsonl on EVERY DecisionFeed.recompute(), which fires on every run.changed — i.e. per evidence/mutation recording under agent load. Cache the parsed state map in FixLoopStore, invalidated in put(); list() becomes an in-memory read.

OPTIONAL same-round cleanups (all confirmed by review, do them if quick): delete uncalled count(); simplify the unreachable oldest.done branch in pruneResolved (delete-then-set also fixes re-resolved items pruning in original insertion position); factor the 6x-duplicated ageMs clamp into one helper; reuse initGitRepo from test/orchestrator/helpers.ts instead of the local copy; reuse test/json.ts instead of the local json<T>(); reuse/extract a shared one-line truncate instead of a third copy (promptTitle, truncateReason exist). Do NOT restructure recompute into per-event builder routing — the derived-never-stored design is correct as-is. Run the package tests when done. — human:wsoule679
- 2026-08-23T00:13:51.501Z [run r-297e7b] finished: finished — 6 files, $0.00 — agent:wsoule679/claude
- 2026-08-23T00:20:01.874Z requested changes (run r-d730dc): Your previous resume finished with zero turns and made no changes — the required fixes were NOT applied. Please actually apply them now: (1) stalledReason() in decisionFeed.ts must not flag a run as run-stalled when a successor exists (any run with resumedFrom === its id) — mirror orchestrator.ts:1571 — and must exclude kind:'review' runs; add the test. (2) Cache FixLoopStore's parsed state map, invalidated in put(), so DecisionFeed.recompute() stops doing readFileSync per event. Commit your changes and run the package tests before finishing. — human:wsoule679
- 2026-08-23T00:36:52.174Z Review fixes applied — d63c96c8 (stalled-run correctness + cleanups) and 046753a4 (fix-loop store cache).

(1) stalledReason now skips a run some later run resumed from, mirroring the guard in Orchestrator.surveyAndUpgradeIfDirty, and skips review-kind runs whose dead end the capped fix-loop item already stands for. Two judgement calls worth flagging: I put the supersession check ABOVE the base-discarded check, because a successor inherits the discarded base too, so showing the corpse gives a human a row they cannot act on — that does mean supersession outranks the flag the orchestrator calls "the ONLY record that a run needs human attention", which I think is right but is a deliberate reversal worth a second opinion. And I read the kind through runKind() rather than run.kind, because types.ts says the field is absent on every run recorded before review runs existed. The successor ids are collected once per recompute rather than rescanning per candidate, which would have been quadratic. Tests added for both guards plus the base-discarded interaction; mutation-tested at 2 and 1 failures.

(2) FixLoopStore now holds its parsed map, with put() folding its own append in rather than dropping the cache. Two correctness notes: a failed read is never cached, so an unreadable store retries instead of latching its error (the boot test depends on this), and I checked first that no caller mutates a returned FixLoopState in place — they all spread — so handing out cached objects is safe. Every pre-existing test reads through a fresh instance, so none of them would have caught a cache that stopped seeing its own writes; added the one that does, mutation-tested at 1.

Optional cleanups: took the uncalled count(), the ageSince() fold, the pruneResolved simplification plus delete-then-set for re-resolved ids, and the initGitRepo/json test-helper reuse. Reusing the shared json() (which returns any) introduced two no-unsafe-return warnings, so I annotated the destinations rather than suppressing — back to the pre-existing 42 warnings, none in my files.

Declined one, with reasoning: oneLine() is not a third copy of an existing truncate. truncateReason keeps the TAIL behind an "omitted" marker and promptTitle takes the first line without collapsing whitespace; oneLine collapses all whitespace and truncates the head. Sharing one helper would change behaviour in unrelated callers, so I left it and said so in the commit body. Happy to be overruled.

Gates on the committed state: root tsc clean, lint 0 errors, knip clean, format:check clean, 67/67 across the three affected suites. Note this worktree lost its node_modules and dist partway through (something wiped them); I reinstalled and rebuilt before trusting any result. — none
- 2026-08-23T00:37:10.583Z [run r-d730dc] finished: finished — 8 files, $7.36 — agent:wsoule679/claude
- 2026-08-23T00:38:22.710Z run r-d730dc merged into epic/e-6cfcc7 — human:wsoule679
