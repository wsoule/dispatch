---
id: t-050819
title: "Daemon restart must not lose in-flight runs: auto-resume on boot and on
  re-dispatch"
status: in-progress
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
  - resilience
priority: high
assignee: none
created: 2026-08-22T18:01:32.916Z
updated: 2026-08-23T00:08:25.954Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
  - packages/cli/src/**
  - packages/client/src/**
---

## Description

Incident 2026-08-22: dispatchd restarted while three runs were in flight; all were force-failed by reconcileOnBoot (orchestrator.ts:3023) and one nearly-complete run (r-d236d7, session and worktree fully intact) was lost — re-dispatching its task via `dispatch run` spawned a FRESH run and the work had to be salvaged by hand-messaging the new agent.

All the machinery already exists: resumeRun (orchestrator.ts:3827) resumes with the same worktree, branch, sessionId, model, and claims — but its only caller is the human pressing Resume in the UI. Close three gaps:

1. reconcileOnBoot: after the existing survey settles, a force-failed run that is resumable — unreviewed, has a sessionId, worktree present, not already resumed — is auto-resumed through the resumeRun path instead of left dead. HAZARD: the orphaned agent process can survive the restart and keep committing (see stampOrphanWork, orchestrator.ts:1602) — never auto-resume while the orphan is provably alive or the branch is still gaining post-fail commits; defer and retry rather than fight the orphan for the worktree.
2. `dispatch run <taskId>`: when the task's most recent run is failed/interrupted-dirty, unreviewed, and resumable, resume it (resumedFrom chain) instead of spawning fresh; add --fresh to force a new run.
3. Expose resume directly: `dispatch run resume <runId>` calling the same daemon endpoint the UI uses.

Tests: extend packages/server/test/resilience.test.ts — restart mid-run with a fake executor, assert the run continues via a resumedFrom successor in the same worktree with no work lost; assert the orphan-alive case defers. Keep api.ts surface changes minimal — a live run currently claims that file.

## Acceptance Criteria

## Activity
- 2026-08-22T18:01:41.464Z dispatched (claude, branch dispatch/t-050819-daemon-restart-must-not-lose-in-flight-r-5d4d11) — human:wsoule679
- 2026-08-22T18:08:02.420Z requested changes (run r-a8ff69): You were interrupted by a dispatchd restart (a dev build was bouncing the daemon — now resolved). Your worktree and progress are intact; the survey above lists what was uncommitted. Continue from where you left off, re-verifying anything mid-flight when you stopped. — human:wsoule679
- 2026-08-22T18:51:35.231Z [run r-a8ff69] flagged interrupted-dirty: 11 uncommitted path(s) found — none
- 2026-08-22T18:52:07.109Z requested changes (run r-8e265e): Interrupted by another dispatchd restart; worktree intact, continue from where you left off. — human:wsoule679
- 2026-08-22T18:59:03.730Z [run r-8e265e] finished: failed — 0 files, $3.58 — agent:wsoule679/claude
- 2026-08-23T00:07:51.411Z requested changes (run r-749444): The Claude API errored mid-run (usage limit, now reset). Your worktree is intact — continue from where you left off. — human:wsoule679
- 2026-08-23T00:08:25.954Z Shipped in 2 commits on this branch (142615ed server, 8b0a9799 cli). All three gaps closed.

(1) reconcileOnBoot auto-resume. New `autoResumeAfterBoot` runs per force-failed run after its boot survey settles, and goes through the existing `resumeRun` path. Orphan hazard: nothing holds a handle on the surviving agent (the Agent SDK spawns its CLI child internally — there is no pid to probe), so liveness is inferred from the worktree. `worktreeFingerprint` covers branch head + post-fail commit shas + staged/unstaged/untracked; only two identical samples a quiet window apart (AUTO_RESUME_QUIET_MS, 30s) let a resume through. Anything else defers to the next attempt, up to 20, then leaves the run failed-and-resumable-by-hand with a note on the task.

(2) `dispatch run <taskId>` resumes instead of spawning fresh, via a new shared `resumeBlockReason` predicate (state failed/interrupted-dirty, execute kind, unreviewed, no open PR, base not flagged, has a sessionId, worktree present, not already resumed, no live run). `--fresh` opts out.

(3) `dispatch run resume <runId>` added, hitting the same endpoint the UI's Resume button uses.

Two decisions worth flagging for review:
- Resume-by-default is at the ENDPOINT, not just the CLI, so the desktop Dispatch button gets it too. Rationale: losing a nearly-finished run is unrecoverable-by-accident, while resuming when you wanted fresh costs one discard. An explicitly-requested executor that differs from the failed run's still routes to a fresh run; `model` does not (a resume keeps its own model deliberately — documented in api.ts).
- Added `Orchestrator.shutdown()`, called from ServerHandle.stop(). The sweep sleeps for minutes and ends by STARTING an agent; without this it could spawn a run into a daemon that had already gone away.

api.ts surface change kept to ~15 lines (a `fresh` boolean + the resume branch), per the note about a live run claiming that file.

Verification: server tsc clean; lint 0 errors (42 warnings, all pre-existing, none in changed files); 898 pass server (orchestrator + runs-api + api, incl. 5 new resilience.test.ts cases and 5 new survey.test.ts cases), 194 cli, 67 client, 0 fail. Three guards mutation-tested: quiescence gate -> 2 fails, `fresh` type check -> 1 fail, shutdown checks -> 1 fail. — none
