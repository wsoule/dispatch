---
id: t-f8fc15
title: Request-changes must close out the run it supersedes
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
priority: medium
assignee: none
created: 2026-08-12T00:32:03.154Z
updated: 2026-08-12T00:32:03.154Z
external: null
writes: []
---

## Description

Live repro 2026-08-11 (t-783b53): every request-changes resume leaves the ORIGINAL run terminal and un-reviewed forever — r-65842a (failed, resumed as r-40ae50) and r-40ae50 (finished, resumed as r-3390cd) both sat in the Inbox's Needs review while the task was already done, alongside "worktree is gone / stacked base discarded" queue-attempt noise for the same stale records. The follow-up run carries `resumedFrom`, so the linkage exists — when a follow-up run is created, the run it resumes should be closed out (reviewedAt with a 'superseded' marker, or at minimum excluded from buildReviewQueue and the merge queue's enqueue surface), and when the follow-up eventually merges, its ancestors must never resurface. Care: closing must not delete the superseded run's transcript/branch while the follow-up still shares them — the follow-up reuses the same branch/worktree.

## Acceptance Criteria

## Activity
