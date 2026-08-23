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
updated: 2026-08-23T01:12:44.300Z
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
- 2026-08-23T00:08:46.473Z [run r-749444] finished: finished — 11 files, $2.51 — agent:wsoule679/claude
- 2026-08-23T00:21:45.879Z requested changes (run r-e4e7c5): Code review found gaps that recreate the two-agents-in-one-worktree hazard this feature exists to prevent. REQUIRED before merge:
1. createRun's resume branch (api.ts:569) resumes into the dead run's worktree IMMEDIATELY, with no orphan-quiescence check — a user re-dispatching seconds after a daemon restart resumes into a checkout a surviving orphan may still own, and the boot sweep then sees 'already resumed' and exits. Gate the HTTP resume on the same quiet/blockReason discipline as the sweep (or defer/409 while the sweep's quiet window is open for that run).
2. worktreeFingerprint (orchestrator.ts:198) captures only path lists + shas — an orphan rewriting already-dirty files without committing fingerprints as quiet, and a failing git status (!ok → empty arrays) reads as maximally quiet. Include content evidence (e.g. git diff hash or mtimes) and treat status failure as 'cannot tell — defer', never quiet.
3. Auto-resume never checks TASK status (orchestrator.ts:1695): the sweep can resume a run on a task the human cancelled/completed during the quiet window and flip it back to in-progress. Mirror createRun's done/cancelled 409 guard in resumeBlockReason.
4. Model consistency (api.ts:556): an explicit model differing from the resumable run's must mean fresh (same logic as executor mismatch) — the desktop ALWAYS sends model and cannot send fresh:true, so today a user's retry-on-stronger-model silently no-ops.
5. CLI --executor has a commander default of 'claude' so every plain 'dispatch run' sends a fake-explicit executor, silently breaking resume for any non-claude executor (orchestrate.ts:229). Send executor only when the user typed it (getOptionValueSource).
6. finishAutoResume must re-check resumeBlockReason after the awaited survey (a human Resume during that await creates a second successor; orchestrator.ts:1805), and the give-up note must re-check stopped/blockReason before writing (it can falsely claim 'orphan still writing' about a resumed/discarded run, orchestrator.ts:1791).
7. Internal dispatchers bypass resume entirely: epic auto-fill (epic.ts:395) and warden dispatch_task (wardenTools.ts:395) call orchestrator.dispatch directly and permanently cancel the sweep. Add a dispatchOrResume seam on the Orchestrator that all three entry points use.
OPTIONAL (confirmed): share the stalling-executor stub via test/orchestrator/helpers.ts instead of two fresh copies; import RunMeta instead of the local RunRow slice; replace the 600ms wall-clock orphan test with condition polling (repo's flaky-test history says it will flake); delay-first loop ordering to drop the dead final 30s wait. Run server tests when done, commit. — human:wsoule679
- 2026-08-23T01:12:44.300Z Review fixes committed: 26dbaaa9 (server), bc8ae165 (cli). All 7 required items plus all 4 optional ones.

1. Re-dispatch quiescence gate. `dispatchOrResume` now refuses (409, re-arming the sweep) when the run is boot-force-failed and nothing has yet watched its worktree settle. Only boot-force-failed runs owe that proof — a run that failed with its daemon alive has no orphan to race. The 409 says the run will resume on its own and points at fresh=true.
2. Evidence strengthened. `worktreeEvidence` now hashes the actual staged/unstaged diff CONTENT plus untracked size+mtime, and returns null for "cannot tell" — null never compares equal into a resume.
3. Task status. `resumeBlockReason` mirrors createRun's done/cancelled refusal (and refuses an unreadable task file).
4. Model consistency. A named model differing from the run's routes to a fresh run, same as executor. Only compared when the run's own model is known, so an older run recording none still resumes.
5. CLI sends `--executor` only when typed (getOptionValueSource); a default is not a request.
6. finishAutoResume re-checks blockReason after the awaited sample; the give-up note re-checks stopped+blockReason before claiming an orphan is still writing.
7. `dispatchOrResume` seam now used by api.ts createRun, EpicEngine auto-fill and warden dispatch_task.

Optional: stalling stub shared via test/orchestrator/helpers.ts; resilience test uses the real RunMeta; the 600ms wall-clock orphan test is now condition-polled; loop is delay-first.

Two things found while fixing, worth knowing:
- I introduced a real bug and caught it: `worktreeEvidence` ran git status + git diff concurrently, which lose the index.lock race in one worktree. That returns null = "cannot tell", so it would have quietly prevented EVERY resume. Now sequential.
- Sampling moved to strictly after each quiet window (no boot baseline). Beyond dropping the dead trailing wait, this stops boot firing a burst of git at every crashed worktree exactly when its orphan is most likely mid-commit — losing that race costs the ORPHAN a failed commit. It reproduced as a real aggregate-only failure in the pre-existing orphan-work test; aggregate now runs clean 3x.

Verification: tsc clean (server/cli/client); lint 0 errors / 42 pre-existing warnings, none in changed files; 930 pass 0 fail server, 194 cli, 67 client. Mutations: quiescence gate 3 fails, content evidence 1, task-status guard 1, null-is-not-quiet 1 (this one FIRST came back 0 — a dead guard — so I added a test that corrupts the worktree's .git file and re-ran it), finishAutoResume re-check 0 (verified as genuine defence-in-depth behind resumeRun's own liveRunForTask/reviewedAt guards, not a missing test — reported honestly rather than covered by a contrived one).

Unrelated: test/orchestrator/claude-executor.test.ts fails in an agent shell only because DISPATCH_MCP_BIN is inherited from the installed Dispatch.app; passes under `env -u DISPATCH_MCP_BIN`.

Also noticed, pre-existing and NOT changed: handleFinish's transition spreads `sessionId: finish.sessionId` over the meta, so an executor that reports a session mid-run but omits it on finish ends up with none recorded — which would make that run non-resumable. Real executors report it on finish, and boot-force-failed runs never go through handleFinish, so the incident path is unaffected. Flagging rather than touching transition's fold semantics. — none
