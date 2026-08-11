---
id: t-b6ba25
title: "Auto-start the fix loop: implement → review → fix → re-review by default"
status: done
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
priority: high
assignee: none
created: 2026-08-11T03:31:00.000Z
updated: 2026-08-11T18:01:51.409Z
external: null
writes: []
---

## Description

The full loop already exists server-side and self-advances once opened: `FixLoop.advance` steps idle → implementing → reviewing per round, `onRunTerminal` re-advances it whenever a run finishes, it resumes on daemon boot, caps at a round budget, and findings get adjudicated (parked/blocked) with required rulings. What's missing is the ignition: a loop only opens via `POST /api/tasks/:id/fix-loop/advance` with a `baseSha` — a manual act nobody performs, so tasks get one implement run, maybe a review agent, and then a human shuttles findings by hand.

Make the loop the default lifecycle: when an execute run finishes, open the fix loop automatically (baseSha = the commit before the task's first implementer, which the loop already tracks) instead of waiting for the API call. Config-gate it (`config.fixLoop.auto: true` default, per-task opt-out) and respect the existing round cap. The manual advance endpoint stays as the explicit entry for tasks dispatched before the change.

Reference experience: the SDD controller session of 2026-08-10 ran exactly this shape by hand — fresh implementer per task, reviewer per task, scoped re-review per fix round, adjudication with rulings at the cap — and it caught a real Important finding (question-blocked runs missing from the Inbox) that a single-pass review would have shipped. The product should do this without a human driving.

## Acceptance Criteria

- A dispatched task whose execute run finishes enters the fix loop with no API call: review agent dispatches, findings drive a fix round, the loop re-reviews, and it ends complete or capped.
- Auto-start is config-gated with a default of on, and a capped loop still demands human adjudication exactly as today.
- Tasks with the loop disabled behave exactly as before the change.

## Activity
- 2026-08-11T16:45:41.702Z dispatched (claude, branch dispatch/t-b6ba25-auto-start-the-fix-loop-implement-review-3f87e1) — human:wsoule679
- 2026-08-11T17:09:47.208Z Implementation committed (c2bb7e4c): ignition lives in FixLoop's existing onRunTerminal hook — a finished execute run with no loop opens one (baseSha = git merge-base of the run's branch and its base, i.e. the commit before the implementer) and dispatches the initial full review itself, landing the loop in 'reviewing' so the existing machinery drives fix rounds. Gates: config fixLoop.auto (new, default true) + per-task `fix-loop: false` frontmatter (new optional TaskMeta.fixLoop, absent-means-on like selfReview). Ignition joins the same per-task in-flight chain as advance() so a racing manual open can't double-dispatch. Skips quietly on empty diff (no commits), standing block, or unresolvable refs. Existing fix-loop tests now run with the task opted out (regression proof for criterion 3); new suite covers happy path to complete, config gate off, per-task opt-out, no-commit runs, and a capped auto loop demanding adjudication. Test run in progress. — none
- 2026-08-11T17:19:06.980Z [run r-3f87e1] finished: finished — 11 files, $28.74 — agent:wsoule679/claude
- 2026-08-11T18:01:51.409Z run r-3f87e1 merged into main — human:wsoule679
