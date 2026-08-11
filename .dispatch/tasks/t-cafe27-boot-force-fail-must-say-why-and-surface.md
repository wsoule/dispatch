---
id: t-cafe27
title: Boot force-fail must say why, and surface work the orphan completed
status: in-review
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
  - ui
priority: high
assignee: none
created: 2026-08-10T23:55:00.000Z
updated: 2026-08-11T18:06:35.054Z
external: null
writes: []
---

## Description

reconcileOnBoot (orchestrator.ts, the `appendState('failed', now)` with no extras) force-fails every non-terminal run at daemon start with NO error text, no cost, no turns. In the UI that reads as "the agent failed, $0" with zero explanation. Case study r-96f433 (Aug 4): daemon restarted 4 minutes into the run, run showed failed/$0, Wyat re-dispatched the task (duplicate run r-02a09e, then cancelled) — while the orphaned Claude process survived the restart, finished the work at 19:40, committed 51aa241 to the branch, wrote "Done, committed" into the task activity, and recorded evidence into the "failed" transcript. Board said in-progress for 6 days, run said failed, activity said done.

Two pieces:
1. Force-fail with a reason: `error: 'dispatchd restarted while this run was in flight; the agent process may still be running'` so the run detail explains itself.
2. Surface orphan work: a force-failed run whose branch gains commits after the fail timestamp (or whose transcript gains evidence entries) should be flagged in the run/review UI — "work landed on this branch after the failure" — instead of looking like a dead $0 run. The crash survey (scheduleSurvey) already runs at boot; extend what it reports.

## Acceptance Criteria

- A run force-failed by boot reconciliation carries a human-readable error naming the daemon restart.
- A force-failed run with post-fail commits on its branch is visibly distinguishable from a genuinely dead run.

## Activity
- 2026-08-11T16:50:06.186Z dispatched (claude, branch dispatch/t-cafe27-boot-force-fail-must-say-why-and-surface-d8b65c) — human:wsoule679
- 2026-08-11T16:58:38.055Z Plan: (1) reconcileOnBoot force-fail now stamps error 'dispatchd restarted while this run was in flight…' on transcript + meta. (2) RunSurvey gains postFailCommits, computed against the transcript's FIRST 'failed' state line ts (stable cutoff — meta.updatedAt moves on re-survey). Boot survey computes it; getRun kicks a 60s-cooldown re-survey so commits an orphan lands after boot are still caught. Clean tree + post-fail commits → survey stamped on the still-failed run, run.survey broadcast, task activity note. (3) UI: failure-reason + "work landed after the failure" banners in RunLogView/RunReviewView, inbox wording in runState.ts. — none
- 2026-08-11T17:27:44.046Z Done, committed as e2961904 (server+client) and 3681ca81 (desktop). Boot force-fail now stamps BOOT_FORCE_FAIL_ERROR on the transcript state line + meta; RunSurvey.postFailCommits records commits authored after the run's first 'failed' transcript ts (stable cutoff), computed at boot and via a 60s-cooldown re-survey kicked from getRun so post-boot orphan commits are caught. Clean-tree+orphan-commits runs stay 'failed' but get the survey stamped, run.survey broadcast, and a one-time Activity note (dedupe mutation-tested: 1 test fails without it; date-filter mutation also killed). UI: failure reason + green "work landed on this branch after the failure" banners in Chat + review surfaces, new inbox notice wording. Verified: survey tests 8/8, runState 42/42, tsc clean ×3, lint 0 errors, knip clean, merge-queue 70/70, full orchestrator dir 779 pass with 1 pre-existing environmental fail (claude-executor expects 'bun' but host's Dispatch.app supplies the bundled dispatch-mcp binary — reproduces with my changes stashed). — none
- 2026-08-11T17:28:04.971Z [run r-d8b65c] finished: finished — 8 files, $18.27 — agent:wsoule679/claude
- 2026-08-11T18:06:35.054Z [run r-31b683] finished: finished — 0 files, $3.51 — agent:wsoule679/claude
