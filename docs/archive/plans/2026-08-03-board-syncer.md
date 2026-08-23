# Board Syncer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Dispatch board actually reach teammates — task edits commit and
push automatically, teammates' changes arrive, and none of it can touch your
working tree.

**Architecture:** The board is the state of `.dispatch/` on trunk (spec §3.2). A
private worktree pinned to trunk, living outside the repo under `~/.dispatch/`,
is where the syncer commits and pushes; the user's own working tree, index and
`HEAD` are never touched. Task-file changes are mirrored into that worktree
gated by a monotonic rule extracted from the Linear syncer, so a branch checkout
holding older content can never push the board backwards. Incoming teammate
changes are materialized back into the user's working tree.

**Tech Stack:** Bun + TypeScript monorepo, `bun test`, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-08-02-team-collaboration-design.md` §4.4
and §4.5 — build-order step 3. Presence, claims and cross-machine agents (§4.8,
§4.9, §4.10) are Plan 3; audit export and surfaces (§4.11, §4.12) are Plan 4.

**Depends on:** Plan 1
(`docs/superpowers/plans/2026-08-02-team-identity-and-merge-hygiene.md`),
merged. In particular `ActorContext` (now in `@dispatch/core`), the task-file
merge driver, and the actor model.

## Global Constraints

- Run everything from the worktree root, on a branch off `main` **after** Plan 1
  has merged.
- `export AGENT=1` at the start of every terminal session.
- Use `bun`. Never `npm`, `pnpm`, or `npx`.
- Dependencies come from the root `workspaces.catalog`. Do not add versions to
  package-level `package.json` files.
- Code comments are 1–2 lines maximum. Prefer one function-level comment saying
  what the helper does and why it exists. No incident narratives.
- Preserve trailing newlines at the end of files.
- Anything in `packages/core/src/` reachable from `packages/core/src/browser.ts`
  must have no `node:*` imports.
- **`bun test packages/server/test/` takes ~237s and exceeds the default 120s
  tool timeout.** Run it with an explicit timeout of 400000 ms.
- `bun run tsc` carries 4 pre-existing `PlanRecord.role` errors in
  `apps/desktop`; `bun run lint` sits at a baseline of 109 warnings / 1 error.
  Only new problems count.
- **The pre-commit hook runs `oxlint --type-aware --fix`, which rewrites `||`
  into `??` mid-commit via `typescript/prefer-nullish-coalescing`.** Where an
  empty string must fall back, use an explicit comparison and re-check the file
  after committing.

## The invariant this plan enforces

> The board is the state of `.dispatch/` on trunk. A task revision reached by
> any other route — feature branch, worktree, run branch — is a **snapshot**:
> readable, never authoritative, never a sync input.

Commit `53190d6` discovered this rule under fire and applied it to one consumer
(Linear). This plan promotes it to shared code and adds a second consumer.

---

### Task 1: Extract the monotonic rule into core

**Files:**

- Create: `packages/core/src/timeline.ts`
- Create: `packages/core/test/timeline.test.ts`
- Modify: `packages/server/src/linear/sync.ts` (delete the private method, call
  the shared one)
- Modify: `packages/core/src/browser.ts`, `packages/core/src/index.ts`

**Interfaces:**

- Consumes: `TaskMeta` from `packages/core/src/types.ts`.
- Produces:
  `isOutstanding(updated: string, lastAccounted: string | undefined): boolean` —
  true when `updated` is strictly past `lastAccounted`; true when
  `lastAccounted` is undefined (never accounted for); false when either
  timestamp is unparseable.

The existing private method lives at `packages/server/src/linear/sync.ts:785`
and reads:

```ts
  private isOutstanding(state: LinearSyncState, doc: TaskDoc): boolean {
    const accounted = state.pushed[doc.meta.id];
    if (accounted === undefined) return true;
    return Date.parse(doc.meta.updated) > Date.parse(accounted);
  }
```

The extraction takes two strings rather than a `LinearSyncState` and a
`TaskDoc`, so the git syncer can use it against its own bookkeeping.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/timeline.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { isOutstanding } from '../src/timeline.js';

const T1 = '2026-08-01T00:00:00.000Z';
const T2 = '2026-08-02T00:00:00.000Z';

describe('isOutstanding', () => {
  it('is true when never accounted for', () => {
    expect(isOutstanding(T1, undefined)).toBe(true);
  });

  it('is true when content moved forward', () => {
    expect(isOutstanding(T2, T1)).toBe(true);
  });

  it('is false when content moved backwards', () => {
    expect(isOutstanding(T1, T2)).toBe(false);
  });

  it('is false when content is unchanged', () => {
    expect(isOutstanding(T1, T1)).toBe(false);
  });

  it('is false when either timestamp is unparseable', () => {
    expect(isOutstanding('not-a-date', T1)).toBe(false);
    expect(isOutstanding(T2, 'not-a-date')).toBe(false);
  });
});
```

The unparseable case matters: `Date.parse` returns `NaN`, and every comparison
against `NaN` is false, so the naive implementation already returns false — but
it does so by accident. Asserting it makes the behaviour deliberate, and "when
in doubt, do not push" is the safe direction for a rule whose whole job is
preventing a backwards write.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/timeline.test.ts` Expected: FAIL — cannot
resolve `../src/timeline.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/timeline.ts`:

```ts
// Pure timestamp comparison, no node:* imports, so this is safe for the
// desktop webview via the '@dispatch/core/browser' entry point.

/**
 * Whether a task's content has moved past the version a consumer last
 * accounted for. False when it moved backwards — a branch checkout holding an
 * older revision must never be pushed as if it were new work (see 53190d6).
 * Unparseable timestamps are treated as not-outstanding: when in doubt, hold.
 */
export function isOutstanding(
  updated: string,
  lastAccounted: string | undefined
): boolean {
  if (lastAccounted === undefined) return true;
  const now = Date.parse(updated);
  const then = Date.parse(lastAccounted);
  if (Number.isNaN(now) || Number.isNaN(then)) return false;
  return now > then;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/timeline.test.ts` Expected: PASS, 5 tests.

- [ ] **Step 5: Rewire the Linear syncer**

In `packages/server/src/linear/sync.ts`, delete the private `isOutstanding`
method and replace its call sites with the imported one:

```ts
isOutstanding(doc.meta.updated, state.pushed[doc.meta.id]);
```

Export the new symbol from `packages/core/src/browser.ts` and
`packages/core/src/index.ts`.

- [ ] **Step 6: Verify no Linear regression and commit**

The Linear sync tests are the real gate here — this refactor must not change
Linear's behaviour at all.

```bash
bun run format
bun run tsc
bun test packages/core/test/timeline.test.ts
bun test packages/server/test/            # explicit timeout 400000
git add -A
git commit -m "refactor(core,server): share the monotonic timeline rule

The rule that a task is outstanding only when its content moved past the
version last accounted for was discovered fixing a Linear regression
(53190d6) and lived as a private method on that syncer. The git board
syncer needs the same guarantee, so lift it into core against two
timestamps rather than Linear's state shape. Behaviour is unchanged."
```

---

### Task 2: The sync worktree

**Files:**

- Create: `packages/server/src/sync/worktree.ts`
- Create: `packages/server/test/sync/worktree.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `class SyncWorktree` with
  `static open(rootDir: string, run: GitRunner): SyncWorktree | null` (null when
  the repo has no trunk to pin to); `readonly path: string`;
  `trunkRef(): string`; `ensure(): void` (create or repair); `remove(): void`.
  `type GitRunner = (cwd: string, args: string[]) => { status: number; stdout: string; stderr: string }`.

**This is the task that makes automatic commit-and-push safe**, so its
properties matter more than its surface:

1. The worktree lives at `<DISPATCH_HOME>/worktrees/<hash of rootDir>/board`,
   keyed exactly the way `packages/server/src/linear/state.ts` keys per-project
   state and honouring `DISPATCH_HOME` before `homedir()` the way
   `packages/server/src/daemonfile.ts` does. It is **outside the user's repo**.
2. It is pinned to trunk. Resolve trunk from `origin/HEAD`, falling back to a
   local `main` then `master`; return `null` if none resolves, so a repo with no
   trunk simply has no syncer rather than a broken one.
3. `ensure()` is idempotent and self-healing: if the directory is missing, or
   `git worktree list` does not know it, recreate it. It holds no state that is
   not in git, so recreating costs nothing.

Read `packages/server/src/orchestrator/worktree.ts` (`WorktreeManager`, line 63)
first — it already creates worktrees with `git worktree add` and handles the
retry path at line 126. Follow its shape rather than inventing a second one.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/sync/worktree.test.ts`. Build a real temp git repo
(`git init`, a commit on `main`) rather than stubbing git — this task is
entirely about git behaviour, and a stubbed test would prove nothing.

Cover:

- `open()` returns null in a repo with no `main`/`master` and no `origin/HEAD`.
- `ensure()` creates the worktree, and its `HEAD` is trunk.
- `ensure()` twice is a no-op (does not error, does not duplicate).
- Deleting the directory and calling `ensure()` again recreates it.
- The path is outside `rootDir` — assert it, since this is the safety property.
- `remove()` deregisters it from `git worktree list`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/sync/worktree.test.ts` Expected: FAIL —
cannot resolve `../../src/sync/worktree.js`.

- [ ] **Step 3: Implement**

Follow `WorktreeManager`'s patterns for invoking git. Keep `SyncWorktree`
narrow: it knows how to exist and where it is, and nothing about task files.

- [ ] **Step 4: Run tests, then commit**

```bash
bun run format
bun ws server tsc
bun test packages/server/test/sync/worktree.test.ts
git add -A
git commit -m "feat(server): add the board's private sync worktree

Automatic commit-and-push is only safe if it never operates in the tree
holding the user's uncommitted work. Add a worktree pinned to trunk,
living under DISPATCH_HOME outside the repo, that the syncer will own.
It is self-healing because it holds no state that is not already in git."
```

---

### Task 3: Mirror, commit, push

**Files:**

- Create: `packages/server/src/sync/boardSyncer.ts`
- Create: `packages/server/test/sync/boardSyncer.test.ts`

**Interfaces:**

- Consumes: `isOutstanding` (Task 1), `SyncWorktree` (Task 2), `ActorContext`
  from `@dispatch/core`.
- Produces: `class BoardSyncer` with
  `constructor(rootDir, worktree: SyncWorktree, actor: ActorContext, run: GitRunner)`;
  `syncOnce(): Promise<SyncResult>`;
  `interface SyncResult { pushed: number; pulled: number; state: SyncState; detail: string | null }`;
  `type SyncState = 'idle' | 'local-only' | 'blocked' | 'disabled'`.

The loop, per spec §4.5:

1. Read every `.dispatch/tasks/*.md` in the user's working tree.
2. For each, compare against the copy in the sync worktree using
   `isOutstanding(doc.meta.updated, <the sync worktree copy's updated>)`. Only
   outstanding files are mirrored. **This is the invariant**: a feature-branch
   checkout holding older task content is a snapshot and must be skipped, not
   pushed.
3. Copy the outstanding files into the sync worktree.
4. Commit there, staging **only** paths under `.dispatch/`. Message:
   `chore(board): <summary>`.
5. `pull --rebase`, then push.

**Staging discipline is not optional.**
`packages/server/src/orchestrator/orchestrator.ts` already stages only a run's
own task file rather than the whole `.dispatch/` directory; follow that
instinct. A `git add -A` here would sweep whatever else happens to be in the
sync worktree.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/sync/boardSyncer.test.ts`. Use a **bare remote plus
two clones** in a temp dir — this harness is the point, and every later task
reuses it:

```ts
// Build once, reuse across tests: a bare origin and two clones, each with its
// own git identity, standing in for two teammates.
function twoClones(): { origin: string; a: string; b: string };
```

Cover:

- An edit in clone A reaches clone B after A syncs and B syncs.
- A task file whose `updated` moved backwards is NOT pushed (the `53190d6`
  regression, now at the syncer level). Construct it directly: write an older
  `updated` into the working-tree copy and assert the sync worktree copy is
  unchanged and nothing was committed.
- Concurrent edits to _different_ tasks in both clones converge with no
  conflict.
- The commit created touches only `.dispatch/` paths — assert with
  `git show --stat`.
- The user's working tree is untouched: record `git rev-parse HEAD` and
  `git status --porcelain` in the clone before and after `syncOnce()` and assert
  both are identical. **This is the safety property; assert it explicitly rather
  than trusting it.**

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/sync/boardSyncer.test.ts` Expected: FAIL —
cannot resolve the module.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests, then commit**

```bash
bun run format
bun ws server tsc
bun test packages/server/test/sync/boardSyncer.test.ts
git add -A
git commit -m "feat(server): commit and push board changes from the sync worktree

Task edits never left the machine: autoCommit was declared, validated
and editable from Settings, and read by nothing. Mirror outstanding task
files into the sync worktree, commit only .dispatch/ paths there, and
push. The monotonic gate means a feature-branch checkout holding older
content is skipped rather than pushed backwards."
```

---

### Task 4: Materialize incoming changes

**Files:**

- Modify: `packages/server/src/sync/boardSyncer.ts`
- Modify: `packages/server/test/sync/boardSyncer.test.ts`

**Interfaces:**

- Consumes: everything from Task 3.
- Produces: `SyncResult.pulled` becomes meaningful;
  `BoardSyncer.materialize(): number` returns how many files were written into
  the user's working tree.

**Amended 2026-08-03 after review.** This section originally said to scan the
sync worktree and gate every file with the monotonic rule. That is wrong, and
the first implementation shipped the defect it produces: a task file the user
deletes locally is never staged for removal (the push loop only iterates files
that exist), so it survives in the sync worktree, and the scan then writes it
back — `isOutstanding(incoming, undefined)` is unconditionally true, because an
absent local file and a never-seen local file are indistinguishable. Worse, it
sticks: the resurrected copy's `updated` now matches the worktree's, so the push
gate sees nothing outstanding and the deletion can never take. It re-resurrects
every cycle.

**Materialize from what the pull actually changed, not from a directory scan.**
Capture the sync worktree's HEAD before `git pull --rebase`, and afterwards ask
git which paths moved:

```bash
git diff --name-only --diff-filter=ACMR <before>..<after> -- .dispatch/tasks
git diff --name-only --diff-filter=D    <before>..<after> -- .dispatch/tasks
```

The first set is written into the user's working tree, the second removed from
it. A path the pull did not touch is never written and never deleted, so a local
deletion survives and a brand-new local task that has not synced yet cannot be
swept away.

**The monotonic rule still applies, but only to the changed set.** For each
incoming path, `isOutstanding(incoming.updated, localCopy.updated)` decides
whether to write: a working-tree copy newer than the incoming one is an unsynced
local edit and must not be clobbered. Skip it; the next `syncOnce()` pushes it.
Without that, a fast typist loses an edit every time a teammate's change lands
mid-write.

This also removes a hazard the reviewer flagged separately: `materialize()` is
public, and under the scan approach calling it standalone — before the staging
loop had mirrored a new local task — would delete that task as "missing
remotely." Driven from a diff, it has no opinion about paths the pull did not
touch, so the call-order invariant disappears rather than needing documenting.

`.dispatch/` is already excluded from the orchestrator's dirty gate, so writing
into the working tree does not destabilize a run.

Local deletions still do not _propagate_ to teammates — the push side never
issues `git rm`. That is a real gap, but it is a separate deliverable and is
recorded for a later plan rather than folded in here.

- [ ] **Step 1: Write the failing test**

Add to the boardSyncer suite:

- A change from clone B appears in clone A's **working tree** (not just its sync
  worktree) after A syncs.
- A locally-newer file is NOT overwritten by an older incoming one, and is
  pushed on the following sync.
- A file deleted by a teammate is removed locally.
- Materializing while the clone sits on a feature branch still updates
  `.dispatch/` — the board is trunk's state regardless of checkout.

- [ ] **Step 2: Run to verify failure. Step 3: Implement. Step 4: Verify.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(server): materialize teammates' board changes locally

A pull only reached the sync worktree, so the user's board never showed
a teammate's edit. Copy incoming files into the working tree, gated per
file by the same monotonic rule: a locally-newer copy is an unsynced
edit and is left alone rather than clobbered."
```

---

### Task 5: Wire it to the watcher, gate it on `autoCommit`

> **Amended 2026-08-03 after the final review — a periodic pull is required.**
> As specified, the only sync trigger is a local `task.changed` event, which is
> spec §4.5 read literally. The consequence the final review surfaced: a
> teammate who reads the board all day and edits nothing **never sees anyone
> else's changes**, and a `local-only` state after a network outage never
> recovers until that user's next local edit. Add a timer (60s) that pulls and
> materializes even when nothing changed locally, alongside the edit-triggered
> sync. It must respect the same `autoCommit` gate, must not stack with an
> in-flight sync (reuse the existing `inFlight`/`pendingRerun` guard), and must
> not re-arm on failure any faster than its normal interval — the no-retry-storm
> property still holds. This is tracked as follow-up work after the final fix
> wave, not as part of Task 5's original commits.

**Files:**

- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/watcher.ts` if the existing hook is insufficient
- Modify: `packages/core/src/store.ts` (`DEFAULT_CONFIG`)
- Test: `packages/server/test/sync/boardSyncer.test.ts`

`packages/server/src/watcher.ts:15` exposes
`watchTasks(tasksDir, onChange): Watcher` — the hook the syncer rides. Debounce
the sync the way the Linear push already debounces, so a burst of edits produces
one commit rather than one per keystroke.

**`autoCommit` finally acquires a consumer.** It gates this loop. Change
`DEFAULT_CONFIG` in `packages/core/src/store.ts` so new projects get
`autoCommit: true`; leave existing projects at whatever their `config.yml` says,
which for every project created before this plan is `false`. Nothing starts
pushing without an explicit opt-in.

Emit a `board.sync` event on the existing bus (`packages/server/src/events.ts`)
for every sync attempt, carrying the `SyncResult`, so the shell can render a
live feed.

- [ ] Steps: write a test that an edit triggers a debounced sync and that
      `autoCommit: false` suppresses it entirely; verify failure; implement;
      verify; commit.

---

### Task 6: Degradation

**Files:**

- Modify: `packages/server/src/sync/boardSyncer.ts`
- Modify: `packages/server/test/sync/boardSyncer.test.ts`

Every one of these is a real state a user will hit, and each must be visible
rather than silent:

| Condition                                                   | Behaviour                                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Push rejected — protected trunk, no permission, no `origin` | `state: 'local-only'`. Keep committing to the sync worktree. Do NOT retry in a loop. Surface it.                |
| `pull --rebase` conflicts                                   | `state: 'blocked'`, stop, surface the paths. **Never force.** The board keeps serving from the last good state. |
| No trunk resolvable (`SyncWorktree.open()` returned null)   | `state: 'disabled'`, no syncer, one clear log line at startup.                                                  |
| Offline / network failure                                   | Same as push rejected: `local-only`, no retry storm.                                                            |

Tests: simulate each by manipulating the temp remote — delete it, make it
non-writable, create a genuine divergent conflict. Assert the state, assert no
data loss, and assert that a subsequent successful sync recovers without manual
intervention.

- [ ] Steps: tests first, verify failure, implement, verify, commit.

---

### Task 7: Sync status API and desktop chip

**Files:**

- Modify: `packages/server/src/api.ts` (a `GET /api/sync` returning the last
  `SyncResult` plus pending counts)
- Modify: `packages/client/src/api.ts`
- Create: `apps/desktop/src/components/shell/SyncChip.tsx`
- Modify: the shell to render it

The chip shows last-synced, pending outgoing, incoming, and the degraded state
from Task 6, and offers the kill switch (setting `autoCommit: false` through the
existing config patch endpoint).

**Coverage caveat to record rather than hide:** root `bun run test` excludes
`apps/desktop`, so the chip ships without automated coverage under the default
script. Note it in the task's commit body.

- [ ] Steps: API test first (it is server-side and testable), then the
      component, then wire it.

---

## Self-Review

**Spec coverage:**

| Spec section                                               | Task |
| ---------------------------------------------------------- | ---- |
| §4.4 Monotonic accounting, extracted                       | 1    |
| §4.5 Sync worktree                                         | 2    |
| §4.5 Mirror / commit / push                                | 3    |
| §4.5 Materialize incoming                                  | 4    |
| §4.5 `autoCommit` gate, events, kill switch                | 5, 7 |
| §6 Failure modes (push rejected, rebase conflict, offline) | 6    |
| §4.12 Sync chip                                            | 7    |

§4.8–§4.10 (presence, claims, cross-machine agents), §4.11 (audit export) and
the rest of §4.12 are later plans.

**Type consistency:** `isOutstanding` (Task 1) is used under that name in Tasks
3 and 4. `SyncWorktree` (Task 2) and `GitRunner` are consumed by Task 3.
`SyncResult`/`SyncState` (Task 3) are consumed by Tasks 5, 6 and 7.

**Known softness, flagged rather than hidden:** Tasks 5, 6 and 7 specify
behaviour and signatures but do not reproduce complete implementations, because
each depends on the exact shapes of `watcher.ts`, `events.ts`, `api.ts` and the
desktop shell as they stand when the plan runs — and Plan 1 demonstrated those
move. Each task says to read the file first and match it. Tasks 1–4, the
load-bearing ones, carry complete code or complete test specifications.

**Lesson carried from Plan 1:** three of its six final-review findings were
integration gaps — a capability built and never wired, a schema widened on one
side only, a registration hooked to one of three init paths. Task 5 exists
specifically to be the "is it actually wired?" task, and the final review of
this plan should check every new capability for a production caller before
approving.

## Out of scope

Presence, claims, cross-machine `run_list`/`agent_message`, audit export, the
Team page, and any coordination server. Nothing in this plan reads or writes
`refs/dispatch/*`.
