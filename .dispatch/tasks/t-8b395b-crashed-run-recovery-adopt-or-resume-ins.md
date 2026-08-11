---
id: t-8b395b
title: "Crashed-run recovery: adopt or resume instead of re-dispatch"
status: todo
kind: task
parent: null
milestone: null
blocked-by:
  - t-cafe27
labels:
  - orchestrator
  - ui
priority: medium
assignee: none
created: 2026-08-10T23:55:00.000Z
updated: 2026-08-11T01:42:07.714Z
external: null
writes: []
---

## Description

When a run is force-failed by a daemon restart, the only affordance today is dispatching the task again from scratch — which cuts a new branch, races the possibly-still-alive orphan process (see r-02a09e, dispatched 21s after r-96f433's force-fail, then cancelled), and leaves the original branch's work stranded. Offer real recovery on a force-failed run:

- "Resume" — the session id is persisted as soon as it's known (f2867782), so a follow-up run can resume the same Claude session in the same worktree, the way request-changes resumes finished runs (`resumedFrom`).
- "Adopt" — if the branch already has the completed work (the r-96f433 case), let the human accept it into the normal review flow: flip the run to reviewable rather than making them hand-merge and rely on the external-merge reconciler.

Re-dispatch stays available but should warn when the crashed run's worktree/branch shows recent activity — the orphan may still be alive (dispatch can't kill what it no longer owns, but it can look before racing it).

## Acceptance Criteria

- A force-failed run offers resume (same session, same worktree) when a session id was persisted.
- A force-failed run whose branch has commits offers a path into review without a hand-merge.
- Dispatching a task whose previous run was force-failed warns if that run's branch/worktree changed in the last N minutes.

## Activity
- 2026-08-11T01:42:07.714Z Live repro 2026-08-11 (r-96f433): a failed run never enters the review queue, so the app offers no Discard button for it anywhere — closing it required the CLI (`dispatch review r-96f433 discard`). Whatever surface this task adds for force-failed runs should include the discard/adopt actions, not just resume. — none
