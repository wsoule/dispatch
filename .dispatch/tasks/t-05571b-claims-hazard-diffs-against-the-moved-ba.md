---
id: t-05571b
title: Claims hazard diffs against the moved base tip, not the merge base
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
priority: high
assignee: none
created: 2026-08-12T00:40:44.635Z
updated: 2026-08-12T00:40:44.635Z
external: null
writes: []
---

## Description

Live repro 2026-08-11/12: r-403c41 (t-57d72c) drew a "changed 59 files outside its declared writes" hazard while `git diff $(git merge-base origin/main <branch>)..<branch>` shows exactly 6 changed files, all inside its declared writes globs. The undeclared-writes check is diffing the run branch against its baseBranch's CURRENT tip (or ran mid-restack), so every commit main gained after the branch was cut counts as the run's own changes — on a busy day that's 50+ phantom files, drowning the one real signal the hazard exists for (see the earlier 20-file .dispatch variant, whose exemption fixed only the bookkeeping subset). Fix: compute the changed-file set for claims/undeclared-writes findings against merge-base(baseBranch, branch), the same three-dot semantics diffCommittedOnly already uses for review diffs; add a regression test where the base advances after branch creation and the hazard set stays empty. Then re-adjudicate or auto-retire the phantom findings this produced (t-57d72c's 59-file and t-f6ab79's 2-file entries need rechecking under correct semantics).

## Acceptance Criteria

## Activity
