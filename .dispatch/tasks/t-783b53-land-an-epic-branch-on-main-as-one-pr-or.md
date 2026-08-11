---
id: t-783b53
title: Land an epic branch on main as one PR or one merge
status: in-review
kind: task
parent: e-b7ca6f
milestone: null
blocked-by:
  - t-e1548f
labels:
  - orchestrator
  - ui
priority: medium
assignee: none
created: 2026-08-10T23:19:42.000Z
updated: 2026-08-11T23:04:49.680Z
external: null
writes: []
---

## Description

A "land this epic" action once its tasks are done: open one PR from `epic/<id>` to main via the PrManager path (push, `gh pr create`, poll to merged — reusing the existing poller), or do a local merge when there is no remote. Landing closes out the epic the way review-merge closes out a run: epic status flips, the branch is cleaned up, and the epic's diff snapshot is preserved for the review surface. Blocked-by the lifecycle task since there is nothing to land until child runs merge into the epic branch.

## Acceptance Criteria

- One action takes a finished epic branch to main (PR when the project has the pr capability, local merge otherwise) and marks the epic done.
- Partially-done epics refuse to land with a clear message rather than landing half an epic silently.

## Activity
- 2026-08-11T18:02:20.429Z dispatched (claude, branch dispatch/t-783b53-land-an-epic-branch-on-main-as-one-pr-or-65842a) — none
- 2026-08-11T18:11:18.514Z Plan settled after reading the epic-branch lifecycle commit (550d2988): POST /api/epics/:id/land is the one action. Orchestrator gains epicLandStatus (validation: kind/status/branch-exists/all-children-done-or-cancelled/no unreviewed runs on the branch), landEpicLocally (true --no-ff merge into the default base — checkout path with mergeRun's gates when the base is checked out, checkout-free merge-tree/commit-tree/update-ref plumbing otherwise), epicDiff + snapshot at diffSnapshotPath(rootDir, epicId), markEpicMergedViaPr. PrManager gains openEpicPr (push epic branch, gh pr create --base <default>) with a persisted epic-prs.json ledger the existing pollOnce also walks, so a daemon restart keeps polling. API picks PR vs local merge off prCapability. Client landEpic/fetchEpicDiff + a Land button on EpicCardTile when all children are done. — none
- 2026-08-11T18:14:06.802Z [run r-65842a] finished: failed — 0 files, $11.58 — agent:wsoule679/claude
- 2026-08-11T21:01:02.672Z requested changes (run r-40ae50): Continue where you left off. Re-read the task and your own transcript above first, then pick up from the last thing you were doing. — human:wsoule679
- 2026-08-11T21:30:05.690Z Done, committed as f917f38e (clean tree). POST /api/epics/:id/land is the one action: Orchestrator.epicLandStatus gates both paths (all children done/cancelled or 409 naming the pending ones; no unreviewed run based on the branch; default base must exist locally — the last two guards found in self-review). PR path: PrManager.openEpicPr pushes epic/<id> + gh pr create --base <default>, persisted epic-prs.json ledger, existing pollOnce flips the epic done via markEpicMergedViaPr on MERGED and reopens landability on CLOSED. Local path: landEpicLocally does one --no-ff two-parent merge (gated checkout merge or checkout-free plumbing), snapshots the diff (GET /api/epics/:id/diff serves it after branch deletion), deletes epic/<id>, flips status done. Client landEpic/fetchEpicDiff; desktop EpicCardTile shows Land when all children finish. Verified: 14 new tests green, 181 neighboring server tests green, 1225 desktop tests green, tsc x3 clean, oxlint 0 errors, knip clean. Three guards mutation-tested (3/1/1 tests fail with each reverted). — none
- 2026-08-11T21:30:24.711Z [run r-40ae50] finished: finished — 0 files, $35.58 — agent:wsoule679/claude
- 2026-08-11T21:30:35.961Z merge queue: run r-40ae50 restack onto main failed: git rebase --onto failed: CONFLICT (modify/delete): apps/desktop/src/components/tasks/EpicCardTile.tsx deleted in HEAD and modified in f917f38e (feat: land a finished epic branch on main as one PR or one merge).  Version f917f38e (feat: land a finished epic branch on main as one PR or one merge) of apps/desktop/src/components/tasks/EpicCardTile.tsx left in tree.
Auto-merging apps/desktop/src/components/tasks/TaskBoard.tsx
CONFLICT (content): Merge conflict in apps/desktop/src/components/tasks/TaskBoard.tsx
Auto-merging apps/desktop/src/hooks/useDispatchProject.ts
Auto-merging apps/desktop/src/views/BoardView.tsx
Auto-merging packages/client/src/api.ts
Auto-merging packages/server/src/api.ts
Auto-merging packages/server/src/orchestrator/orchestrator.ts | Rebasing (1/2)Rebasing (2/2)error: could not apply f917f38e... feat: land a finished epic branch on main as one PR or one merge
hint: Resolve all conflicts manually, mark them as resolved with
hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
hint: You can instead skip this commit: run "git rebase --skip".
hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
hint: Disable this message with "git config set advice.mergeConflict false"
Could not apply f917f38e... # feat: land a finished epic branch on main as one PR or one merge — none
- 2026-08-11T21:32:23.577Z requested changes (run r-3390cd): Your branch no longer restacks onto main: the unified-kanban work (landed while you ran) DELETED apps/desktop/src/components/tasks/EpicCardTile.tsx — epics are now expandable lane headers rendered by TaskBoard.tsx, not draggable cards. Rebase your branch onto current origin/main yourself (resolve the modify/delete by dropping your EpicCardTile edits) and port your land-epic affordance to the epic lane header in TaskBoard.tsx, matching its existing header controls (Work/Stop/DAG buttons). Re-run the tests covering your changes plus the TaskBoard tests, tsc, and root lint before finishing. — human:wsoule679
- 2026-08-11T23:04:21.132Z Rebased onto current origin/main after the unified-kanban work deleted EpicCardTile. Squashed my wip+feature commits into one and replayed only that onto main (the epic-lifecycle base commit landed separately as f03260c6). Resolutions: dropped my EpicCardTile edits (file deleted upstream), took main's TaskBoard rendering and ported the Land affordance to EpicLaneHeader instead — same landable rule (all children done/cancelled, epic not done), Land replaces Work in the header's hover controls, onLandEpic now optional on TaskBoard matching its onDispatch convention. Added 2 TaskBoard tests for the button. Also fixed a pre-existing main breakage the rebase surfaced: client BranchEntry had a duplicate behindBase field from two concurrently-landed runs (failed tsgo); collapsed into one field mirroring the server's merged doc — separate commit 87edc9c7. Branch is now 991ba399 + 87edc9c7 on origin/main, clean tree. Verified post-rebase: server epic-land+epic-branch+pr+merge-queue 195 pass, TaskBoard suite 12 pass, full desktop 1304 pass, tsc x3 clean, lint 0 errors. — none
- 2026-08-11T23:04:38.529Z [run r-3390cd] finished: finished — 0 files, $31.79 — agent:wsoule679/claude
- 2026-08-11T23:04:49.680Z merge queue: run r-3390cd restack onto main failed: git rebase --onto failed: merged .merge_file_BnVz5F
merged .merge_file_K7UGF8
Auto-merging .dispatch/tasks/t-716d89-the-ui-for-the-kanban-needs-to-be-a-bit.md
CONFLICT (content): Merge conflict in .dispatch/tasks/t-716d89-the-ui-for-the-kanban-needs-to-be-a-bit.md | warning: skipped previously applied commit 3a393036
hint: use --reapply-cherry-picks to include skipped commits
hint: Disable this message with "git config set advice.skippedCherryPicks false"
Rebasing (1/56)dropping d05c72d7a055b34d25b0c615bd122edb89f11ce3 chore(board): sync 1 task -- patch contents already upstream
Rebasing (2/56)dropping 49ecddcff0a90dca61663c0b4fd9f153e461f76b chore(board): sync 1 task -- patch contents already upstream
Rebasing (3/56)error: conflict merging .merge_file_xHkVVC — resolve manually
error: could not apply d6235cc5... chore(board): sync 1 task
hint: Resolve all conflicts manually, mark them as resolved with
hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
hint: You can instead skip this commit: run "git rebase --skip".
hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
hint: Disable this message with "git config set advice.mergeConflict false"
Could not apply d6235cc5... # chore(board): sync 1 task — none
