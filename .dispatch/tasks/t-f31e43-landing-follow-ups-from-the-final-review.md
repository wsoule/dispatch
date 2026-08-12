---
id: t-f31e43
title: Landing follow-ups from the final review (non-blocking)
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - landing
priority: low
assignee: none
created: 2026-08-11T23:24:42.516Z
updated: 2026-08-11T23:24:42.516Z
external: null
writes: []
---

## Description

Deferred items from the landing-pr-table final review and integration (feature landed at ed16225e; none block anything):

- Cache the merged-PR listing off the request path: GET /api/landing calls `listMergedPrs(20)` (a live gh subprocess) per request; cache it in PrManager's poll beside the open set or memoize with a short TTL.
- groupForGate parity test: the desktop mirrors packages/server/src/landing.ts's groupForGate in lib/landingView.ts (client re-exports types only). Copies verified identical at merge; add a table-driven test asserting both produce the same group for shared fixtures so drift fails CI.
- create() marker-write orphan: prWorktree.ts create() writes the ownership marker after `git worktree add`; if the write throws, the worktree exists permanently unowned (invisible to list(), un-removable via DELETE). Wrap the write to unwind the worktree add on failure.
- Clear entry.reason when a merge-queue entry leaves a held state (waiting-github/blocked-environment) — merged history rows can carry a stale reason. Cheapest inside setEntryState for queued/merged targets.
- Comment-length trims: ~8 blocks over the 2-line house max (mergeQueue.ts:64-72, 855-865, 926-940, 1009-1017; pr.ts:206-213, 851-858; prWorktree.ts:358-371; api.ts:2158-2162).
- findRepoPr conflates "not found" with transient gh failure; the worktree-removal path should only treat an explicit not-found as confirmation (rate-limit window can delete an open PR's clean checkout — recreatable, but noisy).
- Consider folding the retired LandedView's git-branch buckets (awaiting-review/in-progress/abandoned/merged-local/merged-pushed, from lib/landedBuckets.ts at 2e942666) into the Landing table's Recently-landed section — the local-branch lens (mergedIntoBase, unpushed) is signal the GitHub-side landed list lacks.
- e2e: no sidebar/landing PNG baselines exist; regenerate in CI, never locally (repo rule).

## Acceptance Criteria

## Activity
