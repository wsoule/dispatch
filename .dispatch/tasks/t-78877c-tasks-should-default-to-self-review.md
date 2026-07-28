---
id: t-78877c
title: tasks should default to self review
status: cancelled
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-07-26T19:24:11.556Z
updated: 2026-07-28T19:31:10.643Z
external: null
---

## Description



## Acceptance Criteria

## Activity
- 2026-07-26T19:24:18.664Z dispatched (claude, branch dispatch/t-78877c-tasks-should-default-to-self-review-bdf748)
- 2026-07-26T19:27:09.885Z Task had no Description/Acceptance Criteria, so scoped from the title. Interpretation: every dispatched agent should self-review its own diff before finishing, by default. Implementing as a new section in buildTaskPrompt (packages/server/src/orchestrator/prompt.ts) — the prompt every dispatched task receives — rather than a config toggle, since nothing yet needs to turn it off per-task. Rejected readings: auto-dispatching a second reviewer agent (much larger, and "self" argues against it), and defaulting the post-run review action to merge-over-PR (that is picked per-run by a human afterwards). Flagged the same to the human via message_user. Note: 5 other runs are live on this repo per run_list.
- 2026-07-26T19:30:18.155Z CORRECTION to my previous comment. This run was dispatched from a stale local `main` (b2435f4) that is 64 commits behind `origin/main` (520a08a). On the real main, the self-review feature ALREADY EXISTS — commit ba744a2 "feat: self-review task toggle" added TaskMeta.selfReview, the `self-review` frontmatter key, API validation, the task-detail rail toggle, and the conditional instruction in buildTaskPrompt. Its default is `false` (opt-in). So this task is not "build self-review", it is "flip that default to true". I have reset this run's branch onto origin/main and will make the change there; building it on the stale base would have duplicated ba744a2 and conflicted hard. NOTE FOR THE HUMAN: every run currently in flight appears to be based on the same stale local main — worth fast-forwarding it (`git branch -f main origin/main`), which will also make this run's in-app diff show only my commit instead of 64 unrelated ones.
- 2026-07-26T19:34:38.067Z [run r-bdf748] finished: finished — 193 files, $3.37
- 2026-07-26T20:16:52.148Z requested changes (run r-c55ad2): continue
- 2026-07-26T20:17:03.115Z requested changes (run r-4747b7): continue
- 2026-07-26T20:17:12.736Z requested changes (run r-b8e0a1): continue
- 2026-07-26T20:19:06.018Z requested changes (run r-41ab16): continue
- 2026-07-26T20:19:21.485Z requested changes (run r-b32419): continue
- 2026-07-26T20:19:30.070Z [run r-b8e0a1] cancelled
- 2026-07-26T20:19:32.340Z [run r-4747b7] cancelled
- 2026-07-26T20:19:34.373Z [run r-c55ad2] cancelled
- 2026-07-26T20:19:37.723Z [run r-41ab16] cancelled
- 2026-07-26T20:19:39.698Z [run r-b32419] cancelled
- 2026-07-26T21:32:08.188Z run r-bdf748 merged into main
- 2026-07-27T01:26:58.779Z run r-c55ad2 discarded
- 2026-07-27T01:26:58.937Z run r-4747b7 discarded
- 2026-07-27T01:26:59.218Z run r-b8e0a1 discarded
- 2026-07-27T01:26:59.306Z run r-41ab16 discarded
- 2026-07-27T01:26:59.398Z run r-b32419 discarded
