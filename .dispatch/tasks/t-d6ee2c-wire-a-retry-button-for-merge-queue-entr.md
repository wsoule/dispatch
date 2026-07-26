---
id: t-d6ee2c
title: Wire a Retry button for merge-queue entries blocked on the checkout
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-07-26T21:45:53.580Z
updated: 2026-07-26T21:45:53.580Z
external: null
---

## Description

The merge queue now holds an entry in 'blocked-environment' instead of failing it out to history when the main checkout is not mergeable-into (dirty working tree, staged index, or the wrong branch checked out). The entry stays in line carrying a reason that names the offending paths, and MergeQueue.recheck() retries it against the current checkout.

The backend and client are done: POST /api/merge-queue/recheck is routed in packages/server/src/api.ts and exposed as client.recheckMergeQueue() in packages/client/src/api.ts. Nothing in the desktop UI calls it yet.

Today a blocked entry only clears on the next enqueue, the next run review, or a daemon restart -- so after committing the offending file the user has no way to say 'try again now'.

Acceptance criteria:
- A blocked-environment entry shows a Retry action in the merge-queue panel (PullRequestsView) and wherever QueueMergeControl renders that state.
- The action calls client.recheckMergeQueue() and invalidates the merge-queue query so the panel reflects the outcome.
- The entry's reason (which names the dirty paths) stays visible next to the action.
- Disabled or hidden while an entry is mid-flight (rebasing/verifying/merging).

## Acceptance Criteria

## Activity
