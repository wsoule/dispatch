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

| Decision                    | Choice                                         | Rationale                                                                        |
| --------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Scope of loosened readiness | Dispatch only                                  | `readyTasks` keeps its `done` meaning for CLI, MCP, board badges, merge ordering |
| VCS backend                 | jj graph when available + git worktrees always | jj's value is the commit graph, not the working copy                             |
| Non-jj projects             | Auto-colocate on first stacked dispatch        | Accepted by Wyat with the invasiveness flagged; reversible, logged to Activity   |
| 2+ unmerged blockers        | jj merge-base commit                           | `jj new -r A -r B` gives a real multi-parent base                                |
| Blocker's run discarded     | Flag the dependent, change nothing             | Never destroy agent work automatically                                           |
| jj missing or failing       | Plain-git fallback (§4.6)                      | Stacking works on every repo; jj is an optimization, not a hard requirement      |
| Before any restack          | Backup ref of the pre-restack tip (§4.6)       | Agent work stays recoverable — the undo path, not the rebase boundary            |
| Rebase boundary             | `RunMeta.stackBaseCommit`, set at dispatch     | The one fact both restack paths need: where the dependent's own commits begin    |

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

| Method                            | Command                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `isAvailable()`                   | `jj --version`                                                                               |
| `isColocated()`                   | `jj git colocation status`                                                                   |
| `ensureColocated()`               | `jj git init --colocate`, or `jj git colocation enable` on an existing non-colocated jj repo |
| `importGit()` / `exportGit()`     | `jj git import` / `jj git export`                                                            |
| `restack(branch, onto)`           | `jj rebase -b <branch> -d <onto>` then export                                                |
| `restackOnto(branch, base, onto)` | `jj rebase -s roots(<base>..<branch>) -d <onto> --skip-emptied` — the post-merge form        |
| `mergeBase(parents, bookmark)`    | `jj new -r A -r B …` then `jj bookmark create`                                               |

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
  restacks dependents — the git fallback (§4.6) restacks them explicitly.
- Every restack writes a backup ref first (§4.6), before anything is rewritten.
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

### 4.6 Fallback and backups

Two independent safety nets. Neither is optional, and neither depends on the
other working.

**Backup ref before every restack.** Before a restack rewrites any branch, its
current tip is saved as `refs/dispatch/backup/<branch>/<runId>`. Refs are free,
they are invisible to `git branch`, and they make the riskiest path in the
system non-destructive: any restack — jj or git, clean or badly
conflict-resolved — can be undone with
`git update-ref refs/heads/<branch> <backup>`. Backups are pruned when a run's
worktree is removed, alongside the existing branch cleanup in
`WorktreeManager.remove` (`worktree.ts:118`).

**Plain-git fallback.** jj is an optimization, not a requirement. The system
degrades in this order, deciding once per operation and recording which path it
took in the run's Activity:

| Condition                           | Behavior                                              |
| ----------------------------------- | ----------------------------------------------------- |
| jj available and repo colocated     | jj path: automatic descendant restacking              |
| jj available, repo not colocated    | Attempt `ensureColocated()`; on failure, fall through |
| jj missing, or any jj command fails | Git path (below)                                      |

The git path keeps every user-visible behavior — a dependent still branches off
its blocker's branch, and the merge queue still restacks dependents after a
blocker lands. The only difference is that restacking is explicit rather than
automatic:

```
git rebase --onto <new-base> <old-tip> <dependent-branch>
```

`<old-tip>` is the commit the dependent was branched from — recorded as
`RunMeta.stackBaseCommit` at dispatch time, when it is known exactly. It is
**not** the backup ref: that holds the dependent's own tip, and using it here
would make the replay range empty. The jj path needs the same fact, expressed as
a revset:
`jj rebase -s 'roots(<stackBaseCommit>..<branch>)' -d <newBase> --skip-emptied`.

Verified by spike 4 (`.agents/ignore/spikes/jj-spike4.sh`): rebasing the whole
branch (`jj rebase -b`) after the blocker squash-merges replays the blocker's
commits on top of a base that already contains them — "Rebased 2 commits" where
only one is the dependent's own. The `-s` form rebases exactly one.

The 2+ blocker case has no git equivalent for `jj new -r A -r B`, so under the
git path a task with two or more unmerged blockers waits (today's behavior)
rather than dispatching against a wrong base. This is the one capability jj
genuinely gates, and it is surfaced in the UI as such.

Failures during a git restack abort (`git rebase --abort`) and fail the entry
with a reason, matching the existing `rebase()` failure contract
(`mergeQueue.ts:448`).

## 5. Failure modes

| Situation                                        | Behavior                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `jj` not installed                               | Git fallback (§4.6): stacking still works; only the 2+ blocker case waits.                                                 |
| `jj git init --colocate` fails                   | Git fallback (§4.6); the failure is logged to Activity, dispatch proceeds.                                                 |
| Restack hits a conflict (jj path)                | jj records the conflict in the commit rather than aborting; the entry fails with a reason and the worktree is left usable. |
| Restack hits a conflict (git path)               | `git rebase --abort`, entry fails with a reason, branch restorable from its backup ref.                                    |
| Restack rewrote a branch badly                   | `git update-ref refs/heads/<branch> refs/dispatch/backup/<branch>/<runId>` restores the pre-restack tip.                   |
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
- Explicit test that `rebase()` takes the jj path on a colocated repo. An
  _unintended_ fallback to plain `git rebase` without the explicit dependent
  restack would look correct until the first blocker merged, then dependents
  would conflict against their own already-squashed commits.
- The git fallback (§4.6) tested against a **plain-git temp repo with no jj at
  all**: a dependent branches off its blocker, and after the blocker merges the
  dependent is restacked via `--onto` and its worktree resynced. This path must
  be tested independently, since it is what every non-jj project actually runs.
- Backup refs: written before each restack, sufficient to restore the prior tip,
  and pruned when the run's worktree is removed.

## 7. Out of scope

- Replacing `git worktree` with `jj workspace` (ruled out by the spike).
- Restacking dependents of a run that is still live.
- A DAG view of stacks — still deferred, as in the 2026-07-22 spec.
- Changing `readyTasks` semantics for CLI, MCP, or board surfaces.
- A pre-colocation repo snapshot/rollback. Considered and not taken: colocation
  is already reversible via `jj git colocation disable`, and the two safety nets
  in §4.6 cover the paths that actually rewrite history.
