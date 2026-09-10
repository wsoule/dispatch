# Stacked Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A blocked task auto-starts as soon as its blocker reaches `in-review`,
and its worktree is branched off that blocker's branch rather than the default
base.

**Architecture:** A new dispatch-only readiness predicate in `@dispatch/core`
leaves `readyTasks()` (and therefore CLI, MCP, board badges, and merge ordering)
untouched. `Orchestrator.dispatch()` gains a base-resolution step that points a
dependent's worktree at its blocker's branch. The merge queue restacks
dependents after a blocker lands — via `jj rebase` (which restacks descendants
automatically) when the repo is jj-colocated, otherwise via an explicit
`git rebase --onto`. Every restack writes a backup ref first.

**Tech Stack:** Bun + TypeScript monorepo, `bun:test`, real `git`/`jj` binaries
shelled through an injectable `CommandRunner` seam.

**Spec:** `docs/superpowers/specs/2026-07-26-stacked-dispatch-design.md`

## Global Constraints

- Set `export AGENT=1` at the start of every terminal session (AGENTS.md).
- Use `bun` for all commands. Never `npm`/`pnpm`/`npx`.
- Dependencies go in the root `workspaces.catalog`, never in a package's own
  `package.json`.
- Preserve trailing newlines at end of files.
- After code changes, run `bun run format` and `bun run lint` from the monorepo
  root, plus the relevant package `bun run tsc` and focused tests.
- Prefer a short comment above each non-trivial helper explaining what it does
  and why it exists. Write for a reader new to the codepath. Function-level
  comments over many inline ones.
- `readyTasks()` semantics must NOT change. Any task that makes `readyTasks`
  treat `in-review` as satisfied is wrong.
- Merge-queue eligibility ordering (`mergeQueue.ts` `nextEligible`) must stay
  `isDone`-gated so a dependent can never land before its blocker.
- Never touch the worktree of a run that is not in a terminal state.
- New shell-outs go through the injectable `CommandRunner` seam (`pr.ts`), never
  a bare `Bun.spawn`, so tests can stub them.

---

### Task 1: Dispatch-readiness predicate in core

**Files:**

- Modify: `packages/core/src/graph.ts`
- Modify: `packages/core/src/index.ts:20-26`
- Test: `packages/core/test/graph.test.ts`

**Interfaces:**

- Consumes: `isDone(t: TaskDoc): boolean`, `PRIORITY_ORDER` (both already in
  `graph.ts`)
- Produces:
  - `isSatisfiedForDispatch(t: TaskDoc): boolean`
  - `dispatchableTasks(tasks: TaskDoc[]): TaskDoc[]`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/graph.test.ts` (the file already defines the
`make()` helper at the top — reuse it):

```typescript
describe('dispatchableTasks', () => {
  it('treats an in-review blocker as satisfied, unlike readyTasks', () => {
    const blocker = make({ id: 't-a00000', status: 'in-review' });
    const dependent = make({ id: 't-b00000', blockedBy: ['t-a00000'] });
    expect(
      dispatchableTasks([blocker, dependent]).map((t) => t.meta.id)
    ).toEqual(['t-b00000']);
    expect(readyTasks([blocker, dependent]).map((t) => t.meta.id)).toEqual([]);
  });

  it('still blocks on an in-progress or todo blocker', () => {
    const running = make({ id: 't-a00000', status: 'in-progress' });
    const waiting = make({ id: 't-c00000', status: 'todo' });
    const onRunning = make({ id: 't-b00000', blockedBy: ['t-a00000'] });
    const onWaiting = make({ id: 't-d00000', blockedBy: ['t-c00000'] });
    const ids = dispatchableTasks([running, waiting, onRunning, onWaiting]).map(
      (t) => t.meta.id
    );
    expect(ids).not.toContain('t-b00000');
    expect(ids).not.toContain('t-d00000');
  });

  it('still accepts done and cancelled blockers', () => {
    const done = make({ id: 't-a00000', status: 'done' });
    const cancelled = make({ id: 't-c00000', status: 'cancelled' });
    const dependent = make({
      id: 't-b00000',
      blockedBy: ['t-a00000', 't-c00000'],
    });
    expect(
      dispatchableTasks([done, cancelled, dependent]).map((t) => t.meta.id)
    ).toEqual(['t-b00000']);
  });

  it('sorts by priority then created date, like readyTasks', () => {
    const low = make({
      id: 't-100000',
      priority: 'low',
      created: '2026-01-01T00:00:00Z',
    });
    const urgent = make({
      id: 't-200000',
      priority: 'urgent',
      created: '2026-01-02T00:00:00Z',
    });
    expect(dispatchableTasks([low, urgent]).map((t) => t.meta.id)).toEqual([
      't-200000',
      't-100000',
    ]);
  });

  it('ignores dangling blocker ids, like readyTasks', () => {
    const dependent = make({ id: 't-b00000', blockedBy: ['t-missing'] });
    expect(dispatchableTasks([dependent])).toHaveLength(1);
  });
});

describe('isSatisfiedForDispatch', () => {
  it('is true for done, cancelled and in-review; false otherwise', () => {
    expect(isSatisfiedForDispatch(make({ status: 'done' }))).toBe(true);
    expect(isSatisfiedForDispatch(make({ status: 'cancelled' }))).toBe(true);
    expect(isSatisfiedForDispatch(make({ status: 'in-review' }))).toBe(true);
    expect(isSatisfiedForDispatch(make({ status: 'in-progress' }))).toBe(false);
    expect(isSatisfiedForDispatch(make({ status: 'todo' }))).toBe(false);
    expect(isSatisfiedForDispatch(make({ status: 'backlog' }))).toBe(false);
  });
});
```

Update the import at the top of the file to:

```typescript
import {
  dispatchableTasks,
  findDependencyCycles,
  isDone,
  isSatisfiedForDispatch,
  readyTasks,
} from '../src/graph.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test test/graph.test.ts` Expected: FAIL —
`dispatchableTasks is not a function` / import errors.

- [ ] **Step 3: Implement in `packages/core/src/graph.ts`**

Add directly below the existing `isDone` function:

```typescript
/**
 * Whether a blocker no longer holds up *dispatching* its dependents. Looser
 * than `isDone`: a run that finishes leaves its task at `in-review` and only
 * reaches `done` once a human merges it, so gating dispatch on `isDone` keeps
 * a dependent idle for the whole review window. Dispatch can start as soon as
 * the blocker's code exists on a branch, which is exactly `in-review`.
 *
 * `'in-review'` is hardcoded for the same reason `isDone` hardcodes
 * `'done'`/`'cancelled'` — the built-in statuses are the contract the
 * orchestrator's own transitions are written against, even though
 * `.dispatch/config.yml` lets a project add custom status names.
 */
export function isSatisfiedForDispatch(t: TaskDoc): boolean {
  return isDone(t) || t.meta.status === 'in-review';
}

/**
 * Tasks the orchestrator may start *now*: same filter and ordering as
 * `readyTasks`, but blockers only need to be dispatch-satisfied (see
 * `isSatisfiedForDispatch`) rather than done.
 *
 * Deliberately a separate function rather than an option on `readyTasks`:
 * `readyTasks` is what the CLI, the MCP `ready` tool, the board's Blocked
 * badge, and merge-queue ordering all mean by "ready", and none of those
 * should start calling a task with an unmerged blocker ready.
 */
export function dispatchableTasks(tasks: TaskDoc[]): TaskDoc[] {
  const byId = new Map(tasks.map((t) => [t.meta.id, t]));
  return tasks
    .filter((t) => t.meta.kind === 'task' && t.meta.status === 'todo')
    .filter((t) =>
      t.meta.blockedBy.every((dep) => {
        const d = byId.get(dep);
        return d === undefined || isSatisfiedForDispatch(d);
      })
    )
    .sort((a, b) => {
      const byPriority =
        PRIORITY_ORDER[a.meta.priority] - PRIORITY_ORDER[b.meta.priority];
      return byPriority !== 0
        ? byPriority
        : a.meta.created.localeCompare(b.meta.created);
    });
}
```

- [ ] **Step 4: Export from `packages/core/src/index.ts`**

Change the existing `graph.js` export block to:

```typescript
export {
  readyTasks,
  dispatchableTasks,
  isDone,
  isSatisfiedForDispatch,
  PRIORITY_ORDER,
  findDependencyCycles,
  computeStack,
} from './graph.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && bun test test/graph.test.ts` Expected: PASS, including
the pre-existing `readyTasks` tests (they are the regression guard that
`readyTasks` semantics did not move).

- [ ] **Step 6: Verify and commit**

```bash
export AGENT=1
bun run format && bun run lint
cd packages/core && bun run tsc && cd ../..
git add packages/core/src/graph.ts packages/core/src/index.ts packages/core/test/graph.test.ts
git commit -m "feat(core): add dispatch-only readiness predicate

A finished run leaves its task at in-review and only reaches done once a
human merges it, so gating dispatch on isDone keeps dependents idle for
the whole review window. dispatchableTasks applies the same filter and
ordering as readyTasks with a looser blocker predicate, leaving readyTasks
untouched for the CLI, MCP, board badges, and merge-queue ordering."
```

---

### Task 2: EpicEngine dispatches on `in-review` blockers

**Files:**

- Modify: `packages/server/src/orchestrator/epic.ts:1` (import), `:247`
  (fillQueue)
- Test: `packages/server/test/orchestrator/epic.test.ts`

**Interfaces:**

- Consumes: `dispatchableTasks(tasks: TaskDoc[]): TaskDoc[]` from Task 1
- Produces: no new exports; behavior change only

**Context the implementer needs:** `handleFinish` (`orchestrator.ts:1150-1154`)
sets the task to `in-review`, rebuilds the cache, and _then_ fires terminal
hooks. `EpicEngine` already subscribes to those hooks (`epic.ts:81`), so no new
event wiring is required — the existing `onRunTerminal` already fires at the
exact moment a blocker becomes dispatch-satisfying.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/orchestrator/epic.test.ts`. Follow the existing
harness in that file (`makeHarness`, `waitFor`, the paused-at-approval
`FakeExecutor`); the assertion that matters is that the dependent picks up a run
while the blocker is still merely `in-review`:

```typescript
it('dispatches a child whose blocker is only in-review, not yet done', async () => {
  const h = makeHarness();
  const epic = h.store.create({ title: 'Epic', kind: 'epic' });
  const blocker = h.store.create({ title: 'A', parent: epic.meta.id });
  const dependent = h.store.create({
    title: 'B',
    parent: epic.meta.id,
    blockedBy: [blocker.meta.id],
  });
  h.cache.rebuild(h.store);

  h.epics.start(epic.meta.id, { concurrency: 2, executor: 'fake' });

  // Only the blocker is dispatchable at first.
  await waitFor(() => h.orchestrator.list().length === 1);
  expect(h.orchestrator.list()[0].taskId).toBe(blocker.meta.id);

  // Drive the blocker to a terminal state -> task becomes `in-review`.
  const run = h.orchestrator.list()[0];
  h.orchestrator.approve(run.id, lastRequestId(run.id), true);
  await waitFor(
    () => h.store.get(blocker.meta.id)!.meta.status === 'in-review'
  );

  // The dependent must now dispatch WITHOUT the blocker ever reaching `done`.
  await waitFor(() =>
    h.orchestrator.list().some((r) => r.taskId === dependent.meta.id)
  );
  expect(h.store.get(blocker.meta.id)!.meta.status).toBe('in-review');
});

it('does not dispatch a child whose blocker is still in-progress', async () => {
  const h = makeHarness();
  const epic = h.store.create({ title: 'Epic', kind: 'epic' });
  const blocker = h.store.create({ title: 'A', parent: epic.meta.id });
  const dependent = h.store.create({
    title: 'B',
    parent: epic.meta.id,
    blockedBy: [blocker.meta.id],
  });
  h.cache.rebuild(h.store);

  h.epics.start(epic.meta.id, { concurrency: 2, executor: 'fake' });
  await waitFor(() => h.orchestrator.list().length === 1);
  await sleep(50); // give a wrong implementation time to dispatch the dependent

  expect(h.store.get(blocker.meta.id)!.meta.status).toBe('in-progress');
  expect(
    h.orchestrator.list().some((r) => r.taskId === dependent.meta.id)
  ).toBe(false);
});
```

Note: use whatever the file's existing helper is for resolving a run's pending
approval id in place of `lastRequestId` — match the surrounding tests rather
than inventing a helper.

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `cd packages/server && bun test test/orchestrator/epic.test.ts` Expected:
the `in-review` test FAILS (`waitFor timed out`) because `readyTasks` still
gates on `done`. The `in-progress` test should already PASS — it is the guard
that the fix does not over-loosen.

- [ ] **Step 3: Switch fillQueue to the new predicate**

In `packages/server/src/orchestrator/epic.ts`, change the import on line 1:

```typescript
import { dispatchableTasks, loadConfig } from '@dispatch/core';
```

and the readiness computation at `:247`:

```typescript
const ready = dispatchableTasks(this.ctx.cache.query()).filter((t) =>
  childIds.has(t.meta.id)
);
```

Update the C1 doc comment above `fillQueue` (`:226-232`) so it describes
`dispatchableTasks` — the full-task-set reasoning it documents is unchanged and
still applies.

Also update the stale reasoning in two comments that assert dispatch waits for
`done`:

- `epic.ts:74-80` (the constructor comment on why two hooks exist)
- `epic.ts:202-204` (`onRunReviewed`'s "only merge/PR-merge can unblock a
  sibling")

`onRunReviewed`'s discard early-return at `:206` stays exactly as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bun test test/orchestrator/epic.test.ts` Expected:
PASS, all tests in the file.

- [ ] **Step 5: Verify and commit**

```bash
export AGENT=1
bun run format && bun run lint
cd packages/server && bun run tsc && cd ..
git add packages/server/src/orchestrator/epic.ts packages/server/test/orchestrator/epic.test.ts
git commit -m "fix(orchestrator): dispatch children blocked by in-review tasks

EpicEngine gated dispatch on readyTasks, which requires a blocker to be
done — a state only a human review action produces. A dependent therefore
sat idle for the entire review window. No new event seam is needed:
handleFinish sets in-review and rebuilds the cache before firing terminal
hooks, so the existing onRunTerminal subscription already fires at the
right moment."
```

---

### Task 3: `JjManager` seam

**Files:**

- Create: `packages/server/src/orchestrator/jj.ts`
- Test: `packages/server/test/orchestrator/jj.test.ts`

**Interfaces:**

- Consumes: `CommandRunner`, `CommandResult`, `defaultCommandRunner` from
  `./pr.js`
- Produces:
  - `class JjManager { constructor(rootDir: string, run?: CommandRunner) }`
  - `isAvailable(): Promise<boolean>`
  - `isColocated(): Promise<boolean>`
  - `ensureColocated(): Promise<boolean>`
  - `restack(branch: string, onto: string): Promise<void>`
  - `restackOnto(branch: string, stackBaseCommit: string, onto: string): Promise<void>`
  - `mergeBase(parents: string[], bookmark: string): Promise<string>`
  - `exportGit(): Promise<void>`

**Note on `importGit`:** the spec's method table lists `importGit()` alongside
`exportGit()`. It is deliberately NOT implemented here — a colocated repo
imports from git automatically at the start of every `jj` command, so an
explicit import would be dead code. Only the export direction needs to be
forced, because git tooling and dispatch's worktrees can only see real refs.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/orchestrator/jj.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';

import { JjManager } from '../../src/orchestrator/jj.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';

// Records every command a JjManager issues and replays canned results, so
// these tests assert the exact jj invocations without needing a real repo.
function fakeRunner(results: Record<string, CommandResult>) {
  const calls: string[][] = [];
  const run = (_cwd: string, cmd: string[]): Promise<CommandResult> => {
    calls.push(cmd);
    const key = cmd.join(' ');
    return Promise.resolve(
      results[key] ?? { ok: true, stdout: '', stderr: '' }
    );
  };
  return { calls, run };
}

describe('JjManager', () => {
  it('reports availability from `jj --version`', async () => {
    const missing = fakeRunner({
      'jj --version': { ok: false, stdout: '', stderr: 'command not found' },
    });
    expect(await new JjManager('/repo', missing.run).isAvailable()).toBe(false);

    const present = fakeRunner({
      'jj --version': { ok: true, stdout: 'jj 0.43.0\n', stderr: '' },
    });
    expect(await new JjManager('/repo', present.run).isAvailable()).toBe(true);
  });

  it('reports colocation from `jj git colocation status`', async () => {
    const no = fakeRunner({
      'jj git colocation status': {
        ok: false,
        stdout: '',
        stderr: 'There is no jj repo in "."',
      },
    });
    expect(await new JjManager('/repo', no.run).isColocated()).toBe(false);
  });

  it('ensureColocated is a no-op when already colocated', async () => {
    const f = fakeRunner({
      'jj --version': { ok: true, stdout: 'jj 0.43.0', stderr: '' },
      'jj git colocation status': { ok: true, stdout: 'colocated', stderr: '' },
    });
    expect(await new JjManager('/repo', f.run).ensureColocated()).toBe(true);
    expect(f.calls.map((c) => c.join(' '))).not.toContain(
      'jj git init --colocate'
    );
  });

  it('ensureColocated initializes a plain-git repo', async () => {
    const f = fakeRunner({
      'jj --version': { ok: true, stdout: 'jj 0.43.0', stderr: '' },
      'jj git colocation status': {
        ok: false,
        stdout: '',
        stderr: 'no jj repo',
      },
    });
    expect(await new JjManager('/repo', f.run).ensureColocated()).toBe(true);
    expect(f.calls.map((c) => c.join(' '))).toContain('jj git init --colocate');
  });

  it('ensureColocated returns false when jj is missing, without running anything else', async () => {
    const f = fakeRunner({
      'jj --version': { ok: false, stdout: '', stderr: 'not found' },
    });
    expect(await new JjManager('/repo', f.run).ensureColocated()).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it('restackOnto moves only the dependent commits and skips emptied ones', async () => {
    const f = fakeRunner({});
    await new JjManager('/repo', f.run).restackOnto(
      'dispatch/t-b',
      'abc1234',
      'main'
    );
    expect(f.calls.map((c) => c.join(' '))).toEqual([
      'jj rebase -s roots(abc1234..dispatch/t-b) -d main --skip-emptied',
      'jj git export',
    ]);
  });

  it('restack rebases the branch and exports refs back to git', async () => {
    const f = fakeRunner({});
    await new JjManager('/repo', f.run).restack('dispatch/t-b', 'main');
    expect(f.calls.map((c) => c.join(' '))).toEqual([
      'jj rebase -b dispatch/t-b -d main',
      'jj git export',
    ]);
  });

  it('restack throws with jj stderr when the rebase fails', async () => {
    const f = fakeRunner({
      'jj rebase -b dispatch/t-b -d main': {
        ok: false,
        stdout: '',
        stderr: 'no such revision',
      },
    });
    await expect(
      new JjManager('/repo', f.run).restack('dispatch/t-b', 'main')
    ).rejects.toThrow('no such revision');
  });

  it('mergeBase creates a multi-parent commit and bookmarks it', async () => {
    const f = fakeRunner({});
    const ref = await new JjManager('/repo', f.run).mergeBase(
      ['dispatch/a', 'dispatch/c'],
      'dispatch/stack-base-t-d00000'
    );
    expect(ref).toBe('dispatch/stack-base-t-d00000');
    expect(f.calls.map((c) => c.join(' '))).toEqual([
      'jj new -r dispatch/a -r dispatch/c',
      'jj bookmark create dispatch/stack-base-t-d00000 -r @',
      'jj git export',
    ]);
  });

  it('mergeBase rejects fewer than two parents', async () => {
    const f = fakeRunner({});
    await expect(
      new JjManager('/repo', f.run).mergeBase(['dispatch/a'], 'dispatch/b')
    ).rejects.toThrow('at least two parents');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && bun test test/orchestrator/jj.test.ts` Expected:
FAIL — module `jj.js` does not exist.

- [ ] **Step 3: Implement `packages/server/src/orchestrator/jj.ts`**

```typescript
import type { CommandResult, CommandRunner } from './pr.js';
import { defaultCommandRunner } from './pr.js';

// Picks whichever of a failed command's streams actually has content,
// preferring stderr. Same helper shape as pr.ts/mergeQueue.ts keep privately —
// copied rather than shared for the same reason mergeQueue.ts copied it: it is
// three lines, and widening pr.ts's exports for it buys nothing.
function commandErrorText(result: CommandResult): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

/**
 * Every jj operation the orchestrator needs, against the project's main
 * checkout. jj is used for the *commit graph* only — never for working copies:
 * secondary jj workspaces are not colocated and cannot be made colocated
 * (`jj git colocation enable` refuses outside the main workspace), so no git
 * command works inside one, and dispatch's agents, auto-commit, diffing, and
 * `gh pr create` all require a real git repo. Agents therefore keep running in
 * plain `git worktree` checkouts; jj's job is that rewriting a blocker's
 * commits automatically restacks every dependent branch built on top of it.
 *
 * Shells through the same injectable CommandRunner seam PrManager and
 * MergeQueue use, so tests stub jj entirely instead of requiring the binary.
 * Every method degrades rather than throwing on a missing binary — callers
 * fall back to the plain-git path (see MergeQueue.restackDependents).
 */
export class JjManager {
  constructor(
    private readonly rootDir: string,
    private readonly run: CommandRunner = defaultCommandRunner
  ) {}

  async isAvailable(): Promise<boolean> {
    const result = await this.run(this.rootDir, ['jj', '--version']);
    return result.ok;
  }

  async isColocated(): Promise<boolean> {
    const result = await this.run(this.rootDir, [
      'jj',
      'git',
      'colocation',
      'status',
    ]);
    return result.ok;
  }

  /**
   * Makes the project repo jj-colocated if it isn't already, so the restack
   * path below is available. Returns false (never throws) when jj is missing
   * or the conversion fails — the caller then uses the plain-git fallback.
   *
   * Colocation is what keeps this non-invasive in practice: `.jj/` sits beside
   * `.git/`, jj adds it to git's exclude itself, and the whole thing is
   * reversible with `jj git colocation disable`.
   */
  async ensureColocated(): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    if (await this.isColocated()) return true;
    const init = await this.run(this.rootDir, [
      'jj',
      'git',
      'init',
      '--colocate',
    ]);
    if (init.ok) return true;
    // An existing non-colocated jj repo needs `colocation enable` instead —
    // `git init --colocate` refuses when .jj already exists.
    const enable = await this.run(this.rootDir, [
      'jj',
      'git',
      'colocation',
      'enable',
    ]);
    return enable.ok;
  }

  // Pushes jj's bookmarks back out to real git refs. Needed after any
  // operation that moves a bookmark, since git tooling (and dispatch's own
  // worktrees) only ever see the exported refs.
  async exportGit(): Promise<void> {
    await this.run(this.rootDir, ['jj', 'git', 'export']);
  }

  /**
   * Rebases `branch` onto `onto`. The reason jj is in this codebase: jj
   * automatically rebases every descendant of the rewritten commits and moves
   * their bookmarks with them, so restacking a blocker restacks the whole
   * stack above it in one call. A plain `git rebase` writes new commits that
   * jj reads as divergence, and descendants do NOT follow.
   */
  async restack(branch: string, onto: string): Promise<void> {
    const rebase = await this.run(this.rootDir, [
      'jj',
      'rebase',
      '-b',
      branch,
      '-d',
      onto,
    ]);
    if (!rebase.ok) {
      throw new Error(`jj rebase failed: ${commandErrorText(rebase)}`);
    }
    await this.exportGit();
  }

  /**
   * Moves ONLY the commits a dependent added on top of `stackBaseCommit` onto
   * `onto`, dropping any that `onto` already contains.
   *
   * This is the post-merge case and it needs `-s`, not `-b`. Once a blocker
   * has been squash-merged, `restack()` above would replay the blocker's own
   * commits on top of a base that already holds that work in squashed form —
   * measured: "Rebased 2 commits" where only one belongs to the dependent
   * (`.agents/ignore/spikes/jj-spike4.sh`). `roots(base..branch)` names the
   * first commit the dependent actually authored, and `--skip-emptied` drops
   * anything whose content already landed.
   */
  async restackOnto(
    branch: string,
    stackBaseCommit: string,
    onto: string
  ): Promise<void> {
    const rebase = await this.run(this.rootDir, [
      'jj',
      'rebase',
      '-s',
      `roots(${stackBaseCommit}..${branch})`,
      '-d',
      onto,
      '--skip-emptied',
    ]);
    if (!rebase.ok) {
      throw new Error(`jj rebase -s failed: ${commandErrorText(rebase)}`);
    }
    await this.exportGit();
  }

  /**
   * Creates a commit whose parents are all of `parents` and bookmarks it as
   * `bookmark`, returning that bookmark name for use as a worktree base. This
   * is how a task with two or more unmerged blockers gets a base containing
   * all of their work — git has no equivalent, which is why the plain-git
   * fallback makes such a task wait instead.
   */
  async mergeBase(parents: string[], bookmark: string): Promise<string> {
    if (parents.length < 2) {
      throw new Error(
        `mergeBase needs at least two parents, got ${parents.length}`
      );
    }
    const revArgs = parents.flatMap((p) => ['-r', p]);
    const create = await this.run(this.rootDir, ['jj', 'new', ...revArgs]);
    if (!create.ok) {
      throw new Error(`jj new failed: ${commandErrorText(create)}`);
    }
    const mark = await this.run(this.rootDir, [
      'jj',
      'bookmark',
      'create',
      bookmark,
      '-r',
      '@',
    ]);
    if (!mark.ok) {
      throw new Error(`jj bookmark create failed: ${commandErrorText(mark)}`);
    }
    await this.exportGit();
    return bookmark;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bun test test/orchestrator/jj.test.ts` Expected:
PASS.

- [ ] **Step 5: Verify and commit**

```bash
export AGENT=1
bun run format && bun run lint
cd packages/server && bun run tsc && cd ..
git add packages/server/src/orchestrator/jj.ts packages/server/test/orchestrator/jj.test.ts
git commit -m "feat(orchestrator): add jj seam for stack graph operations

jj is used for the commit graph only, never for working copies: secondary
jj workspaces cannot be colocated, so no git command works inside one and
agents, auto-commit, diffing, and gh all need a real git repo. What jj
buys is automatic restacking of every dependent branch when a blocker's
commits are rewritten. Every method degrades instead of throwing when the
binary is absent, so callers can fall back to plain git."
```

---

### Task 4: Backup refs and worktree resync

**Files:**

- Modify: `packages/server/src/orchestrator/worktree.ts` (add three methods;
  `remove` at `:118`)
- Test: `packages/server/test/orchestrator/worktree.test.ts` (create if absent;
  otherwise append)

**Interfaces:**

- Consumes: the private `runGit(cwd, args)` already in `worktree.ts:24`
- Produces, on `WorktreeManager`:
  - `backupRefName(branch: string, runId: string): string`
  - `writeBackupRef(branch: string, runId: string): string | null` — returns the
    backed-up commit sha, or null if the branch has no tip
  - `restoreFromBackup(branch: string, runId: string): void`
  - `pruneBackupRefs(runId: string): void`
  - `resyncToBranch(worktreePath: string, branch: string): void`
  - `rebaseOnto(worktreePath: string, newBase: string, oldTip: string, branch: string): void`

- [ ] **Step 1: Write the failing tests**

Create/append `packages/server/test/orchestrator/worktree.test.ts`, using the
existing `initGitRepo`/`runGitSync` helpers:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { WorktreeManager } from '../../src/orchestrator/worktree.js';
import { initGitRepo, runGitSync } from './helpers.js';

let repo: string;
beforeEach(() => {
  repo = initGitRepo('dispatch-wt-');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('backup refs', () => {
  it('writes a backup ref at the branch tip and restores it after a rewrite', () => {
    const wt = new WorktreeManager(repo);
    const base = wt.defaultBaseBranch();
    const path = join(repo, '..', 'wt-backup-test');
    wt.add(path, 'dispatch/t-a', base);
    Bun.write(join(path, 'a.txt'), 'a');
    runGitSync(path, ['add', '-A']);
    runGitSync(path, ['commit', '-m', 'a']);

    const tip = runGitSync(path, ['rev-parse', 'HEAD']).trim();
    const saved = wt.writeBackupRef('dispatch/t-a', 'r-abc123');
    expect(saved).toBe(tip);

    // Rewrite the branch to something else, then restore.
    runGitSync(repo, ['branch', '-f', 'dispatch/t-a', base]);
    expect(runGitSync(repo, ['rev-parse', 'dispatch/t-a']).trim()).not.toBe(
      tip
    );

    wt.restoreFromBackup('dispatch/t-a', 'r-abc123');
    expect(runGitSync(repo, ['rev-parse', 'dispatch/t-a']).trim()).toBe(tip);

    wt.remove(path, 'dispatch/t-a');
  });

  it('backup refs are invisible to `git branch` and pruned by runId', () => {
    const wt = new WorktreeManager(repo);
    const base = wt.defaultBaseBranch();
    const path = join(repo, '..', 'wt-prune-test');
    wt.add(path, 'dispatch/t-b', base);
    wt.writeBackupRef('dispatch/t-b', 'r-def456');

    expect(runGitSync(repo, ['branch', '--list'])).not.toContain('backup');
    expect(
      runGitSync(repo, ['for-each-ref', 'refs/dispatch/backup'])
    ).toContain('r-def456');

    wt.pruneBackupRefs('r-def456');
    expect(runGitSync(repo, ['for-each-ref', 'refs/dispatch/backup'])).toBe('');

    wt.remove(path, 'dispatch/t-b');
  });

  it('writeBackupRef returns null for a branch with no tip', () => {
    const wt = new WorktreeManager(repo);
    expect(wt.writeBackupRef('dispatch/does-not-exist', 'r-000000')).toBeNull();
  });
});

describe('resyncToBranch', () => {
  it('reattaches a detached worktree to its branch', () => {
    const wt = new WorktreeManager(repo);
    const base = wt.defaultBaseBranch();
    const path = join(repo, '..', 'wt-resync-test');
    wt.add(path, 'dispatch/t-c', base);
    const tip = runGitSync(path, ['rev-parse', 'HEAD']).trim();

    runGitSync(path, ['checkout', '--detach', tip]);
    expect(runGitSync(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'HEAD'
    );

    wt.resyncToBranch(path, 'dispatch/t-c');
    expect(runGitSync(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'dispatch/t-c'
    );

    wt.remove(path, 'dispatch/t-c');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && bun test test/orchestrator/worktree.test.ts`
Expected: FAIL — `wt.writeBackupRef is not a function`.

- [ ] **Step 3: Implement the methods in
      `packages/server/src/orchestrator/worktree.ts`**

Add inside the `WorktreeManager` class, after `remove`:

```typescript
  /**
   * Where a branch's pre-restack tip is parked. Lives under `refs/dispatch/`
   * rather than `refs/heads/` so it never shows up in `git branch`, never gets
   * pushed, and can't be confused for a real branch — it is recovery state,
   * not something anyone checks out. Scoped by runId so two runs on the same
   * branch never clobber each other's backup.
   */
  backupRefName(branch: string, runId: string): string {
    return `refs/dispatch/backup/${branch}/${runId}`;
  }

  /**
   * Saves `branch`'s current tip before something rewrites it. Returns the
   * saved sha, or null when the branch has no tip yet (nothing to protect).
   *
   * This exists for two reasons at once: it makes every restack reversible,
   * and the sha it returns is exactly the `<oldTip>` argument `rebaseOnto`
   * needs to know where a dependent's own commits begin.
   */
  writeBackupRef(branch: string, runId: string): string | null {
    const tip = runGit(this.mainRepoDir, ['rev-parse', '--verify', branch]);
    if (!tip.ok) return null;
    const sha = tip.stdout.trim();
    runGit(this.mainRepoDir, [
      'update-ref',
      this.backupRefName(branch, runId),
      sha,
    ]);
    return sha;
  }

  // Points `branch` back at whatever `writeBackupRef` saved for this run.
  restoreFromBackup(branch: string, runId: string): void {
    const ref = this.backupRefName(branch, runId);
    const saved = runGit(this.mainRepoDir, ['rev-parse', '--verify', ref]);
    if (!saved.ok) return;
    runGit(this.mainRepoDir, [
      'update-ref',
      `refs/heads/${branch}`,
      saved.stdout.trim(),
    ]);
  }

  // Drops every backup ref belonging to a run — called from the same cleanup
  // path that removes its worktree and branch, so backups don't accumulate.
  pruneBackupRefs(runId: string): void {
    const refs = runGit(this.mainRepoDir, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/dispatch/backup',
    ]);
    if (!refs.ok) return;
    for (const ref of refs.stdout.split('\n')) {
      const trimmed = ref.trim();
      if (trimmed.endsWith(`/${runId}`)) {
        runGit(this.mainRepoDir, ['update-ref', '-d', trimmed]);
      }
    }
  }

  /**
   * Reattaches a worktree to `branch`. A restack rewrites branch refs from the
   * main checkout, and git refuses to move a branch that is checked out in
   * another worktree — so the worktree is left in detached HEAD at the old
   * commit. This is the one command that brings it back in line.
   *
   * Callers MUST only invoke this for runs in a terminal state; a live agent's
   * worktree is never touched.
   */
  resyncToBranch(worktreePath: string, branch: string): void {
    const checkout = runGit(worktreePath, ['checkout', branch]);
    if (!checkout.ok) {
      throw new Error(
        `git checkout ${branch} failed: ${checkout.stderr.trim()}`
      );
    }
  }

  /**
   * The plain-git restack, used when jj isn't available: replays exactly the
   * commits in `oldTip..branch` (a dependent's own work) onto `newBase`,
   * dropping the blocker commits that `newBase` now already contains in
   * squashed form. Without the explicit `--onto`, a plain `git rebase newBase`
   * would try to replay the blocker's commits too and conflict against their
   * own squashed copies.
   *
   * Aborts and throws on conflict, leaving the worktree clean for a retry —
   * the same contract MergeQueue.rebase() already has.
   */
  rebaseOnto(
    worktreePath: string,
    newBase: string,
    oldTip: string,
    branch: string
  ): void {
    const rebase = runGit(worktreePath, [
      'rebase',
      '--onto',
      newBase,
      oldTip,
      branch,
    ]);
    if (!rebase.ok) {
      runGit(worktreePath, ['rebase', '--abort']);
      const reason = [rebase.stdout.trim(), rebase.stderr.trim()]
        .filter((s) => s.length > 0)
        .join(' | ');
      throw new Error(`git rebase --onto failed: ${reason}`);
    }
  }
```

Then wire backup cleanup into the existing `remove` method so backups die with
their run. Change `remove`'s signature and body to:

```typescript
  remove(path: string, branch: string, runId?: string): void {
    runGit(this.mainRepoDir, ['worktree', 'remove', '--force', path]);
    runGit(this.mainRepoDir, ['branch', '-D', branch]);
    if (runId !== undefined) this.pruneBackupRefs(runId);
    this.prune();
  }
```

`runId` is optional so existing call sites keep compiling; pass it from the
orchestrator's cleanup path where the run id is in hand.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && bun test test/orchestrator/worktree.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
export AGENT=1
bun run format && bun run lint
cd packages/server && bun run tsc && cd ..
git add packages/server/src/orchestrator/worktree.ts packages/server/test/orchestrator/worktree.test.ts
git commit -m "feat(orchestrator): add backup refs, worktree resync, rebase --onto

Backup refs park a branch's pre-restack tip under refs/dispatch/ so it
never appears in git branch and never gets pushed, making every restack
reversible. The saved sha doubles as the <oldTip> argument the plain-git
restack needs. resyncToBranch reattaches a worktree that a restack left
detached, since git won't move a branch checked out elsewhere."
```

---

### Task 5: Base selection at dispatch

**Files:**

- Modify: `packages/server/src/orchestrator/types.ts:121-153` (RunMeta)
- Modify: `packages/server/src/orchestrator/orchestrator.ts:74-96` (field),
  `:157-236` (dispatch)
- Test: `packages/server/test/orchestrator/stacked-dispatch.test.ts` (create)

**Interfaces:**

- Consumes: `JjManager` (Task 3), `isSatisfiedForDispatch` / `isDone` (Task 1)
- Produces:
  - `RunMeta.stackParents?: string[]`
  - `RunMeta.baseDiscarded?: boolean`
  - `Orchestrator.resolveBase(task: TaskDoc): Promise<{ base: string; stackParents: string[] }>`
    (private)

**Important:** `dispatch()` is currently synchronous and returns `RunMeta`.
`resolveBase` needs `await` for the jj path. Make `dispatch()` async and update
its call sites: `api.ts:305` and `epic.ts:253`. In `epic.ts` the call is inside
`fillQueue`'s loop — make `fillQueue` async and have its callers `void` it,
matching how `plan.ts:114` already treats fire-and-forget dispatch. Keep the
`OrchestratorConflictError` skip behavior in that loop intact.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/test/orchestrator/stacked-dispatch.test.ts`:

```typescript
import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { initGitRepo, runGitSync } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-stack-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

function makeHarness() {
  const store = new TaskStore(repo);
  store.init();
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
  });
  orchestrator.registerExecutor('fake', new FakeExecutor([]));
  return { store, cache, events, orchestrator };
}

describe('base selection', () => {
  it('uses the default base branch when a task has no blockers', async () => {
    const h = makeHarness();
    const task = h.store.create({ title: 'solo' });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(task.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
  });

  it('branches off the blocker branch when one blocker is in-review', async () => {
    const h = makeHarness();
    const blocker = h.store.create({ title: 'A' });
    const blockerRun = await h.orchestrator.dispatch(blocker.meta.id, 'fake');
    // Simulate the blocker finishing: commit work, move task to in-review.
    await Bun.write(join(blockerRun.worktreePath, 'a.txt'), 'a');
    runGitSync(blockerRun.worktreePath, ['add', '-A']);
    runGitSync(blockerRun.worktreePath, ['commit', '-m', 'A work']);
    h.store.update(
      blocker.meta.id,
      { status: 'in-review' },
      new Date().toISOString()
    );
    h.cache.rebuild(h.store);

    const dependent = h.store.create({
      title: 'B',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe(blockerRun.branch);
    expect(meta.stackParents).toEqual([blockerRun.branch]);
    // The dependent's worktree must actually contain the blocker's work.
    expect(await Bun.file(join(meta.worktreePath, 'a.txt')).text()).toBe('a');
  });

  it('falls back to the default base when the blocker is already done', async () => {
    const h = makeHarness();
    const blocker = h.store.create({ title: 'A', status: 'done' });
    const dependent = h.store.create({
      title: 'B',
      blockedBy: [blocker.meta.id],
    });
    h.cache.rebuild(h.store);

    const meta = await h.orchestrator.dispatch(dependent.meta.id, 'fake');
    expect(meta.baseBranch).toBe('main');
    expect(meta.stackParents ?? []).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && bun test test/orchestrator/stacked-dispatch.test.ts`
Expected: FAIL — the blocker-branch test asserts `baseBranch` equals the
blocker's branch but gets `main`.

- [ ] **Step 3: Add the RunMeta fields**

In `packages/server/src/orchestrator/types.ts`, inside `RunMeta` (after
`prUrl?: string;`):

```typescript
  // Branches this run's worktree was stacked on at dispatch time — the
  // in-review blockers whose unmerged work it needs. Empty/absent for an
  // unblocked run, which is based on the project's default branch as before.
  // The merge queue reads this to know which dependents to restack after a
  // blocker lands.
  stackParents?: string[];
  // The exact commit this run's worktree was branched from, resolved at
  // dispatch time. This is what says where the run's OWN commits begin, which
  // is the one fact both restack paths need once the base branch has been
  // rewritten out from under it: `git rebase --onto <newBase> <this> <branch>`
  // and jj's `roots(<this>..<branch>)`. Only set for stacked runs — an
  // unblocked run has nothing above its base to preserve.
  stackBaseCommit?: string;
  // Set when a run this one was stacked on gets discarded: the base this work
  // was written against was rejected by a human. Nothing is rewritten or
  // deleted — the run is flagged so the UI can surface it and the merge queue
  // can refuse it, and the human decides what to do.
  baseDiscarded?: boolean;
```

- [ ] **Step 4: Implement base resolution in `orchestrator.ts`**

Add the import and a `JjManager` field alongside the existing `worktrees` field
(`:76`):

```typescript
import { JjManager } from './jj.js';
```

```typescript
  private readonly jj: JjManager;
```

and in the constructor (`:94-96`):

```typescript
  constructor(private readonly ctx: OrchestratorContext) {
    this.worktrees = new WorktreeManager(ctx.rootDir);
    this.jj = new JjManager(ctx.rootDir);
  }
```

Add the private method:

```typescript
  /**
   * The ref a task's worktree should be branched from. An unblocked task uses
   * the project's default base, exactly as before. A task whose blockers are
   * still unmerged is branched off *their* branches instead, so the agent can
   * see the work it depends on — that is the whole point of letting a
   * dependent start while its blocker is only `in-review`.
   *
   * Only `in-review` blockers matter here: a done/cancelled blocker's work is
   * already in the base branch, and an `in-progress` blocker means the task
   * isn't dispatchable at all (see core's dispatchableTasks).
   *
   * Two or more unmerged blockers need a base containing all of their work,
   * which only jj can express (`jj new -r A -r B`). When jj isn't available
   * the task falls back to the default base rather than silently picking one
   * blocker and dropping the other's work.
   */
  private async resolveBase(
    task: TaskDoc
  ): Promise<{ base: string; stackParents: string[] }> {
    const defaultBase = this.worktrees.defaultBaseBranch();
    const parents: string[] = [];
    for (const blockerId of task.meta.blockedBy) {
      const blocker = this.ctx.store.get(blockerId);
      if (blocker === null || blocker.meta.status !== 'in-review') continue;
      const branch = this.branchForTask(blockerId);
      if (branch !== null) parents.push(branch);
    }

    if (parents.length === 0) return { base: defaultBase, stackParents: [] };
    if (parents.length === 1) {
      return { base: parents[0]!, stackParents: parents };
    }

    const wasColocated = await this.jj.isColocated();
    if (!(await this.jj.ensureColocated())) {
      // No jj: no way to build a multi-parent base. Fall back rather than
      // dropping a blocker's work on the floor.
      this.appendTaskActivity(
        task.meta.id,
        `stacked dispatch: ${parents.length} unmerged blockers need a multi-parent base, but jj is unavailable — using ${defaultBase}`
      );
      return { base: defaultBase, stackParents: [] };
    }
    if (!wasColocated) {
      // Converting a user's repo is never silent — §4.2 of the spec.
      this.appendTaskActivity(
        task.meta.id,
        'stacked dispatch: converted this repository to a colocated jj repo (reversible with `jj git colocation disable`)'
      );
    }
    const bookmark = `dispatch/stack-base-${task.meta.id}`;
    const base = await this.jj.mergeBase(parents, bookmark);
    return { base, stackParents: parents };
  }

  // Appends one Activity line to a task, mirroring EpicEngine's
  // appendEpicActivity (epic.ts:312) so stack decisions leave the same durable
  // trail every other orchestrator lifecycle event does.
  private appendTaskActivity(taskId: string, text: string): void {
    const now = new Date().toISOString();
    this.ctx.store.update(taskId, { appendActivity: `${now} ${text}` }, now);
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
  }

  // The branch of a task's most recent terminal, unreviewed run — the branch
  // that actually holds its unmerged work. Returns null when the task has no
  // such run (never dispatched, or already merged/discarded), in which case
  // there is nothing to stack on.
  private branchForTask(taskId: string): string | null {
    const candidates = this.registry
      .list()
      .filter(
        (r) =>
          r.taskId === taskId &&
          TERMINAL_RUN_STATES.has(r.state) &&
          r.reviewedAt === undefined
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return candidates[0]?.branch ?? null;
  }
```

Then change `dispatch()` to be async and use it. Replace line `:177`:

```typescript
const { base: baseBranch, stackParents } = await this.resolveBase(task);
```

and add `stackParents` to the `RunMeta` literal (`:191-203`), only when
non-empty so unblocked runs keep an identical shape:

```typescript
      model: opts.model,
      ...(stackParents.length > 0
        ? {
            stackParents,
            stackBaseCommit: this.worktrees.resolveCommit(baseBranch),
          }
        : {}),
```

`resolveCommit` is a small addition to `WorktreeManager` (add it in Task 4
alongside the other new methods):

```typescript
  // The commit a ref currently points at, in the main checkout. Used to pin
  // down what a stacked run was branched from at the moment it was created —
  // branch refs move, commit shas don't.
  resolveCommit(ref: string): string {
    const result = runGit(this.mainRepoDir, ['rev-parse', '--verify', ref]);
    if (!result.ok) {
      throw new Error(`unable to resolve ${ref}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }
```

Change the signature to:

```typescript
  async dispatch(
    taskId: string,
    executorName: string,
    opts: { model?: string } = {}
  ): Promise<RunMeta> {
```

- [ ] **Step 5: Update the two call sites**

In `packages/server/src/api.ts:305`:

```typescript
  const meta = await ctx.orchestrator.dispatch(taskId, executorName, {
```

(the enclosing handler is already `async`).

In `packages/server/src/orchestrator/epic.ts`, make `fillQueue` async and await
the dispatch, preserving the conflict-skip:

```typescript
  private async fillQueue(epicId: string): Promise<void> {
    // ... unchanged up to the loop ...
    for (const task of ready) {
      if (slots <= 0) break;
      try {
        await this.ctx.orchestrator.dispatch(task.meta.id, session.executor);
        slots--;
      } catch (err) {
        if (err instanceof OrchestratorConflictError) continue;
        throw err;
      }
    }
  }
```

Its three callers (`start()` at `:129`, and `reactAcrossSessions()` at `:215`)
become `void this.fillQueue(epicId);`. **Exception:** `start()` must keep its
existing try/catch behavior of deleting the session when the initial dispatch
throws (`:130-137`), so there it becomes:

```typescript
this.appendEpicActivity(
  epicId,
  `epic dispatch started (concurrency ${concurrency})`
);
await this.fillQueue(epicId);
```

which makes `start()` async — update `api.ts`'s `startEpic` (`:533`) to await
it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/server && bun test test/orchestrator/` Expected: PASS,
including the pre-existing epic and api tests (they exercise the now-async
dispatch path).

- [ ] **Step 7: Verify and commit**

```bash
export AGENT=1
bun run format && bun run lint
cd packages/server && bun run tsc && cd ..
git add packages/server/src/orchestrator/orchestrator.ts packages/server/src/orchestrator/types.ts packages/server/src/orchestrator/epic.ts packages/server/src/api.ts packages/server/test/orchestrator/stacked-dispatch.test.ts
git commit -m "feat(orchestrator): branch dependents off their blocker's branch

A task dispatched while its blocker is only in-review needs to see that
blocker's unmerged work, so its worktree is now cut from the blocker's
branch instead of the default base. Threading the result through the
existing baseBranch field makes the run's diff base, the merge-queue
rebase target, and gh pr create --base all stack-aware without any of
them knowing stacks exist.

Two or more unmerged blockers need a multi-parent base, which only jj can
express; without jj the task falls back to the default base rather than
silently dropping a blocker's work."
```

---

### Task 6: Merge-queue restack

**Files:**

- Modify: `packages/server/src/orchestrator/mergeQueue.ts:393-452` (`process`,
  `rebase`), plus a new `restackDependents`
- Test: `packages/server/test/merge-queue.test.ts`

**Interfaces:**

- Consumes: `JjManager.isColocated/restack/restackOnto` (Task 3);
  `WorktreeManager.writeBackupRef/resyncToBranch/rebaseOnto` (Task 4);
  `RunMeta.stackBaseCommit` (Task 5); `RunMeta.stackParents` (Task 5)
- Produces: `MergeQueue.restackDependents(merged: RunMeta): Promise<void>`
  (private)

**Context:** `nextEligible()` (`:367`) stays exactly as-is — `isDone`-gated
ordering is what guarantees a blocker merges before its dependent.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/merge-queue.test.ts`, following that file's
existing harness:

```typescript
it('restacks a dependent run after its blocker merges, and resyncs its worktree', async () => {
  const h = makeHarness();
  // A: blocker, finished and unreviewed. B: dependent, based on A's branch.
  const { blockerRun, dependentRun } = await makeStackedPair(h);

  const dependentTipBefore = runGitSync(h.repo, [
    'rev-parse',
    dependentRun.branch,
  ]).trim();

  h.queue.enqueue(blockerRun.id);
  await waitFor(() =>
    h.queue.snapshot().history.some((e) => e.state === 'merged')
  );

  // The dependent's branch must have moved (restacked onto the new base)...
  const dependentTipAfter = runGitSync(h.repo, [
    'rev-parse',
    dependentRun.branch,
  ]).trim();
  expect(dependentTipAfter).not.toBe(dependentTipBefore);

  // ...its worktree must be reattached to that branch, not left detached...
  expect(
    runGitSync(dependentRun.worktreePath, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]).trim()
  ).toBe(dependentRun.branch);

  // ...it must now contain the blocker's merged work...
  expect(
    await Bun.file(join(dependentRun.worktreePath, 'a.txt')).exists()
  ).toBe(true);

  // ...it must still contain its own work...
  expect(
    await Bun.file(join(dependentRun.worktreePath, 'b.txt')).exists()
  ).toBe(true);

  // ...and its baseBranch must be repointed off the now-merged blocker branch.
  const updated = h.orchestrator.list().find((r) => r.id === dependentRun.id)!;
  expect(updated.baseBranch).not.toBe(blockerRun.branch);
});

it('writes a backup ref before restacking a dependent', async () => {
  const h = makeHarness();
  const { blockerRun, dependentRun } = await makeStackedPair(h);
  const tipBefore = runGitSync(h.repo, [
    'rev-parse',
    dependentRun.branch,
  ]).trim();

  h.queue.enqueue(blockerRun.id);
  await waitFor(() =>
    h.queue.snapshot().history.some((e) => e.state === 'merged')
  );

  const backups = runGitSync(h.repo, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/dispatch/backup',
  ]);
  expect(backups).toContain(dependentRun.id);
  expect(backups).toContain(tipBefore);
});

// The path every non-jj project actually runs. Must be tested independently:
// the jj path above passing tells you nothing about this one.
it('restacks via plain git when jj is unavailable', async () => {
  const h = makeHarness({
    // Force the no-jj branch: `jj --version` and colocation checks both fail,
    // exactly as they would with the binary absent from PATH.
    runner: (cwd: string, cmd: string[]) =>
      cmd[0] === 'jj'
        ? Promise.resolve({ ok: false, stdout: '', stderr: 'jj: not found' })
        : defaultCommandRunner(cwd, cmd),
  });
  const { blockerRun, dependentRun } = await makeStackedPair(h);

  h.queue.enqueue(blockerRun.id);
  await waitFor(() =>
    h.queue.snapshot().history.some((e) => e.state === 'merged')
  );

  // Same user-visible outcome as the jj path: dependent restacked, worktree
  // reattached, both the blocker's and its own work present, exactly once.
  expect(
    runGitSync(dependentRun.worktreePath, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]).trim()
  ).toBe(dependentRun.branch);
  expect(
    await Bun.file(join(dependentRun.worktreePath, 'a.txt')).exists()
  ).toBe(true);
  expect(
    await Bun.file(join(dependentRun.worktreePath, 'b.txt')).exists()
  ).toBe(true);

  // The blocker's commit must appear ONCE in the dependent's history — a bare
  // `git rebase <base>` instead of `--onto` would duplicate or conflict on it.
  const log = runGitSync(dependentRun.worktreePath, ['log', '--oneline']);
  expect(log.split('\n').filter((l) => l.includes('A work'))).toHaveLength(1);
});
```

`makeHarness` in this file will need to accept an optional `runner` so the test
can inject the jj-less CommandRunner; thread it through to the `MergeQueue`
constructor's second argument, which already takes one.

Add a `makeStackedPair(h)` helper to the file that dispatches A, commits `a.txt`
in its worktree, moves A to `in-review`, then dispatches B (which Task 5 bases
on A's branch) and commits `b.txt` in B's worktree. Return both `RunMeta`s.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && bun test test/merge-queue.test.ts` Expected: FAIL —
the dependent's branch tip is unchanged; nothing restacks it.

- [ ] **Step 3: Implement the restack in `mergeQueue.ts`**

Add a `JjManager` to the class, constructed from `ctx.rootDir` alongside the
existing runner:

```typescript
import { JjManager } from './jj.js';
```

```typescript
  private readonly jj: JjManager;

  constructor(
    private readonly ctx: MergeQueueContext,
    private readonly run: CommandRunner = defaultCommandRunner
  ) {
    this.jj = new JjManager(ctx.rootDir, run);
    // ... existing body unchanged ...
  }
```

Add the restack method:

```typescript
  /**
   * After `mergedBranch` lands, brings every run stacked on it back onto
   * `newBase`. Two paths, same outcome:
   *
   * Both paths replay ONLY the commits the dependent itself added — the range
   * above `stackBaseCommit`, the commit it was branched from. Neither may
   * replay the whole branch: by this point the blocker has been squash-merged,
   * so its commits are already in the new base in squashed form, and replaying
   * them duplicates the work (measured: `jj rebase -b` reports "Rebased 2
   * commits" where only one is the dependent's — see
   * `.agents/ignore/spikes/jj-spike4.sh`).
   *
   * - jj: `jj rebase -s roots(base..branch) -d <newBase> --skip-emptied`
   * - plain git: `git rebase --onto <newBase> <stackBaseCommit> <branch>`
   *
   * Only runs in a terminal state are touched — a live agent's worktree is
   * never rewritten underneath it. Every dependent's tip is backed up first as
   * the undo path.
   */
  private async restackDependents(merged: RunMeta): Promise<void> {
    const mergedBranch = merged.branch;
    const newBase = merged.baseBranch;
    const dependents = this.ctx.orchestrator
      .list()
      .filter(
        (r) =>
          r.stackParents?.includes(mergedBranch) === true &&
          TERMINAL_RUN_STATES.has(r.state) &&
          r.reviewedAt === undefined
      );
    if (dependents.length === 0) return;

    const viaJj = await this.jj.isColocated();
    // Which path a restack took decides how to read a later failure, so record
    // it once per merge rather than leaving it to be inferred.
    const now = new Date().toISOString();
    this.ctx.store.update(
      merged.taskId,
      {
        appendActivity: `${now} merge queue: restacking ${dependents.length} dependent run(s) via ${viaJj ? 'jj' : 'git rebase --onto'}`,
      },
      now
    );
    for (const dependent of dependents) {
      // Backup first — this is the undo path if the restack goes wrong. It is
      // NOT the rebase boundary: that is stackBaseCommit, recorded at dispatch.
      this.ctx.orchestrator.backupRunBranch(dependent.id);
      const stackBase = dependent.stackBaseCommit;
      if (stackBase === undefined) {
        // Nothing records where this run's own commits begin, so neither path
        // can safely replay them. Flag rather than guess.
        this.ctx.orchestrator.flagRunRestackFailure(
          dependent.id,
          'cannot restack: no stackBaseCommit recorded for this run'
        );
        continue;
      }
      try {
        if (viaJj) {
          await this.jj.restackOnto(dependent.branch, stackBase, newBase);
        } else {
          this.ctx.orchestrator.rebaseRunOnto(dependent.id, newBase, stackBase);
        }
        this.ctx.orchestrator.resyncRunWorktree(dependent.id);
        this.ctx.orchestrator.repointRunBase(dependent.id, newBase);
      } catch (err) {
        // A dependent that can't be restacked is not a reason to fail the
        // entry that just merged successfully — record it on the run and let
        // the human sort it out, exactly like a discarded base (§4.5).
        this.ctx.orchestrator.flagRunRestackFailure(
          dependent.id,
          (err as Error).message
        );
      }
    }
  }
```

Call it at the end of `process()` after a successful merge — replace the
`this.finish(entry, 'merged');` line in the try block:

```typescript
    try {
      await this.rebase(entry, meta);
      await this.verify(entry, meta);
      await this.merge(entry, meta);
      await this.restackDependents(meta);
      this.finish(entry, 'merged');
    } catch (err) {
```

And switch `rebase()` (`:428`) to the jj path when available, so descendants
follow automatically. Insert at the top of `rebase()`, after the
`entry.state`/`broadcast` lines:

```typescript
if (await this.jj.isColocated()) {
  const target =
    meta.prUrl !== undefined ? `origin/${meta.baseBranch}` : meta.baseBranch;
  if (meta.prUrl !== undefined) {
    const fetch = await this.run(cwd, [
      'git',
      'fetch',
      'origin',
      meta.baseBranch,
    ]);
    if (!fetch.ok) {
      throw new Error(`git fetch failed: ${commandErrorText(fetch)}`);
    }
  }
  await this.jj.restack(meta.branch, target);
  return;
}
```

leaving the existing git path below it untouched as the fallback.

- [ ] **Step 4: Add the orchestrator helpers the queue calls**

These live on `Orchestrator` because it owns the registry and the
`WorktreeManager`; the queue must not reach into either directly. Add to
`packages/server/src/orchestrator/orchestrator.ts`:

```typescript
  // Backs up a run's branch tip before something rewrites it, returning the
  // saved sha (or null when there's nothing to back up).
  backupRunBranch(runId: string): string | null {
    const meta = this.registry.get(runId);
    if (meta === undefined) return null;
    return this.worktrees.writeBackupRef(meta.branch, runId);
  }

  // Replays a run's own commits (everything after `oldTip`) onto `newBase`.
  rebaseRunOnto(runId: string, newBase: string, oldTip: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    this.worktrees.rebaseOnto(meta.worktreePath, newBase, oldTip, meta.branch);
  }

  // Reattaches a run's worktree to its branch after a restack left it
  // detached. Refuses while the run is still live — never rewrite a working
  // copy an agent is using.
  resyncRunWorktree(runId: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined || !TERMINAL_RUN_STATES.has(meta.state)) return;
    this.worktrees.resyncToBranch(meta.worktreePath, meta.branch);
  }

  // Moves a run off a base branch that has now been merged away, and drops
  // that branch from its recorded stack parents.
  repointRunBase(runId: string, newBase: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    const remaining = (meta.stackParents ?? []).filter((b) => b !== meta.baseBranch);
    this.registry.updateMeta(runId, {
      baseBranch: newBase,
      stackParents: remaining.length > 0 ? remaining : undefined,
    });
    this.ctx.events.broadcast({ type: 'run.changed' });
  }

  // Records that a dependent could not be restacked after its base merged.
  // Reuses the baseDiscarded flag's "a human needs to look at this" meaning
  // rather than inventing a second flag for the same UI treatment.
  flagRunRestackFailure(runId: string, reason: string): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    this.registry.updateMeta(runId, { baseDiscarded: true, error: reason });
    this.ctx.events.broadcast({ type: 'run.changed' });
  }
```

Signatures these rely on, already present in the codebase:
`RunRegistry.updateMeta(id: string, patch: Partial<RunMeta>): RunMeta | undefined`
(`registry.ts:56`), and the payload-free `{ type: 'run.changed' }` variant
(`events.ts:18`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/server && bun test test/merge-queue.test.ts` Expected: PASS.

- [ ] **Step 6: Run the whole server suite**

Run: `cd packages/server && bun test` Expected: PASS — in particular the
existing merge-queue tests, which must still pass unchanged since the git path
is preserved as the fallback.

- [ ] **Step 7: Verify and commit**

```bash
export AGENT=1
bun run format && bun run lint
cd packages/server && bun run tsc && cd ..
git add packages/server/src/orchestrator/mergeQueue.ts packages/server/src/orchestrator/orchestrator.ts packages/server/test/merge-queue.test.ts
git commit -m "feat(orchestrator): restack dependents when their blocker merges

Once a dependent is branched off its blocker, landing the blocker leaves
that dependent sitting on a branch whose commits are now in the base in
squashed form. Under jj the rebase of the blocker already restacked every
descendant, so only the worktrees need reattaching; without jj each
dependent's own commits are replayed with an explicit rebase --onto, using
the backup ref as the boundary. A dependent that can't be restacked is
flagged for a human rather than failing the merge that just succeeded."
```

---

### Task 7: Flag dependents when their base is discarded

**Files:**

- Modify: `packages/server/src/orchestrator/orchestrator.ts:530-545` (the
  discard branch of `review`)
- Modify: `packages/server/src/orchestrator/mergeQueue.ts:393-407` (`process`
  guard)
- Test: `packages/server/test/merge-queue.test.ts`,
  `packages/server/test/orchestrator/stacked-dispatch.test.ts`

**Interfaces:**

- Consumes: `RunMeta.baseDiscarded` (Task 5), `flagRunRestackFailure` (Task 6)
- Produces: no new exports

- [ ] **Step 1: Write the failing tests**

In `stacked-dispatch.test.ts`:

```typescript
it('flags dependents when the run they were stacked on is discarded', async () => {
  const h = makeHarness();
  const { blockerRun, dependentRun } = await makeStackedPair(h);

  h.orchestrator.review(blockerRun.id, 'discard');

  const dependent = h.orchestrator
    .list()
    .find((r) => r.id === dependentRun.id)!;
  expect(dependent.baseDiscarded).toBe(true);
  // Nothing is destroyed: the worktree and branch are untouched.
  expect(await Bun.file(join(dependent.worktreePath, 'b.txt')).exists()).toBe(
    true
  );
});
```

In `merge-queue.test.ts`:

```typescript
it('refuses to merge a run whose base was discarded', async () => {
  const h = makeHarness();
  const { blockerRun, dependentRun } = await makeStackedPair(h);
  h.orchestrator.review(blockerRun.id, 'discard');

  h.queue.enqueue(dependentRun.id);
  await waitFor(() =>
    h.queue.snapshot().history.some((e) => e.state === 'failed')
  );

  const entry = h.queue
    .snapshot()
    .history.find((e) => e.runId === dependentRun.id)!;
  expect(entry.reason).toContain('base');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`cd packages/server && bun test test/orchestrator/stacked-dispatch.test.ts test/merge-queue.test.ts`
Expected: FAIL — `baseDiscarded` is undefined; the queue merges the dependent
happily.

- [ ] **Step 3: Flag dependents on discard**

In `orchestrator.ts`, in the discard branch of `review()` (around `:540` where
the task is returned to `'todo'`), after the existing bookkeeping:

```typescript
// Anything stacked on this run was written against a base a human just
// rejected. Flag it and change nothing else: the dependent's work may
// still be good, and that judgement is the human's, not ours.
for (const dependent of this.registry.list()) {
  if (dependent.stackParents?.includes(meta.branch) !== true) continue;
  if (dependent.reviewedAt !== undefined) continue;
  this.registry.updateMeta(dependent.id, { baseDiscarded: true });
}
```

- [ ] **Step 4: Guard the merge queue**

In `mergeQueue.ts`'s `process()`, alongside the existing `reviewedAt` guard
(`:403`):

```typescript
if (meta.baseDiscarded === true) {
  entry.reason =
    'the run this one was stacked on was discarded — rebase it onto a valid base before merging';
  this.finish(entry, 'failed');
  return;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
`cd packages/server && bun test test/orchestrator/stacked-dispatch.test.ts test/merge-queue.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
export AGENT=1
bun run format && bun run lint
cd packages/server && bun run tsc && cd ..
git add packages/server/src/orchestrator/orchestrator.ts packages/server/src/orchestrator/mergeQueue.ts packages/server/test/orchestrator/stacked-dispatch.test.ts packages/server/test/merge-queue.test.ts
git commit -m "feat(orchestrator): flag dependents when their base is discarded

Discarding a run means a human rejected the work a dependent was built
on. The dependent is flagged and otherwise left completely alone — its
worktree, branch, and any in-flight work survive — and the merge queue
refuses it until a human resolves the base. Auto-rebasing it onto the
default branch would silently strip the code it was written against."
```

---

### Task 8: Surface stack state in the desktop UI

**Files:**

- Modify: `apps/desktop/src/components/runs/RunReviewView.tsx`
- Modify: `apps/desktop/src/components/tasks/StackRail.tsx`
- Modify: `packages/client/src/api.ts` (RunMeta type mirror)
- Test: `apps/desktop/src/lib/taskGraph.test.ts` (or a co-located component
  test, matching the app's existing pattern)

**Interfaces:**

- Consumes: `RunMeta.stackParents`, `RunMeta.baseDiscarded` (Task 5)
- Produces: no new exports

- [ ] **Step 1: Mirror the new fields in the client type**

In `packages/client/src/api.ts`, find the `RunMeta` interface mirror and add:

```typescript
  stackParents?: string[];
  baseDiscarded?: boolean;
```

- [ ] **Step 2: Show "stacked on" in the review header**

In `RunReviewView.tsx`, where the run's branch/base is already displayed, render
a chip when `run.stackParents` is non-empty:

```tsx
{
  run.stackParents !== undefined && run.stackParents.length > 0 ? (
    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      stacked on{' '}
      {run.stackParents.length === 1
        ? run.stackParents[0]
        : `${run.stackParents.length} branches`}
    </span>
  ) : null;
}
```

Match the surrounding chip markup in that file rather than copying these classes
verbatim if it already has a chip component.

- [ ] **Step 3: Show the discarded-base warning**

In the same header, when `run.baseDiscarded === true`:

```tsx
{
  run.baseDiscarded === true ? (
    <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-900 dark:bg-red-950 dark:text-red-200">
      base discarded — rebase before merging
    </span>
  ) : null;
}
```

- [ ] **Step 4: Verify in the running app**

Run the desktop app and confirm a stacked run shows the chip and a run whose
base was discarded shows the warning. Use the `run` skill if you need the launch
procedure for this project.

- [ ] **Step 5: Verify and commit**

```bash
export AGENT=1
bun run format && bun run lint
cd apps/desktop && bun run tsc && cd ../..
git add apps/desktop/src packages/client/src/api.ts
git commit -m "feat(desktop): surface stacked-on and discarded-base run state

A stacked run's diff reads against its blocker's branch rather than main,
which is confusing without saying so. The discarded-base warning marks the
runs the merge queue will now refuse."
```

---

## Verification Baseline

Before considering the plan complete, from the monorepo root:

```bash
export AGENT=1
bun run format
bun run lint
cd packages/core && bun run tsc && bun test && cd ../..
cd packages/server && bun run tsc && bun test && cd ../..
cd apps/desktop && bun run tsc && cd ../..
```

All must pass. `bun run lint` reports pre-existing warnings in test files and
**0 errors**; errors are never acceptable. Do not treat the warning count as a
fixed number — record `bun run lint` output at your branch point and compare
against that, since other work lands on this repo concurrently.

## Manual End-to-End Check

The behavior this plan exists to fix, verified by hand in the running app:

1. Create tasks A and B in an epic, with B blocked by A.
2. Start the epic dispatch session. Only A dispatches.
3. Let A's run finish. A moves to `in-review` — **not** `done`.
4. **B must dispatch automatically at this point.** This is the reported bug.
5. Open B's run and confirm its worktree contains A's changes, and its review
   header shows "stacked on `dispatch/<A>…`".
6. Enqueue A in the merge queue. After it merges, confirm B's branch was
   restacked (B's diff no longer shows A's changes as its own) and B's worktree
   is on its branch, not detached.
7. Repeat steps 1-6 in a plain-git project with `jj` renamed off `PATH`,
   confirming the fallback produces the same user-visible outcome.
