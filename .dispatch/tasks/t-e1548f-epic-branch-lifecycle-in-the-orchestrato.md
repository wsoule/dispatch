---
id: t-e1548f
title: Epic branch lifecycle in the orchestrator
status: in-review
kind: task
parent: e-b7ca6f
milestone: null
blocked-by: []
labels:
  - orchestrator
priority: high
assignee: none
created: 2026-08-10T23:19:42.000Z
updated: 2026-08-11T18:02:16.338Z
external: null
writes:
  - packages/server/src/orchestrator/epicBranch.ts
  - packages/server/src/orchestrator/epic.ts
  - packages/server/src/orchestrator/orchestrator.ts
  - packages/server/test/orchestrator/epic-branch.test.ts
---

## Description

Create and maintain `epic/<id>` branches: cut from the default branch on the epic's first dispatch; dispatch of any task under the epic uses it as `baseBranch` (the plumbing stacked runs already use); review()'s merge for those runs targets the epic branch instead of the main checkout's branch; keep the epic branch updated against main (surface drift rather than silently rebasing). Decide and document what happens to in-flight child runs when the epic branch moves — the merge queue's restack machinery is the likely reuse point.

## Acceptance Criteria

- Dispatching a task whose parent epic has a branch cuts the run from `epic/<id>`, and review-merge lands it there, not on main.
- An epic's branch is created lazily and visible in the UI wherever run branches are.
- Child runs restack (or flag, mirroring baseDiscarded) when the epic branch moves under them.

## Activity
- 2026-08-11T17:33:11.316Z dispatched (claude, branch dispatch/t-e1548f-epic-branch-lifecycle-in-the-orchestrato-c53f56) — none
- 2026-08-11T17:39:12.409Z Plan settled after reading the orchestrator plumbing. Design: (1) `epic/<id>` created lazily inside dispatch()/resolveBase when the task's parent is an epic — becomes the run's baseBranch; stacked dispatch on sibling blockers is unchanged (their branches are already rooted on the epic branch, and MergeQueue.restackRun already lands dependents on parent.baseBranch = the epic branch). (2) review-merge: mergeRun gains a checkout-free path for epic bases — `git merge-tree --write-tree` + commit-tree + CAS update-ref — so the user's checkout is never touched and no environment gates apply. (3) Drift/moves decision: dispatch never rewrites an epic branch; it only moves forward (sibling squashes, human merging main in), so in-flight children never need restacking — the merge queue's existing rebase-onto-base step brings each run onto the epic tip at merge time. Drift vs main is surfaced as a `behindBase` count on a new 'epic' BranchEntry status in listBranches (visible in the Git view). Cross-epic edge: a dependent whose blocker lands OUTSIDE its own epic branch is flagged baseDiscarded-style instead of silently retargeting main. deleteBranch already refuses removing a branch that is some run's base. PR action pushes the epic base branch before `gh pr create --base epic/<id>`. — none
- 2026-08-11T18:01:55.186Z Done and committed (550d2988, plus bf810d2d for pre-existing format drift in an unrelated plan doc). Epic branches are created lazily at first child dispatch, used as baseBranch, and review-merge lands runs on them via a checkout-free merge-tree/commit-tree/update-ref squash (falling back to the checkout path when the user has the epic branch checked out). Drift vs main is surfaced as behindBase on a new 'epic' branches-surface status with a chip in the Git view. Restack decision documented in docs/design/epic-branches.md: epic branches only move forward, so the queue's rebase-onto-base step covers sibling landings; stacked siblings restack onto the epic branch via existing machinery; cross-epic blockers flag the dependent baseDiscarded-style (mutation-tested). Verification: new 13-test suite green; merge-queue (70), orchestrator (95), worktree/stacked/pr/external-merge (158), epic+review-api (48), desktop helpers (19) all green; tsc clean in server/client/desktop; format+lint clean; 3 guard mutations each killed by exactly 1 test. — none
- 2026-08-11T18:02:16.338Z [run r-c53f56] finished: finished — 12 files, $29.17 — agent:wsoule679/claude
