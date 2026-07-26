# Spec: Stacked dispatch — dependents start at `in-review` and branch off their blocker

Date: 2026-07-26 Status: approved by Wyat (brainstorming session)

Fixes a reported bug with two halves that are really one problem:

1. A blocked task never auto-starts when its blocker finishes — the human has to
   remove the `blockedBy` edge by hand.
2. A task blocked by another task branches off the default base branch, so it
   never sees the work it depends on.

Builds on the dependency primitives (`blockedBy`, `readyTasks`, `computeStack`)
and the merge queue introduced in
`.agents/ignore/specs/2026-07-22-logo-merge-queue-stacked-ui.md`.

---

## 1. Root cause

`readyTasks()` (`packages/core/src/graph.ts:21`) gates a dependent on
`isDone(blocker)`, and `isDone` (`graph.ts:13`) is
`status === 'done' || 'cancelled'`. A run that finishes only moves its task to
`in-review` (`orchestrator.ts:1150`); `done` arrives only after a human review
action (`orchestrator.ts:614`, `:727`). A dependent therefore stays unready
through the entire review window. `EpicEngine.fillQueue` (`epic.ts:247`) is the
only auto-dispatch loop in the system and filters through that same predicate.

Separately, `Orchestrator.dispatch()` unconditionally calls
`defaultBaseBranch()` (`orchestrator.ts:177`). Nothing in provisioning knows
what a blocker is.

These are one bug. Loosening readiness _without_ stacked branching would be
strictly worse than today: the dependent would branch off `main`, never see the
blocker's unmerged work, and duplicate or conflict with it. The `done` gate is
currently the only thing making flat branching safe.

## 2. Spike findings (evidence for the design)

Run against jj 0.43.0. Reproduction scripts kept at
`.agents/ignore/spikes/jj-spike{,2,3}.sh` (gitignored scratch — re-run them
before revisiting any conclusion below, since jj moves fast).

**Secondary jj workspaces cannot host an agent.** `jj workspace add` produces a
directory containing only `.jj` — no `.git`. Inside one, `git status`,
`git diff`, and `git log` all fail with `fatal: not a git repository`.
`jj git colocation enable` refuses: _"This command cannot be used in a non-main
Jujutsu workspace."_ Colocation is a main-workspace-only property in 0.43. This
rules out replacing `git worktree add` with `jj workspace add`, because the
agent, `autoCommitIfDirty` (`orchestrator.ts:944`), `WorktreeManager.diff`, and
`gh pr create` all require a real git repo in cwd.

**Git worktrees inside a colocated jj repo work, and keep jj's benefits:**

| Behavior                                                             | Result                                      |
| -------------------------------------------------------------------- | ------------------------------------------- |
| Full `git` in a `git worktree` of a colocated repo                   | works                                       |
| jj imports the agent's plain-`git` commits                           | works; bookmark tracks the branch           |
| Dependent worktree branched off blocker's branch sees blocker's work | works                                       |
| `jj rebase -b A -d main` after main moved                            | `Rebased 2 commits` — A _and_ dependent B   |
| Dependent's branch ref after restack                                 | moved automatically; contains new base work |
| Multi-parent base (`jj workspace add -r A -r C`)                     | sees both blockers' files                   |

**One wrinkle:** a restack leaves affected worktrees in detached HEAD at their
old commits (git will not move a branch checked out elsewhere). A single
`git checkout <branch>` resyncs cleanly — verified: clean tree, correct content.
This is a useful safety property, not just a cost: jj can never silently rewrite
a working copy an agent is actively editing.

## 3. Design decisions

| Decision                    | Choice                                  | Rationale                                                                        |
| --------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Scope of loosened readiness | Dispatch only                           | `readyTasks` keeps its `done` meaning for CLI, MCP, board badges, merge ordering |
| VCS backend                 | jj graph + git worktrees                | jj's value is the commit graph, not the working copy                             |
| Non-jj projects             | Auto-colocate on first stacked dispatch | Accepted by Wyat with the invasiveness flagged; reversible, logged to Activity   |
| 2+ unmerged blockers        | jj merge-base commit                    | `jj new -r A -r B` gives a real multi-parent base                                |
| Blocker's run discarded     | Flag the dependent, change nothing      | Never destroy agent work automatically                                           |

## 4. Components

### 4.1 Dispatch readiness — `packages/core/src/graph.ts`

`readyTasks()` is **untouched**. Two new exports:

- `isSatisfiedForDispatch(t)` → `isDone(t) || t.meta.status === 'in-review'`
- `dispatchableTasks(tasks)` → same filter/sort shape as `readyTasks`, using the
  looser predicate

`'in-review'` is hardcoded, consistent with `isDone` hardcoding
`'done'`/`'cancelled'`, even though `.dispatch/config.yml` `statuses` allows
custom status names.

`EpicEngine.fillQueue` (`epic.ts:247`) switches to `dispatchableTasks`.
`onRunReviewed`'s discard early-return (`epic.ts:206`) is unchanged.

**No new event seam is needed.** `handleFinish` sets `in-review` and rebuilds
the cache (`orchestrator.ts:1150-1152`) _before_ firing terminal hooks
(`:1154`), so `EpicEngine.onRunTerminal` already fires at exactly the moment a
blocker becomes dispatch-satisfying, against a fresh cache.

### 4.2 jj seam — `packages/server/src/orchestrator/jj.ts` (new)

`JjManager`, mirroring `WorktreeManager`'s shape, shelling `jj` through the same
injectable `CommandRunner` seam `pr.ts` and `mergeQueue.ts` use so it is
testable with a fake runner.

| Method                         | Command                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `isAvailable()`                | `jj --version`                                                                               |
| `isColocated()`                | `jj git colocation status`                                                                   |
| `ensureColocated()`            | `jj git init --colocate`, or `jj git colocation enable` on an existing non-colocated jj repo |
| `importGit()` / `exportGit()`  | `jj git import` / `jj git export`                                                            |
| `restack(branch, onto)`        | `jj rebase -b <branch> -d <onto>` then export                                                |
| `mergeBase(parents, bookmark)` | `jj new -r A -r B …` then `jj bookmark create`                                               |

`ensureColocated()` runs lazily on the **first stacked dispatch only** — never
on an unblocked dispatch — is idempotent, and appends a task Activity line
recording the conversion so it is never silent.

### 4.3 Base selection — `Orchestrator.dispatch`

Replaces the unconditional `defaultBaseBranch()` at `orchestrator.ts:177` with a
`resolveBase(task)` step. Unmerged blockers are those `blockedBy` ids that exist
in the cache and sit at `in-review` (an `in-progress` blocker cannot be a base,
and a task with one is not dispatchable anyway).

- **0** → `defaultBaseBranch()`. Today's behavior byte for byte, no jj involved.
- **1** → that blocker's branch, from its most recent terminal unreviewed run in
  the registry.
- **2+** → `jj new -r A -r B …`, bookmarked `dispatch/stack-base-<taskId>`.

`RunMeta` gains `stackParents?: string[]` (blocker branches) and
`baseDiscarded?: true` (§4.5). `baseBranch` holds the resolved ref, so three
existing consumers become stack-aware without knowing stacks exist: the run's
diff base (`orchestrator.ts:456`), the merge-queue rebase target
(`mergeQueue.ts:446`), and `gh pr create --base` (`pr.ts:279`) — a dependent's
PR opens against its blocker's branch, a genuine stacked PR.

### 4.4 Merge-queue restack — `mergeQueue.ts`

The part that makes stacking safe, and the reason jj is here.

- `rebase()` (`:428`) uses `jj rebase -b <branch> -d <base>` on colocated repos
  instead of `git rebase`. **Critical:** a plain `git rebase` writes new commits
  that jj reads as divergence, so descendants do _not_ follow. Only the jj path
  restacks dependents.
- After an entry merges, dependents whose `baseBranch` was that blocker's branch
  are repointed to the real base branch and their worktrees resynced via a new
  `WorktreeManager.resyncToBranch(path, branch)` → `git checkout <branch>`,
  since jj leaves them detached.
- **Guard:** resync only ever touches runs in a terminal state. A live agent's
  worktree is never touched.
- Eligibility ordering (`:376`) stays `isDone`-gated and unchanged, so a
  dependent can never land before its blocker.

### 4.5 Discard handling

When a run is discarded, dependents stacked on its branch get
`RunMeta.baseDiscarded = true`. The UI surfaces it; the merge queue refuses such
an entry with that reason. Nothing is rewritten or deleted — the human decides.

## 5. Failure modes

| Situation                                        | Behavior                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `jj` not installed                               | Stacked dispatch unavailable; dependent waits for `done` as today. Surfaced in the UI, not a crash.                        |
| `jj git init --colocate` fails                   | Dispatch of that task fails with the jj error; unblocked dispatch is unaffected.                                           |
| Restack hits a conflict                          | jj records the conflict in the commit rather than aborting; the entry fails with a reason and the worktree is left usable. |
| Daemon restarts mid-stack                        | No new state to recover: `baseBranch`/`stackParents` live in `RunMeta`, already persisted to the transcript header.        |
| Blocker's run vanishes before dependent dispatch | Falls back to `defaultBaseBranch()` — the blocker's work is presumed merged or gone.                                       |

## 6. Testing

- `packages/core/test/graph.test.ts` — `dispatchableTasks` unit tests, plus a
  regression test asserting `readyTasks` still gates on `done`/`cancelled`.
- `packages/server/test/orchestrator/epic.test.ts` — a child with an `in-review`
  blocker dispatches; with an `in-progress` blocker it does not.
- New server test against a **real temp jj-colocated repo** (the repo already
  asserts real git effects): base selection for 0/1/2 blockers, and a
  merge-queue restack asserting the dependent's branch moved and its worktree
  resynced to it.
- Explicit test that `rebase()` takes the jj path on a colocated repo. Silent
  fallback to `git rebase` would look correct until the first blocker merged,
  then dependents would conflict against their own already-squashed commits.

## 7. Out of scope

- Replacing `git worktree` with `jj workspace` (ruled out by the spike).
- Restacking dependents of a run that is still live.
- A DAG view of stacks — still deferred, as in the 2026-07-22 spec.
- Changing `readyTasks` semantics for CLI, MCP, or board surfaces.
