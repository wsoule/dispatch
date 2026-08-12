import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import {
  diffSnapshotPath,
  runsDir,
  transcriptPath,
  worktreesDir,
} from '../../src/orchestrator/paths.js';
import {
  replayTranscript,
  Transcript,
} from '../../src/orchestrator/transcript.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
  RunMeta,
} from '../../src/orchestrator/types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../../src/orchestrator/types.js';
import { initGitRepo, runGitSync } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo();
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// Waits for `check` to return true, polling — the orchestrator's FakeExecutor
// runs its script asynchronously (fire-and-forget from dispatch/sendMessage),
// so tests must wait for state to settle rather than asserting immediately.
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function makeOrchestrator(rootDir: string): {
  orchestrator: Orchestrator;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
} {
  const store = TaskStore.init(rootDir);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({ rootDir, store, cache, events });
  return { orchestrator, store, cache, events };
}

describe('Orchestrator.dispatch full lifecycle', () => {
  it('provisions a worktree, runs the script, and writes Activity/status on both ends', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'done\n');
            },
            commitMessage: 'agent: add feature',
          },
        ],
        finish: { state: 'finished', costUsd: 1.23, turns: 4 },
      })
    );
    const task = store.create({ title: 'Add feature' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    // A no-approval FakeExecutor script runs synchronously to completion
    // inside `start()` (no `await` point until an approval gate), so by the
    // time `dispatch()` returns the run may already be 'finished' — only a
    // real streaming executor would still be mid-flight here. Either way,
    // `waitFor` below settles on the final state.
    expect(existsSync(meta.worktreePath)).toBe(true);

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const finishedTask = store.get(task.meta.id)!;
    expect(finishedTask.meta.status).toBe('in-review');
    expect(finishedTask.body).toContain(
      `dispatched (fake, branch ${meta.branch})`
    );
    expect(finishedTask.body).toMatch(
      /\[run r-[0-9a-f]{6}\] finished: finished — 1 files, \$1\.23/
    );

    const replay = orchestrator.getRun(meta.id)!;
    expect(replay.meta.costUsd).toBe(1.23);
    expect(replay.meta.turns).toBe(4);
  });
});

// A derived task's body is a stranger's prose (a PR description), and an
// execute run acts on its body with write access off trunk. An execute run has
// two doors — dispatch() for a board dispatch, dispatchAuxRun({kind:'execute'})
// for the fix loop's fresh implementer — and both are covered below.
describe('Orchestrator execute runs on a derived task', () => {
  it('refuses to execute a task synthesized from someone else’s artifact', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({
      title: 'Review PR #7: Bump deps',
      derivedFrom: 'github-pr:7',
    });

    await expect(orchestrator.dispatch(task.meta.id, 'fake')).rejects.toThrow(
      OrchestratorClientError
    );
    // Refused before anything existed: no run, and the task untouched.
    expect(orchestrator.list()).toEqual([]);
    expect(store.get(task.meta.id)!.meta.status).toBe('todo');
  });

  // The other door. FixLoop's fresh-implementer step goes through
  // dispatchAuxRun with kind 'execute', which is not dispatch() and would
  // otherwise slip past the refusal above.
  it('refuses an execute-kind aux run on the same task', () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({
      title: 'Review PR #7: Bump deps',
      derivedFrom: 'github-pr:7',
    });

    // Thrown, not rejected: dispatchAuxRun's guards run synchronously (it is
    // the caller's own `await` that turns this into a rejection).
    expect(() =>
      orchestrator.dispatchAuxRun({
        taskId: task.meta.id,
        kind: 'execute',
        head: 'HEAD',
        executor: 'fake',
        buildPrompt: () => 'go fix it',
      })
    ).toThrow(OrchestratorClientError);
    // Refused before the worktree: an execute run's branch would also escape
    // cleanupDerivedAuxRun, which only handles non-execute kinds.
    expect(orchestrator.list()).toEqual([]);
  });

  it('still lets a review run start against the same task', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({
      title: 'Review PR #7: Bump deps',
      derivedFrom: 'github-pr:7',
    });

    const meta = await orchestrator.dispatchAuxRun({
      taskId: task.meta.id,
      kind: 'review',
      head: 'HEAD',
      executor: 'fake',
      buildPrompt: () => 'review it',
    });
    expect(meta.kind).toBe('review');
  });
});

describe('Orchestrator approval round-trip', () => {
  it('pauses at awaiting-approval and resumes once approved', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            approval: {
              requestId: 'req-1',
              toolName: 'edit_file',
              input: { path: 'x' },
            },
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Needs approval' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    orchestrator.approve(meta.id, 'req-1', true);
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('finished');
  });
});

describe('Orchestrator.cancel', () => {
  it('interrupts a live run and marks it cancelled without closing the task', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'never', toolName: 't', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Cancel me' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );
    await orchestrator.cancel(meta.id);

    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('cancelled');
    // M2: task status is deliberately left alone (a cancelled run says
    // nothing about whether the task itself should move), but the
    // cancellation is still recorded as a durable Activity line.
    expect(store.get(task.meta.id)!.meta.status).toBe('in-progress');
    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] cancelled`
    );
  });
});

// Builds a controllable Executor whose `start()` never calls
// onFinish/onApprovalRequest on its own — the run sits in `running` until
// the test itself decides it's done observing, exactly the same shape
// plan-epic-api.test.ts's HTTP-level inject tests use, just constructed
// directly here for the orchestrator's own unit tests. `sent` collects
// every `executorRun.send()` call so a test can assert on the exact text
// (prefixed or not) the executor actually received.
function controllableExecutor(sent: string[]): Executor {
  return {
    start(_opts: ExecutorStartOptions, _events: ExecutorEvents): ExecutorRun {
      return {
        interrupt: async () => {},
        requestStop: () => {},
        send: (message: string) => sent.push(message),
        approve: () => {},
      };
    },
  };
}

describe('Orchestrator.sendMessage (mid-run message)', () => {
  it('records a from:user message entry and forwards the raw text to the executor', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const sent: string[] = [];
    orchestrator.registerExecutor('fake', controllableExecutor(sent));
    const task = store.create({ title: 'Talk to me' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    orchestrator.sendMessage(meta.id, 'hello agent');

    const entries = orchestrator.getRun(meta.id)!.entries;
    const messageEntry = entries.find((e) => e.kind === 'message');
    expect(messageEntry).toMatchObject({
      kind: 'message',
      from: 'user',
      text: 'hello agent',
    });
    // sendMessage never prefixes — that's inject's job for the
    // agent-to-agent channel, not the human-to-agent one.
    expect(sent).toEqual(['hello agent']);
  });
});

describe('Orchestrator.inject sender identity', () => {
  it("resolves fromRunId to the sender run's task title + id label", async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const sent: string[] = [];
    orchestrator.registerExecutor('fake', controllableExecutor(sent));

    const senderTask = store.create({ title: 'Sender task' });
    const senderMeta = await orchestrator.dispatch(senderTask.meta.id, 'fake');
    const targetTask = store.create({ title: 'Target task' });
    const targetMeta = await orchestrator.dispatch(targetTask.meta.id, 'fake');

    orchestrator.inject(targetMeta.id, 'need a hand', {
      runId: senderMeta.id,
    });

    const entries = orchestrator.getRun(targetMeta.id)!.entries;
    const messageEntry = entries.find((e) => e.kind === 'message');
    expect(messageEntry).toMatchObject({
      kind: 'message',
      from: 'agent',
      fromLabel: `Sender task (${senderMeta.id})`,
      text: 'need a hand',
    });
    // An inbound agent->agent message is NOT a user-flag — the app relies on
    // `toUser` being absent here to render it as "↳ <sender>" rather than a
    // "To you" attention row.
    expect(messageEntry?.toUser).toBeUndefined();
    expect(sent).toEqual([
      `[message from Sender task (${senderMeta.id})] need a hand`,
    ]);
  });

  it('falls back to the generic "another agent" label when fromRunId is omitted', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const sent: string[] = [];
    orchestrator.registerExecutor('fake', controllableExecutor(sent));
    const task = store.create({ title: 'Target task' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    orchestrator.inject(meta.id, 'hello');

    const entries = orchestrator.getRun(meta.id)!.entries;
    const messageEntry = entries.find((e) => e.kind === 'message');
    expect(messageEntry).toMatchObject({
      kind: 'message',
      from: 'agent',
      fromLabel: 'another agent',
      text: 'hello',
    });
    expect(sent).toEqual(['[message from another agent] hello']);
  });

  it('falls back to the generic label when fromRunId does not match a known run', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const sent: string[] = [];
    orchestrator.registerExecutor('fake', controllableExecutor(sent));
    const task = store.create({ title: 'Target task' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    orchestrator.inject(meta.id, 'hello', { runId: 'r-nonexistent' });

    const entries = orchestrator.getRun(meta.id)!.entries;
    const messageEntry = entries.find((e) => e.kind === 'message');
    expect(messageEntry?.fromLabel).toBe('another agent');
  });
});

describe('Orchestrator.messageUser', () => {
  it("records a from:agent entry on the run's own transcript labeled with its own task", async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const sent: string[] = [];
    orchestrator.registerExecutor('fake', controllableExecutor(sent));
    const task = store.create({ title: 'Flag something' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    orchestrator.messageUser(meta.id, 'need clarification on X');

    const entries = orchestrator.getRun(meta.id)!.entries;
    const messageEntry = entries.find((e) => e.kind === 'message');
    expect(messageEntry).toMatchObject({
      kind: 'message',
      from: 'agent',
      fromLabel: `Flag something (${meta.id})`,
      // The discriminator that lets the app badge this agent->user flag
      // apart from an inbound agent->agent message (which never sets it).
      toUser: true,
      text: 'need clarification on X',
    });
    // messageUser never delivers into the executor — there is no recipient
    // beyond the human reading this run's own Session tab.
    expect(sent).toEqual([]);
  });

  it('409s a run that is not running', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Already finished' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(() => orchestrator.messageUser(meta.id, 'too late')).toThrow(
      OrchestratorConflictError
    );
  });
});

describe('Orchestrator.recordEvidence / recordMutation', () => {
  it('round-trips a command and a mutation record through getRun', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Guard the sync path' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');

    const evidence = orchestrator.recordEvidence(meta.id, {
      command: 'bun test',
      exitCode: 0,
      durationMs: 4200,
      summary: '158 pass, 0 fail',
    });
    const mutation = orchestrator.recordMutation(meta.id, {
      guard: 'null check on foo()',
      file: 'src/foo.ts',
      testsFailed: 0,
    });

    expect(evidence.at).toBeTruthy();
    expect(mutation.at).toBeTruthy();

    const detail = orchestrator.getRun(meta.id)!;
    expect(detail.evidence).toEqual([evidence]);
    expect(detail.mutations).toEqual([mutation]);
  });

  // The live-registry path and the transcript-replay fallback (used after a
  // restart) must agree on what a run's evidence is.
  it('survives replay from the transcript after the registry forgets the run', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Guard the sync path' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    orchestrator.recordEvidence(meta.id, {
      command: 'bun run tsc',
      exitCode: 0,
      durationMs: 900,
      summary: 'no errors',
    });
    orchestrator.recordMutation(meta.id, {
      guard: 'reject on empty title',
      file: 'src/handler.ts',
      testsFailed: 2,
    });

    const replay = replayTranscript(transcriptPath(repo, meta.id))!;
    expect(replay.evidence).toEqual([
      expect.objectContaining({ command: 'bun run tsc' }),
    ]);
    expect(replay.mutations).toEqual([
      expect.objectContaining({ guard: 'reject on empty title' }),
    ]);
  });

  it('throws for an unknown run', () => {
    const { orchestrator } = makeOrchestrator(repo);
    expect(() =>
      orchestrator.recordEvidence('r-missing', {
        command: 'bun test',
        exitCode: 0,
        durationMs: 1,
        summary: 'ok',
      })
    ).toThrow(OrchestratorNotFoundError);
  });
});

describe('Orchestrator.sendMessage resume (request-changes)', () => {
  it('re-dispatches into the same worktree/branch after a finished run', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 'sess-1' } })
    );
    const task = store.create({ title: 'Resume me' });
    const first = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(first.id)?.meta.state === 'finished'
    );

    const second = orchestrator.sendMessage(first.id, 'please fix x', {
      resume: true,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.branch).toBe(first.branch);
    expect(second.worktreePath).toBe(first.worktreePath);

    // Like the no-approval script in the full-lifecycle test, this second
    // run can finish synchronously before `sendMessage` even returns, so
    // assert on the settled end state rather than an intermediate one.
    await waitFor(
      () => orchestrator.getRun(second.id)?.meta.state === 'finished'
    );
    expect(store.get(task.meta.id)!.meta.status).toBe('in-review');
    expect(store.get(task.meta.id)!.body).toContain(
      `requested changes (run ${second.id}): please fix x`
    );
  });

  it("records the user's message on the new run's transcript and links it back via resumedFrom", async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 'sess-1' } })
    );
    const task = store.create({ title: 'Keep the conversation' });
    const first = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(first.id)?.meta.state === 'finished'
    );

    const second = orchestrator.sendMessage(first.id, 'please fix x', {
      resume: true,
    });

    // Lineage: the follow-up run points back at the run it resumed, so the
    // UI can say where the earlier conversation lives.
    expect(second.resumedFrom).toBe(first.id);

    // Continuity: the follow-up transcript opens with the user's own
    // request-changes message rather than starting empty — same entry shape
    // the live-run sendMessage branch records.
    const entries = orchestrator.getRun(second.id)!.entries;
    expect(entries[0]).toMatchObject({
      kind: 'message',
      from: 'user',
      text: 'please fix x',
    });
  });

  // The other half of the truncated-run fix (see ClaudeExecutor's
  // truncated-run detection): once a session-limit stop is correctly recorded
  // as `failed` instead of `finished`, a gate that only admits `finished`
  // would refuse to resume exactly the runs that most need resuming — the
  // ones cut off mid-task with their work still on the branch. What actually
  // makes a run resumable is having a session nobody has closed out, not the
  // particular terminal state it landed in.
  it('resumes a run that FAILED with a session id (the truncated-run recovery path)', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    let starts = 0;
    orchestrator.registerExecutor('fake', {
      start(_opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
        starts += 1;
        // First start reproduces a usage-limit truncation: failed, but with a
        // real session id underneath it.
        if (starts === 1) {
          events.onFinish({
            state: 'failed',
            sessionId: 'sess-truncated',
            error: 'Claude usage limit reached before the agent finished',
          });
        }
        return {
          interrupt: async () => {},
          requestStop: () => {},
          send: () => {},
          approve: () => {},
        };
      },
    });
    const task = store.create({ title: 'Cut off by the limit' });
    const first = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(() => orchestrator.getRun(first.id)?.meta.state === 'failed');

    const second = orchestrator.sendMessage(first.id, 'keep going', {
      resume: true,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.sessionId).toBe('sess-truncated');
    expect(second.resumedFrom).toBe(first.id);
  });

  // A failed run with no session underneath it has nothing to resume into —
  // resuming would start a fresh agent while pretending to continue, so it
  // must refuse rather than silently restart from scratch.
  it('refuses to resume a failed run that never got a session id', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'failed', error: 'died early' } })
    );
    const task = store.create({ title: 'Nothing to resume' });
    const first = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(() => orchestrator.getRun(first.id)?.meta.state === 'failed');

    expect(() =>
      orchestrator.sendMessage(first.id, 'keep going', { resume: true })
    ).toThrow(/no resumable session/i);
  });

  // The model a run was dispatched with is part of how it behaves; a
  // follow-up that silently drops back to the SDK default is a different
  // agent answering the same conversation.
  it('carries the original run model onto the resumed run', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 'sess-1' } })
    );
    const task = store.create({ title: 'Keep my model' });
    const first = await orchestrator.dispatch(task.meta.id, 'fake', {
      model: 'claude-opus-5',
    });
    await waitFor(
      () => orchestrator.getRun(first.id)?.meta.state === 'finished'
    );
    expect(first.model).toBe('claude-opus-5');

    const second = orchestrator.sendMessage(first.id, 'please fix x', {
      resume: true,
    });

    expect(second.model).toBe('claude-opus-5');
  });

  // The triple-dispatch incident: a resume forks a new run into the SAME
  // worktree, so a duplicate resume (double-Enter, retry after a UI error)
  // must 409 exactly like dispatch() does — not silently start a second
  // agent racing the first one's edits.
  it('409s a resume while the task already has a live run', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    // Finishes the FIRST start (so the run becomes resumable), then hangs on
    // every later start — leaving the resumed follow-up run live.
    let starts = 0;
    orchestrator.registerExecutor('fake', {
      start(_opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
        starts += 1;
        if (starts === 1) {
          events.onFinish({ state: 'finished', sessionId: 'sess-1' });
        }
        return {
          interrupt: async () => {},
          requestStop: () => {},
          send: () => {},
          approve: () => {},
        };
      },
    });
    const task = store.create({ title: 'No duplicate resumes' });
    const first = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(first.id)?.meta.state === 'finished'
    );

    const second = orchestrator.sendMessage(first.id, 'please fix x', {
      resume: true,
    });
    expect(orchestrator.getRun(second.id)!.meta.state).toBe('running');

    expect(() =>
      orchestrator.sendMessage(first.id, 'please fix x again', {
        resume: true,
      })
    ).toThrow(OrchestratorConflictError);
    expect(() =>
      orchestrator.sendMessage(first.id, 'please fix x again', {
        resume: true,
      })
    ).toThrow(`task already has a live run: ${second.id}`);
  });
});

describe('Orchestrator.review merge', () => {
  it('squash-merges the branch into base, closes the task, and removes the worktree', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'merged.txt'), 'merged content\n');
            },
            commitMessage: 'agent: add merged.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Merge me' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'merge');

    expect(existsSync(join(repo, 'merged.txt'))).toBe(true);
    const log = runGitSync(repo, ['log', '-1', '--pretty=%s']).trim();
    expect(log).toBe(`dispatch: Merge me (run ${meta.id})`);
    expect(store.get(task.meta.id)!.meta.status).toBe('done');
    expect(existsSync(meta.worktreePath)).toBe(false);
  });

  it('stamps mergeCommit with the squash sha on merge and rehydrates it', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'x.txt'), 'work\n');
            },
            commitMessage: 'agent: add x.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Stamp mergeCommit' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const reviewed = orchestrator.review(meta.id, 'merge');
    const head = runGitSync(repo, ['rev-parse', 'HEAD']).trim();
    expect(reviewed.mergeCommit).toBe(head);

    const replayed = replayTranscript(transcriptPath(repo, meta.id))!.meta;
    expect(replayed.mergeCommit).toBe(head);
  });

  it('refuses with a conflict error when the main checkout is dirty', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Dirty main' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    writeFileSync(join(repo, 'uncommitted.txt'), 'oops\n');

    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(
      OrchestratorConflictError
    );
    expect(store.get(task.meta.id)!.meta.status).not.toBe('done');
  });

  // A bare "main checkout has uncommitted changes" sent users hunting: in the
  // real incident that motivated this, the sole offender was one stray
  // untracked zip at the repo root, and every merge-queue enqueue fast-failed
  // with no hint which file to deal with. The gate has the paths in hand from
  // `git status --porcelain` — it must say them.
  it('names the offending paths when refusing a dirty main checkout, including untracked files', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Dirty main names paths' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    writeFileSync(join(repo, 'stray-download.zip'), 'not source\n');

    try {
      orchestrator.review(meta.id, 'merge');
      throw new Error('expected the merge to be refused');
    } catch (err) {
      expect((err as Error).message).toContain('stray-download.zip');
    }
  });

  // Residual of Important #5 (fix-wave verification New-1): `git commit`
  // inside mergeSquash commits the whole index, so anything the user STAGED
  // before merging — including `.dispatch/` paths the dirty gate admits —
  // would silently ride into the squash commit. The merge must refuse.
  it('refuses when the main checkout index has staged changes, even under .dispatch/', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Staged index' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    writeFileSync(join(repo, '.dispatch', 'config.yml'), 'autoCommit: true\n');
    runGitSync(repo, ['add', '.dispatch/config.yml']);

    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(
      /staged changes/
    );
    expect(store.get(task.meta.id)!.meta.status).not.toBe('done');
    // The staged edit is still staged, untouched by the refused merge.
    const staged = runGitSync(repo, ['diff', '--cached', '--name-only']);
    expect(staged.trim()).toBe('.dispatch/config.yml');
  });
});

// C1/C4: the merge path's new ordering — verify the checkout is actually on
// `baseBranch` first, run the squash-merge before any task bookkeeping (so a
// failed merge never leaves a task marked done for work that never landed),
// recover the main checkout on a git failure instead of leaving it mid-merge,
// and stage only the run's own task file rather than the whole `.dispatch/`
// directory when folding bookkeeping into the squash commit.
describe('Orchestrator.review merge ordering and failure handling', () => {
  it('C4: refuses with a conflict error when main is checked out on a different branch, leaving everything untouched', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'hi\n');
            },
            commitMessage: 'agent: add feature.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Wrong branch checked out' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    expect(meta.baseBranch).toBe('main');

    runGitSync(repo, ['checkout', '-b', 'some-other-branch']);

    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(
      OrchestratorConflictError
    );
    try {
      orchestrator.review(meta.id, 'merge');
    } catch (err) {
      expect((err as Error).message).toBe(
        'merge target is some-other-branch, expected main'
      );
    }

    // Nothing about the run or the task moved: the branch/worktree are
    // still there to retry against once the user checks main back out.
    expect(store.get(task.meta.id)!.meta.status).not.toBe('done');
    expect(existsSync(meta.worktreePath)).toBe(true);
    expect(runGitSync(repo, ['branch', '--list', meta.branch])).toContain(
      meta.branch
    );
  });

  it('B: recovers from a real squash-merge conflict with a 409, leaving the task status untouched and main clean for a retry', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'shared.txt'), 'agent version\n');
            },
            commitMessage: 'agent: edit shared.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Conflicting merge' });
    // Both main and the run's branch will edit the same file, from the same
    // starting point, guaranteeing a real content conflict on squash-merge.
    writeFileSync(join(repo, 'shared.txt'), 'original\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'add shared.txt']);

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // Main moves on with an incompatible edit to the same file after the
    // run's branch diverged.
    writeFileSync(join(repo, 'shared.txt'), 'human version\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'human edits shared.txt']);

    // New-2: git reports content conflicts on stdout, so the 409's message
    // must actually name the conflicting file, not trail off empty.
    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(/shared\.txt/);

    // Task status must not have moved to done for a merge that never
    // actually happened.
    expect(store.get(task.meta.id)!.meta.status).not.toBe('done');
    // Main must be back to a clean, mergeable state (git reset --merge),
    // not stuck mid-conflict — a retry after manual resolution must be
    // possible.
    expect(runGitSync(repo, ['status', '--porcelain']).trim()).toBe('');
    expect(existsSync(join(repo, 'shared.txt'))).toBe(true);

    // Retry after resolving manually: bring the run's own change in by
    // hand, then merge/discard cleanly resolves the run.
    orchestrator.review(meta.id, 'discard');
    expect(store.get(task.meta.id)!.meta.status).toBe('todo');
  });

  it("C: keeps a user's own unrelated .dispatch/config.yml edit out of the squash commit", async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'hi\n');
            },
            commitMessage: 'agent: add feature.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Unrelated config edit' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // The user's own pending edit, unrelated to this run. isMainDirtyOutsideDispatch
    // deliberately excludes `.dispatch/` so this never blocks the merge —
    // but it must also never get swept into the squash commit.
    mkdirSync(join(repo, '.dispatch'), { recursive: true });
    writeFileSync(
      join(repo, '.dispatch', 'config.yml'),
      'statuses: [todo, done]\nautoCommit: false\n# user was mid-edit\n'
    );

    orchestrator.review(meta.id, 'merge');

    const committedFiles = runGitSync(repo, [
      'show',
      '--name-only',
      '--pretty=format:',
      'HEAD',
    ])
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(committedFiles).not.toContain('.dispatch/config.yml');
    // Still sitting there uncommitted, exactly as the user left it.
    expect(
      runGitSync(repo, [
        'status',
        '--porcelain',
        '--',
        '.dispatch/config.yml',
      ]).trim()
    ).not.toBe('');
  });

  it('H: back-to-back merges of two different runs both succeed', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'first.txt'), 'first\n');
            },
            commitMessage: 'agent: add first.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    orchestrator.registerExecutor(
      'fake2',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'second.txt'), 'second\n');
            },
            commitMessage: 'agent: add second.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const taskA = store.create({ title: 'First run to merge' });
    const taskB = store.create({ title: 'Second run to merge' });
    const metaA = await orchestrator.dispatch(taskA.meta.id, 'fake');
    const metaB = await orchestrator.dispatch(taskB.meta.id, 'fake2');
    await waitFor(
      () =>
        orchestrator.getRun(metaA.id)?.meta.state === 'finished' &&
        orchestrator.getRun(metaB.id)?.meta.state === 'finished'
    );

    expect(() => orchestrator.review(metaA.id, 'merge')).not.toThrow();
    expect(() => orchestrator.review(metaB.id, 'merge')).not.toThrow();

    expect(existsSync(join(repo, 'first.txt'))).toBe(true);
    expect(existsSync(join(repo, 'second.txt'))).toBe(true);
    expect(store.get(taskA.meta.id)!.meta.status).toBe('done');
    expect(store.get(taskB.meta.id)!.meta.status).toBe('done');
  });

  it('I: merges successfully with tracked task files and a mainline commit landed since the branch point', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'hi\n');
            },
            commitMessage: 'agent: add feature.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Tracked task file' });
    // Commit the task file (and its own dispatched-Activity edit) so it's
    // tracked in git, matching real project usage where `.dispatch/tasks`
    // is committed alongside code.
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'track dispatched task']);
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // The base branch moves on with an unrelated mainline commit after the
    // run's branch diverged.
    writeFileSync(join(repo, 'unrelated.txt'), 'unrelated change\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'unrelated mainline commit']);

    expect(() => orchestrator.review(meta.id, 'merge')).not.toThrow();
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
    expect(existsSync(join(repo, 'unrelated.txt'))).toBe(true);
    expect(store.get(task.meta.id)!.meta.status).toBe('done');
  });

  // Regression guard for the "squash first" reordering: a run that made no
  // file changes at all (a chatty run — nothing for `git merge --squash` to
  // squash) must still merge successfully. The task-file bookkeeping commit
  // is the only commit in that case, since there's no squash commit to fold
  // it into.
  it('merges successfully even when the run made no file changes to squash', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'No-op run' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(() => orchestrator.review(meta.id, 'merge')).not.toThrow();
    expect(store.get(task.meta.id)!.meta.status).toBe('done');
    const log = runGitSync(repo, ['log', '-1', '--pretty=%s']).trim();
    expect(log).toBe(`dispatch: No-op run (run ${meta.id})`);
  });
});

describe('Orchestrator.review discard', () => {
  it('removes the worktree/branch and restores the task to todo', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Discard me' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'discard');

    expect(existsSync(meta.worktreePath)).toBe(false);
    expect(store.get(task.meta.id)!.meta.status).toBe('todo');
  });
});

// C2: review() must require a terminal state (a run still awaiting
// approval/running has nothing to review yet) and must refuse a run that has
// already been reviewed once — merge/discard is a one-way door per run.
describe('Orchestrator review-state guard', () => {
  it('A: refuses to discard a run that is still awaiting approval', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'hold', toolName: 't', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Not terminal yet' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    expect(() => orchestrator.review(meta.id, 'discard')).toThrow(
      OrchestratorConflictError
    );
    // Nothing was torn down — the run is still there, still awaiting its
    // approval.
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('awaiting-approval');
    expect(existsSync(meta.worktreePath)).toBe(true);
  });

  it('E: refuses a second review call on an already-reviewed run (double merge)', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'double.txt'), 'once\n');
            },
            commitMessage: 'agent: add double.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Double merge' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'merge');

    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(
      OrchestratorConflictError
    );
    expect(() => orchestrator.review(meta.id, 'discard')).toThrow(
      OrchestratorConflictError
    );
  });

  it('E: refuses request-changes/resume on an already-reviewed run', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 's-1' } })
    );
    const task = store.create({ title: 'Resume after review' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'discard');

    expect(() =>
      orchestrator.sendMessage(meta.id, 'please fix x', { resume: true })
    ).toThrow(OrchestratorConflictError);
  });

  it('records reviewedAt/reviewAction on the run meta once reviewed', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Records review marker' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'discard');

    const reviewed = orchestrator.getRun(meta.id)!.meta;
    expect(reviewed.reviewAction).toBe('discard');
    expect(typeof reviewed.reviewedAt).toBe('string');
  });
});

// I4: once a run has an open PR (PrManager.openPr has pushed the branch and
// created it — recorded here via setRunPrUrl, the same call it makes), the
// *local* review/resume actions must refuse rather than race the PR: a local
// merge/discard would tear down the worktree/branch out from under an
// in-flight remote review, and resuming would keep writing to a branch
// someone else may already be reviewing on GitHub.
describe('Orchestrator PR guards', () => {
  async function dispatchToFinished(
    orchestrator: ReturnType<typeof makeOrchestrator>['orchestrator'],
    store: ReturnType<typeof makeOrchestrator>['store']
  ): Promise<RunMeta> {
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 's-1' } })
    );
    const task = store.create({ title: 'Has an open PR' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    return meta;
  }

  it('409s review(merge) once a run has an open PR', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await dispatchToFinished(orchestrator, store);
    orchestrator.setRunPrUrl(meta.id, 'https://github.com/example/repo/pull/1');

    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(
      OrchestratorConflictError
    );
    expect(() => orchestrator.review(meta.id, 'merge')).toThrow(/open PR/);
  });

  it('409s review(discard) once a run has an open PR', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await dispatchToFinished(orchestrator, store);
    orchestrator.setRunPrUrl(meta.id, 'https://github.com/example/repo/pull/1');

    expect(() => orchestrator.review(meta.id, 'discard')).toThrow(
      OrchestratorConflictError
    );
  });

  // The one narrowing: resuming does not tear the branch down, it pushes
  // more commits onto it — which is what updates the PR under review.
  it('resumes sendMessage(resume: true) on a run with an open PR', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await dispatchToFinished(orchestrator, store);
    orchestrator.setRunPrUrl(meta.id, 'https://github.com/example/repo/pull/1');

    const resumed = orchestrator.sendMessage(meta.id, 'please fix x', {
      resume: true,
    });
    expect(resumed.id).not.toBe(meta.id);
    expect(resumed.branch).toBe(meta.branch);
  });

  // Pins that the guard was narrowed, not removed: both destructive branch
  // verbs share requireCleanableBranch and must still refuse.
  it('409s deleteBranch once a run has an open PR', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await dispatchToFinished(orchestrator, store);
    orchestrator.setRunPrUrl(meta.id, 'https://github.com/example/repo/pull/1');

    expect(() => orchestrator.deleteBranch(meta.branch)).toThrow(
      OrchestratorConflictError
    );
    expect(() => orchestrator.deleteBranch(meta.branch)).toThrow(/open PR/);
  });

  it('409s freeWorktreeDisk once a run has an open PR', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const meta = await dispatchToFinished(orchestrator, store);
    orchestrator.setRunPrUrl(meta.id, 'https://github.com/example/repo/pull/1');

    expect(() => orchestrator.freeWorktreeDisk(meta.branch)).toThrow(
      OrchestratorConflictError
    );
    expect(() => orchestrator.freeWorktreeDisk(meta.branch)).toThrow(/open PR/);
  });
});

// C2(b): a subscriber's own bug must never change the outcome of the
// operation that triggered it — handleFinish/cancel/review/
// markRunMergedViaPr all fire hooks as their very last step specifically so
// a poisoned hook can't have altered anything about the run/task by then,
// but the hook-invocation loop itself must also isolate a throwing
// subscriber from every other subscriber and from the caller.
describe('Orchestrator hook isolation', () => {
  it('a poisoned onRunTerminal subscriber does not affect handleFinish', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    orchestrator.onRunTerminal(() => {
      throw new Error('boom terminal hook');
    });
    const task = store.create({ title: 'Poisoned terminal hook' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    // handleFinish's own outcome (task -> in-review) must have landed
    // despite the subscriber throwing, and the failure gets logged rather
    // than silently swallowed.
    expect(store.get(task.meta.id)?.meta.status).toBe('in-review');
    expect(store.get(task.meta.id)?.body).toContain('[hook error]');
  });

  it('a poisoned onRunReviewed subscriber does not affect review(merge)', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    orchestrator.onRunReviewed(() => {
      throw new Error('boom reviewed hook');
    });
    const task = store.create({ title: 'Poisoned reviewed hook' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const reviewed = orchestrator.review(meta.id, 'merge');

    expect(reviewed.reviewedAt).toBeDefined();
    expect(store.get(task.meta.id)?.meta.status).toBe('done');
    expect(store.get(task.meta.id)?.body).toContain('[hook error]');
  });
});

// Important #7 (superseded by the diff-snapshot fix below): a reviewed run's
// worktree is gone, but persistDiffSnapshot wrote a snapshot right before
// review() removed it — the endpoint must serve that snapshot instead of
// 409ing, even for a run whose diff happens to be empty.
describe('Orchestrator.diff on a reviewed run', () => {
  it('serves the persisted (empty) snapshot once the run has been reviewed and its worktree removed', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Diff after review' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'discard');

    expect(existsSync(meta.worktreePath)).toBe(false);
    const result = orchestrator.diff(meta.id);
    expect(result.patch).toBe('');
    expect(result.files).toEqual([]);
  });
});

// The user-reported bug this fix addresses: every review path (local merge,
// discard, PR merge) removes a run's worktree, which used to make its diff
// permanently unviewable. persistDiffSnapshot now writes the diff to disk
// right before each removal so GET .../diff can fall back to it.
describe('Orchestrator.diff survives worktree removal via a snapshot', () => {
  it('returns the pre-merge patch once review(merge) has removed the worktree', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(
                join(cwd, 'snapshot-merge.txt'),
                'merged content\n'
              );
            },
            commitMessage: 'agent: add snapshot-merge.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Diff survives merge' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const preMergeDiff = orchestrator.diff(meta.id);
    expect(preMergeDiff.files).toEqual([
      { path: 'snapshot-merge.txt', status: 'A' },
    ]);

    orchestrator.review(meta.id, 'merge');

    expect(existsSync(meta.worktreePath)).toBe(false);
    expect(orchestrator.diff(meta.id)).toEqual(preMergeDiff);
  });

  it('returns the pre-discard patch once review(discard) has removed the worktree', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(
                join(cwd, 'snapshot-discard.txt'),
                'discarded content\n'
              );
            },
            commitMessage: 'agent: add snapshot-discard.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Diff survives discard' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const preDiscardDiff = orchestrator.diff(meta.id);
    expect(preDiscardDiff.files).toEqual([
      { path: 'snapshot-discard.txt', status: 'A' },
    ]);

    orchestrator.review(meta.id, 'discard');

    expect(existsSync(meta.worktreePath)).toBe(false);
    expect(orchestrator.diff(meta.id)).toEqual(preDiscardDiff);
  });

  it('still throws when a run has neither a live worktree nor a snapshot', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Worktree vanished without review' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    // Simulate a crash/manual cleanup that removed the worktree directly,
    // bypassing review() entirely — no snapshot was ever written for it.
    rmSync(meta.worktreePath, { recursive: true, force: true });

    expect(() => orchestrator.diff(meta.id)).toThrow(OrchestratorConflictError);
  });

  // Task-11 fix: a corrupt snapshot (persistDiffSnapshot's writeFileSync is
  // not atomic, so a crash mid-write — or any other on-disk corruption — can
  // leave truncated/garbage JSON behind) must degrade to the same 409-mapped
  // OrchestratorConflictError a missing snapshot gets, never an unguarded
  // JSON.parse SyntaxError escaping past the typed-error mapping.
  it('falls through to the conflict error when the persisted snapshot is corrupt', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Corrupt snapshot' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    orchestrator.review(meta.id, 'discard');
    expect(existsSync(meta.worktreePath)).toBe(false);

    // Simulate a non-atomic write getting interrupted mid-flight by
    // clobbering the just-persisted snapshot with unparseable garbage.
    writeFileSync(diffSnapshotPath(repo, meta.id), '{not valid json');

    expect(() => orchestrator.diff(meta.id)).toThrow(OrchestratorConflictError);
  });
});

describe('Orchestrator.diff', () => {
  it('returns a real patch and file list for a run with committed changes', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'diffed.txt'), 'diff content\n');
            },
            commitMessage: 'agent: add diffed.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Diff me' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const result = orchestrator.diff(meta.id);
    expect(result.patch).toContain('diffed.txt');
    expect(result.files).toEqual([{ path: 'diffed.txt', status: 'A' }]);
  });
});

describe('Orchestrator concurrency', () => {
  it('rejects a second dispatch for the same task with a conflict error', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'hold', toolName: 't', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Only one live run' });
    await orchestrator.dispatch(task.meta.id, 'fake');

    await expect(orchestrator.dispatch(task.meta.id, 'fake')).rejects.toThrow(
      OrchestratorConflictError
    );
  });

  it('404s dispatching an unknown task', async () => {
    const { orchestrator } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    await expect(orchestrator.dispatch('t-000000', 'fake')).rejects.toThrow(
      OrchestratorNotFoundError
    );
  });

  it('rejects dispatch to an unregistered executor', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const task = store.create({ title: 'No such executor' });
    await expect(orchestrator.dispatch(task.meta.id, 'claude')).rejects.toThrow(
      OrchestratorClientError
    );
  });

  it('runs two dispatches for different tasks concurrently without interference', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'a.txt'), 'from a\n');
            },
            commitMessage: 'agent: add a.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    orchestrator.registerExecutor(
      'fake2',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'b.txt'), 'from b\n');
            },
            commitMessage: 'agent: add b.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const taskA = store.create({ title: 'Task A' });
    const taskB = store.create({ title: 'Task B' });

    const metaA = await orchestrator.dispatch(taskA.meta.id, 'fake');
    const metaB = await orchestrator.dispatch(taskB.meta.id, 'fake2');

    await waitFor(
      () =>
        orchestrator.getRun(metaA.id)?.meta.state === 'finished' &&
        orchestrator.getRun(metaB.id)?.meta.state === 'finished'
    );

    expect(existsSync(join(metaA.worktreePath, 'a.txt'))).toBe(true);
    expect(existsSync(join(metaB.worktreePath, 'b.txt'))).toBe(true);
    expect(existsSync(join(metaA.worktreePath, 'b.txt'))).toBe(false);
    expect(existsSync(join(metaB.worktreePath, 'a.txt'))).toBe(false);
  });
});

describe('Orchestrator.reconcileOnBoot', () => {
  it('marks interrupted runs failed and prunes orphan worktree directories', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'stuck', toolName: 't', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Interrupted by crash' });
    const meta = await first.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => first.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    // Simulate a leftover directory under the worktrees root that has no
    // matching transcript at all (e.g. a crash between mkdir and the
    // transcript header write).
    const orphanPath = join(worktreesDir(repo), 'orphan-no-transcript');
    mkdirSync(orphanPath, { recursive: true });

    // Simulate a process restart: build a fresh Orchestrator (empty
    // in-memory registry) against the same rootDir/DISPATCH_HOME and
    // reconcile.
    const cache2 = new TaskCache();
    cache2.rebuild(store);
    const events2 = new EventBus();
    const second = new Orchestrator({
      rootDir: repo,
      store,
      cache: cache2,
      events: events2,
    });
    second.reconcileOnBoot();

    expect(second.getRun(meta.id)?.meta.state).toBe('failed');
    expect(existsSync(meta.worktreePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
  });

  // C3: a transcript truncated by a crash mid-write (header parses, but the
  // line after it is corrupt JSON) must not abort reconciliation for every
  // other run — the corrupt line is skipped (transcript.ts's tolerant
  // read()) and the run still gets marked failed off of its header state.
  it('boots and marks a run failed even when its transcript has a truncated line', () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const task = store.create({ title: 'Truncated transcript' });
    const runId = 'r-abcdef';
    const meta: RunMeta = {
      id: runId,
      taskId: task.meta.id,
      taskTitle: task.meta.title,
      executor: 'fake',
      state: 'running',
      branch: 'dispatch/truncated',
      baseBranch: 'main',
      worktreePath: join(worktreesDir(repo), runId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(meta.worktreePath, { recursive: true });
    const path = transcriptPath(repo, runId);
    new Transcript(path).writeHeader(meta);
    // A crash mid-write: a truncated, unparsable JSON fragment appended
    // straight to the file (bypassing Transcript's own append methods,
    // which always write a complete line).
    appendFileSync(path, '{"type":"state","state":"fini\n');

    expect(() => orchestrator.reconcileOnBoot()).not.toThrow();

    expect(orchestrator.getRun(runId)?.meta.state).toBe('failed');
  });

  // C3 (broader case): a transcript "file" that fails outright to read
  // (not just to JSON-parse — e.g. a directory sitting where a `.jsonl` file
  // is expected, which throws EISDIR on readFileSync) must not abort
  // reconciliation for every *other* run's transcript. One bad entry is
  // skipped; the rest of the runs directory still gets processed.
  it('skips a transcript entry that fails to read entirely, without losing other runs', () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const task = store.create({ title: 'Reconciled alongside a bad entry' });
    const runId = 'r-fedcba';
    const meta: RunMeta = {
      id: runId,
      taskId: task.meta.id,
      taskTitle: task.meta.title,
      executor: 'fake',
      state: 'running',
      branch: 'dispatch/reconciled',
      baseBranch: 'main',
      worktreePath: join(worktreesDir(repo), runId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(meta.worktreePath, { recursive: true });
    new Transcript(transcriptPath(repo, runId)).writeHeader(meta);

    // A directory where a transcript file is expected: existsSync() is
    // true, but readFileSync() throws EISDIR rather than returning text —
    // a failure mode the JSON.parse try/catch inside Transcript.read()
    // can't reach at all.
    mkdirSync(join(runsDir(repo), 'r-000bad.jsonl'), { recursive: true });

    expect(() => orchestrator.reconcileOnBoot()).not.toThrow();

    expect(orchestrator.getRun(runId)?.meta.state).toBe('failed');
  });

  // Diff-snapshot GC: persistDiffSnapshot writes `<runId>.diff.json`
  // alongside a run's transcript, but nothing deletes it once the run itself
  // is gone. reconcileOnBoot should sweep any `*.diff.json` with no matching
  // `<runId>.jsonl` transcript, while leaving a matched snapshot (and the
  // unrelated merge-queue.json state file, which lives in the same
  // directory) alone.
  it('removes an orphaned diff snapshot, keeps a matched one, and leaves merge-queue.json untouched', () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const task = store.create({ title: 'Diff snapshot GC' });
    const runId = 'r-diffgc';
    const meta: RunMeta = {
      id: runId,
      taskId: task.meta.id,
      taskTitle: task.meta.title,
      executor: 'fake',
      state: 'finished',
      branch: 'dispatch/diffgc',
      baseBranch: 'main',
      worktreePath: join(worktreesDir(repo), runId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(meta.worktreePath, { recursive: true });
    new Transcript(transcriptPath(repo, runId)).writeHeader(meta);

    // Matched: this run's own transcript exists above.
    writeFileSync(diffSnapshotPath(repo, runId), '{}\n');
    // Orphaned: no `r-gone.jsonl` transcript anywhere in runsDir.
    const orphanDiffPath = join(runsDir(repo), 'r-gone.diff.json');
    writeFileSync(orphanDiffPath, '{}\n');
    // The merge queue's own persisted state, sitting in the same directory —
    // must survive the sweep even though nothing keeps it in any keep-set.
    const queuePath = join(runsDir(repo), 'merge-queue.json');
    writeFileSync(queuePath, '{"entries":[],"history":[]}\n');

    orchestrator.reconcileOnBoot();

    expect(existsSync(diffSnapshotPath(repo, runId))).toBe(true);
    expect(existsSync(orphanDiffPath)).toBe(false);
    expect(existsSync(queuePath)).toBe(true);
  });
});

describe('Orchestrator onFinish safety net (uncommitted changes)', () => {
  it('auto-commits a dirty worktree left uncommitted by the executor', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'forgot-to-commit.txt'), 'oops\n');
            },
            // Leaves the write uncommitted, simulating an executor that
            // "forgets" to commit before finishing — exactly what the
            // orchestrator's onFinish safety net exists to catch.
            commit: false,
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Executor forgets to commit' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(
      runGitSync(meta.worktreePath, ['status', '--porcelain']).trim()
    ).toBe('');
    const log = runGitSync(meta.worktreePath, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe(
      `wip(dispatch): uncommitted changes from run ${meta.id}`
    );
  });

  it('is a no-op when the worktree is already clean', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'committed.txt'), 'fine\n');
            },
            commitMessage: 'agent: add committed.txt',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Executor commits its own work' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const log = runGitSync(meta.worktreePath, ['log', '-1', '--pretty=%s']);
    expect(log.trim()).toBe('agent: add committed.txt');
  });

  // A run worktree has no `node_modules`, so a hook that typechecks or runs
  // lint-staged fails there regardless of the content. Unguarded, the veto went
  // unnoticed and the run was reported `finished` with a dirty index.
  it('commits past a pre-commit hook that rejects everything', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const hooksDir = join(repo, '.git-hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, 'pre-commit'),
      '#!/bin/sh\necho "tsc: cannot find module" >&2\nexit 1\n',
      { mode: 0o755 }
    );
    runGitSync(repo, ['config', 'core.hooksPath', hooksDir]);

    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'real-work.txt'), 'the agent did this\n');
            },
            commit: false,
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Hook rejects the safety-net commit' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(
      runGitSync(meta.worktreePath, ['status', '--porcelain']).trim()
    ).toBe('');
    expect(
      runGitSync(meta.worktreePath, ['log', '-1', '--pretty=%s']).trim()
    ).toBe(`wip(dispatch): uncommitted changes from run ${meta.id}`);
  });

  // I6: handleFinish's own git work (autoCommitIfDirty) must never let an
  // escaped throw reach the caller — an executor's onFinish is invoked from
  // deep inside its own event plumbing, and an uncaught exception there has
  // nowhere useful to go, leaving the run stuck in whatever state it was in
  // (a zombie: neither cleanly finished nor visibly failed). A worktree that
  // has been deleted out from under a run before it finishes (e.g. an
  // operator cleanup, a crash-adjacent race) must instead surface as a
  // normal `failed` run.
  it('marks a run failed instead of throwing when its worktree is gone by the time it finishes', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'hold', toolName: 't', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Worktree deleted mid-run' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    rmSync(meta.worktreePath, { recursive: true, force: true });

    expect(() => orchestrator.approve(meta.id, 'hold', true)).not.toThrow();
    await waitFor(() => orchestrator.getRun(meta.id)?.meta.state === 'failed');
    expect(orchestrator.getRun(meta.id)?.meta.error).toBeDefined();
  });
});

// The user-reported "run has no executor" bug (item A), fix half 1: a
// request-changes redispatch used to hard-throw `unknown executor: <name>`
// the moment a run's *original* executor wasn't registered on the current
// daemon — the real-world case being a run created with the 'fake' executor
// under a dev daemon, later resumed under a release daemon that never
// registers 'fake' at all. requestChanges() now falls back through
// resolveExecutorForResume(): the default 'claude' if registered, else the
// single other registered executor, else the same throw as before.
describe('Orchestrator request-changes executor fallback', () => {
  it("falls back to the default 'claude' executor when the original run's executor is no longer registered", async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    first.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 'sess-1' } })
    );
    const task = store.create({ title: 'Resume under a different daemon' });
    const meta = await first.dispatch(task.meta.id, 'fake');
    await waitFor(() => first.getRun(meta.id)?.meta.state === 'finished');

    // A fresh Orchestrator sharing the same on-disk project — simulating a
    // release daemon that only ever registers the real 'claude' executor,
    // never 'fake' — hydrated via the same reconcileOnBoot() every real
    // daemon runs at boot.
    const cache2 = new TaskCache();
    cache2.rebuild(store);
    const events2 = new EventBus();
    const second = new Orchestrator({
      rootDir: repo,
      store,
      cache: cache2,
      events: events2,
    });
    second.reconcileOnBoot();
    const sent: string[] = [];
    second.registerExecutor('claude', controllableExecutor(sent));

    const resumed = second.sendMessage(meta.id, 'please fix x', {
      resume: true,
    });

    expect(resumed.executor).toBe('claude');
    expect(store.get(task.meta.id)!.body).toContain(
      `requested changes (run ${resumed.id}): please fix x (executor 'fake' is no longer registered — substituted 'claude')`
    );
  });

  it('falls back to the single other registered executor when neither the original nor the default is registered', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    // The sessionId is what makes the run resumable at all (see sendMessage's
    // resume gate) — this test is about which executor the resume resolves to,
    // so it has to get past that gate first.
    first.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 'sess-1' } })
    );
    const task = store.create({
      title: 'Resume onto a single-executor daemon',
    });
    const meta = await first.dispatch(task.meta.id, 'fake');
    await waitFor(() => first.getRun(meta.id)?.meta.state === 'finished');

    const cache2 = new TaskCache();
    cache2.rebuild(store);
    const events2 = new EventBus();
    const second = new Orchestrator({
      rootDir: repo,
      store,
      cache: cache2,
      events: events2,
    });
    second.reconcileOnBoot();
    const sent: string[] = [];
    second.registerExecutor('weird-single', controllableExecutor(sent));

    const resumed = second.sendMessage(meta.id, 'please fix y', {
      resume: true,
    });

    expect(resumed.executor).toBe('weird-single');
  });

  it('throws unknown executor when nothing can be resolved (neither the original, the default, nor a lone fallback)', async () => {
    const { orchestrator: first, store } = makeOrchestrator(repo);
    // Resumable (has a sessionId) so this reaches executor resolution rather
    // than stopping at sendMessage's resume gate — the assertion below pins
    // the message precisely for exactly that reason.
    first.registerExecutor(
      'fake',
      new FakeExecutor({ finish: { state: 'finished', sessionId: 'sess-1' } })
    );
    const task = store.create({ title: 'Resume with no viable fallback' });
    const meta = await first.dispatch(task.meta.id, 'fake');
    await waitFor(() => first.getRun(meta.id)?.meta.state === 'finished');

    const cache2 = new TaskCache();
    cache2.rebuild(store);
    const events2 = new EventBus();
    const second = new Orchestrator({
      rootDir: repo,
      store,
      cache: cache2,
      events: events2,
    });
    second.reconcileOnBoot();
    second.registerExecutor('other-a', controllableExecutor([]));
    second.registerExecutor('other-b', controllableExecutor([]));

    expect(() =>
      second.sendMessage(meta.id, 'please fix z', { resume: true })
    ).toThrow(/unknown executor/i);
  });
});

// The user-reported "keeps saying running" bug: an Executor whose start()
// throws synchronously (most often the Claude Agent SDK failing to locate its
// native CLI binary) used to strand the run in 'running' with no ExecutorRun
// behind it — dispatch()/requestChanges() transition the run to 'running'
// *before* calling start(), so a start() throw left a zombie the caller could
// neither message nor finish. Its only eventual resolution was the next
// approve()/sendMessage()/inject() lazily healing it via healZombieRun() and
// stamping the misleading "the daemon restarted" message on a daemon that
// never restarted; the throw itself also escaped to Bun.serve's `error`
// handler as an opaque 500.
//
// startAndRegister() now heals that *eagerly*: a start() throw marks the run
// failed immediately, at dispatch time, carrying the real error — so the run
// never enters the confusing "running" limbo and dispatch()/requestChanges()
// return a run that is already terminally 'failed'. (healZombieRun() stays as
// a defense-in-depth guard for any other way a non-terminal run could lose
// its executor handle; both paths funnel through the shared markRunFailed()
// bookkeeping asserted below.)
describe('Orchestrator eager fail on executor start failure (no zombie)', () => {
  // The exact shape of the reported bug: Executor.start() throws before ever
  // returning an ExecutorRun.
  class ThrowingStartExecutor implements Executor {
    start(): ExecutorRun {
      throw new Error('boom: executor process failed to start');
    }
  }

  it('a synchronous start() failure marks the run failed immediately instead of stranding it running', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor('fake', new ThrowingStartExecutor());
    const task = store.create({ title: 'Failed executor start' });

    // dispatch() no longer lets the start() error escape — it returns a run
    // that is already terminally failed.
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    expect(meta.state).toBe('failed');
    expect(meta.error).toMatch(/failed to start/);
    expect(meta.error).toContain('boom: executor process failed to start');

    const persisted = orchestrator.getRun(meta.id)!.meta;
    expect(persisted.state).toBe('failed');
    // Same "only an in-progress task moves to in-review" rule handleFinish
    // uses for a normal finish/failure — shared via markRunFailed().
    expect(store.get(task.meta.id)!.meta.status).toBe('in-review');
    expect(store.get(task.meta.id)!.body).toContain(
      `[run ${meta.id}] failed to start:`
    );
  });

  it('a follow-up message to a run whose start failed reports it terminal, not "running"', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor('fake', new ThrowingStartExecutor());
    const task = store.create({ title: 'Follow-up after failed start' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    expect(meta.state).toBe('failed');

    // Because the run is already terminal, a follow-up hits the normal
    // "run is not live" guard rather than the old zombie self-heal — the user
    // gets an honest terminal-state error, never the misleading
    // "keeps saying running" limbo.
    expect(() => orchestrator.sendMessage(meta.id, 'hello')).toThrow(
      /run is not live/
    );
    expect(() => orchestrator.inject(meta.id, 'hi')).toThrow(
      /run is not running/
    );
  });

  it('an approval request fired right before start() throws still ends failed, not stuck awaiting-approval', async () => {
    // A synchronous approval request fired from inside start() itself, right
    // before start() throws: the run momentarily transitions to
    // 'awaiting-approval', but the start() failure must still drive it to a
    // clean terminal 'failed' rather than leaving it stuck awaiting an
    // approval no live executor can ever consume.
    class SyncApprovalThenCrashExecutor implements Executor {
      start(_opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
        events.onApprovalRequest({
          requestId: 'req-1',
          toolName: 't',
          input: {},
        });
        throw new Error('boom: crashed right after requesting approval');
      }
    }
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor('fake', new SyncApprovalThenCrashExecutor());
    const task = store.create({ title: 'Approval then failed start' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    expect(meta.state).toBe('failed');
    expect(meta.error).toContain('crashed right after requesting approval');

    // The pending approval can no longer be answered — the run is terminal.
    expect(() => orchestrator.approve(meta.id, 'req-1', true)).toThrow(
      /run is not awaiting approval/
    );
  });
});

describe('Orchestrator per-run caps and prompt assembly', () => {
  // A minimal Executor that just records the options it was started with
  // and finishes immediately — used to assert on exactly what the
  // orchestrator hands an executor, independent of FakeExecutor's own
  // scripting concerns.
  class CapturingExecutor implements Executor {
    lastOpts?: ExecutorStartOptions;

    start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
      this.lastOpts = opts;
      events.onFinish({ state: 'finished' });
      return {
        interrupt: () => Promise.resolve(),
        requestStop: () => {},
        send: () => {},
        approve: () => {},
      };
    }
  }

  it('passes the configured orchestrator caps through to the executor', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    mkdirSync(join(repo, '.dispatch'), { recursive: true });
    writeFileSync(
      join(repo, '.dispatch/config.yml'),
      'orchestrator:\n  maxTurns: 7\n  maxBudgetUsd: 2.5\n  permissionMode: plan\n'
    );
    const executor = new CapturingExecutor();
    orchestrator.registerExecutor('fake', executor);
    const task = store.create({ title: 'Respect config caps' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(executor.lastOpts?.maxTurns).toBe(7);
    expect(executor.lastOpts?.maxBudgetUsd).toBe(2.5);
    expect(executor.lastOpts?.permissionMode).toBe('plan');
  });

  // No turn cap by default (see DEFAULT_ORCHESTRATOR in @dispatch/core's
  // config.ts): a turn ceiling is a runaway backstop, not a work budget, and a
  // low one truncates healthy runs mid-task — `maxBudgetUsd` is the real guard.
  // Asserting `undefined` rather than a number is the point: the cap has to
  // stay absent unless a project opts into one.
  it('applies no turn cap and auto permissions with no config file', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new CapturingExecutor();
    orchestrator.registerExecutor('fake', executor);
    const task = store.create({ title: 'Default caps' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(executor.lastOpts?.maxTurns).toBeUndefined();
    expect(executor.lastOpts?.maxBudgetUsd).toBeUndefined();
    expect(executor.lastOpts?.permissionMode).toBe('auto');
  });

  it('builds a prompt that includes the parent epic when the task has one', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new CapturingExecutor();
    orchestrator.registerExecutor('fake', executor);
    const epic = store.create({
      title: 'Harden auth',
      kind: 'epic',
      description: 'Make the auth system resistant to abuse.',
    });
    const task = store.create({
      title: 'Add login rate limiting',
      parent: epic.meta.id,
    });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(executor.lastOpts?.prompt).toContain('Add login rate limiting');
    expect(executor.lastOpts?.prompt).toContain('Harden auth');
    expect(executor.lastOpts?.prompt).toContain('resistant to abuse');
  });

  it('hands the agent the repo orientation instead of instructions to go find it', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new CapturingExecutor();
    orchestrator.registerExecutor('fake', executor);
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'], scripts: { lint: 'x' } })
    );
    mkdirSync(join(repo, 'packages', 'core'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@example/core', description: 'Shared types' })
    );
    const task = store.create({ title: 'Use the orientation' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const prompt = executor.lastOpts?.prompt ?? '';
    expect(prompt).toContain('## Repo orientation');
    expect(prompt).toContain('`packages/core` — @example/core: Shared types');
    expect(prompt).toContain('`bun run lint`');
    // The instructions the orientation replaces must be gone, not duplicated.
    expect(prompt).not.toContain('before assuming you have exclusive access');
  });

  // dispatch() registers the run and marks it `running` BEFORE building its
  // prompt, so without the taskId filter in orientationFor every agent would
  // open by reading that it is contending with itself.
  it('never reports the dispatching run as its own competitor', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new CapturingExecutor();
    orchestrator.registerExecutor('fake', executor);
    // Something collectable, so the section renders at all — an empty repo
    // correctly produces no orientation and keeps the original instructions.
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { lint: 'x' } })
    );
    const task = store.create({ title: 'Solo run' });

    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const prompt = executor.lastOpts?.prompt ?? '';
    expect(prompt).not.toContain(meta.id);
    expect(prompt).toContain('no other runs are in flight');
  });
});

// A bare remote to push to — bare because a non-bare repo refuses a push
// that updates its currently-checked-out branch, which `main` always is here.
function initBareGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-origin-'));
  runGitSync(dir, ['init', '--bare', '-b', 'main']);
  return dir;
}

// Dispatches one run that writes a commit and finishes, leaving a real
// worktree + branch behind un-reviewed — the common starting point for both
// the listBranches and decorateRunsWithPushed suites below.
async function dispatchFinishedRun(
  rootDir: string,
  title = 'Add feature'
): Promise<{ orchestrator: Orchestrator; store: TaskStore; meta: RunMeta }> {
  const { orchestrator, store } = makeOrchestrator(rootDir);
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({
      steps: [
        {
          write: (cwd) => {
            writeFileSync(join(cwd, 'feature.txt'), 'done\n');
          },
          commitMessage: 'agent: add feature',
        },
      ],
      finish: { state: 'finished' },
    })
  );
  const task = store.create({ title });
  const meta = await orchestrator.dispatch(task.meta.id, 'fake');
  await waitFor(() => orchestrator.getRun(meta.id)?.meta.state === 'finished');
  return { orchestrator, store, meta };
}

// The Branches surface (spec §§1-4): listBranches() joins git's refs with the
// run registry, and the two destructive actions refuse anything still in use.
describe('Orchestrator.listBranches', () => {
  it('reports a finished, un-reviewed run as reviewable with its run and task attached', async () => {
    const { orchestrator, meta } = await dispatchFinishedRun(repo);

    const entries = orchestrator.listBranches();

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.branch).toBe(meta.branch);
    expect(entry.status).toBe('reviewable');
    expect(entry.runId).toBe(meta.id);
    expect(entry.taskId).toBe(meta.taskId);
    expect(entry.taskTitle).toBe('Add feature');
    expect(entry.runState).toBe('finished');
    expect(entry.worktreeExists).toBe(true);
    expect(entry.ahead).toBe(1);
    expect(entry.mergedIntoBase).toBe(false);
    expect(entry.reviewedAt).toBeUndefined();
  });

  it('reports a branch with no run in the registry as an orphan', () => {
    const { orchestrator } = makeOrchestrator(repo);
    // A ref nothing ever recorded a transcript for — exactly what a crash
    // between `worktree add` and the transcript header leaves behind.
    runGitSync(repo, ['branch', 'dispatch/t-ghost-r000000', 'main']);

    const entries = orchestrator.listBranches();

    expect(entries).toHaveLength(1);
    expect(entries[0].branch).toBe('dispatch/t-ghost-r000000');
    expect(entries[0].status).toBe('orphan');
    expect(entries[0].runId).toBeUndefined();
    // Nothing on it beyond main, so deleting it destroys nothing.
    expect(entries[0].mergedIntoBase).toBe(true);
    expect(entries[0].ahead).toBe(0);
  });

  it('ignores non-dispatch branches entirely', () => {
    const { orchestrator } = makeOrchestrator(repo);
    runGitSync(repo, ['branch', 'feature/mine', 'main']);
    runGitSync(repo, ['branch', 'wip', 'main']);

    expect(orchestrator.listBranches()).toEqual([]);
  });

  it('stops listing a branch once a review has cleaned it up', async () => {
    const { orchestrator, meta } = await dispatchFinishedRun(repo);
    expect(orchestrator.listBranches()).toHaveLength(1);

    orchestrator.review(meta.id, 'discard');

    // The ref is gone, so there is nothing left to clean up and nothing to
    // show — a reviewed run must not linger on this surface forever.
    expect(orchestrator.listBranches()).toEqual([]);
  });

  it('reports a reviewed run whose ref survived as a leftover', async () => {
    const { orchestrator, meta } = await dispatchFinishedRun(repo);
    orchestrator.review(meta.id, 'discard');
    // Simulate the failure mode `leftover` exists to surface: review() ran,
    // but the branch ref is somehow still here (WorktreeManager.remove
    // swallows git errors by design, so a failed `branch -D` is silent).
    runGitSync(repo, ['branch', meta.branch, 'main']);

    const entries = orchestrator.listBranches();

    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('leftover');
    expect(entries[0].reviewedAt).toBeDefined();
  });

  it('marks a worktree with uncommitted files dirty', async () => {
    const { orchestrator, meta } = await dispatchFinishedRun(repo);
    writeFileSync(join(meta.worktreePath, 'scratch.txt'), 'stray\n');

    expect(orchestrator.listBranches()[0].dirty).toBe(true);
  });

  it('sorts leftovers and orphans ahead of reviewable and active rows', async () => {
    const { orchestrator } = await dispatchFinishedRun(repo);
    runGitSync(repo, ['branch', 'dispatch/t-ghost-r000000', 'main']);

    const statuses = orchestrator.listBranches().map((e) => e.status);

    expect(statuses).toEqual(['orphan', 'reviewable']);
  });

  it('reports pushedToOrigin false without a remote, and false-then-true once a merge reaches origin', async () => {
    const origin = initBareGitRepo();
    runGitSync(repo, ['remote', 'add', 'origin', origin]);
    const { orchestrator, meta } = await dispatchFinishedRun(repo);

    // Merged but nothing pushed anywhere yet.
    orchestrator.review(meta.id, 'merge');
    // review() removes the ref on success — recreate it to simulate the
    // leftover case, same as the existing leftover test above.
    runGitSync(repo, ['branch', meta.branch, 'main']);

    expect(orchestrator.listBranches()[0].pushedToOrigin).toBe(false);

    runGitSync(repo, ['push', 'origin', 'main']);
    runGitSync(repo, ['fetch', 'origin', 'main']);

    expect(orchestrator.listBranches()[0].pushedToOrigin).toBe(true);
  });

  it('measures how far an unmerged branch fell behind its base, and omits the count once merged', async () => {
    const { orchestrator, meta } = await dispatchFinishedRun(repo);
    // The base moves on while the run's work sits unreviewed — the "four
    // branches sat out for a week" situation this surface exists to expose.
    writeFileSync(join(repo, 'mainline.txt'), 'moved\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'base moves on']);

    const entry = orchestrator.listBranches()[0];
    expect(entry.mergedIntoBase).toBe(false);
    expect(entry.behindBase).toBe(1);

    orchestrator.review(meta.id, 'merge');
    // Same leftover simulation as above: the surviving ref now points at a
    // landed state, so "behind" stops being a meaningful number for it.
    runGitSync(repo, ['branch', meta.branch, 'main']);

    const merged = orchestrator.listBranches()[0];
    expect(merged.mergedIntoBase).toBe(true);
    expect(merged.behindBase).toBeUndefined();
  });

  it('keeps pushedToOrigin false while a branch is unmerged locally, even if its tip reached origin', async () => {
    const origin = initBareGitRepo();
    runGitSync(repo, ['remote', 'add', 'origin', origin]);
    const { orchestrator, meta } = await dispatchFinishedRun(repo);
    // The branch's commit lands on origin's main directly (merged from
    // another machine, say) while the LOCAL base still doesn't have it. The
    // branch is still "out" from this checkout's point of view, so pushed
    // must stay false — the fix is a fetch, not a status change.
    runGitSync(repo, ['push', 'origin', `${meta.branch}:main`]);
    runGitSync(repo, ['fetch', 'origin', 'main']);

    const entry = orchestrator.listBranches()[0];
    expect(entry.mergedIntoBase).toBe(false);
    expect(entry.pushedToOrigin).toBe(false);
  });

  it('reports a hand-merged ref no run claims as pushed once its tip reaches origin base', () => {
    const origin = initBareGitRepo();
    runGitSync(repo, ['remote', 'add', 'origin', origin]);
    const { orchestrator } = makeOrchestrator(repo);
    // An orphan ref sitting at main's tip: merged as far as git is concerned,
    // but with no registry entry there is no mergeCommit to probe — the
    // branch tip itself has to be the evidence.
    runGitSync(repo, ['branch', 'dispatch/t-ghost-r000000', 'main']);

    expect(orchestrator.listBranches()[0].pushedToOrigin).toBe(false);

    runGitSync(repo, ['push', 'origin', 'main']);
    runGitSync(repo, ['fetch', 'origin', 'main']);

    expect(orchestrator.listBranches()[0].pushedToOrigin).toBe(true);
  });
});

// Task 6: archivedAt is the signal a `done` task can finally drop out of the
// visible board for good — reconcileArchives() is what decides a task has
// earned that, based on whether its merge actually reached origin.
describe('Orchestrator.reconcileArchives', () => {
  it('stamps archivedAt once the merge reaches origin, is a no-op before that, and never re-touches an archived task', async () => {
    const origin = initBareGitRepo();
    runGitSync(repo, ['remote', 'add', 'origin', origin]);
    const { orchestrator, store, meta } = await dispatchFinishedRun(repo);
    orchestrator.review(meta.id, 'merge');

    // Merged locally, but origin still has no idea — nothing to stamp yet.
    expect(orchestrator.reconcileArchives()).toBe(0);
    expect(store.get(meta.taskId)?.meta.archivedAt).toBeUndefined();

    runGitSync(repo, ['push', 'origin', 'main']);
    runGitSync(repo, ['fetch', 'origin', 'main']);

    expect(orchestrator.reconcileArchives()).toBe(1);
    expect(store.get(meta.taskId)?.meta.archivedAt).toBeDefined();

    // Idempotent: query()'s default filter already excludes the task just
    // archived, so a repeat call finds nothing left to do.
    expect(orchestrator.reconcileArchives()).toBe(0);
  });

  it('leaves a done task un-archived with no origin remote configured at all', async () => {
    const { orchestrator, store, meta } = await dispatchFinishedRun(repo);
    orchestrator.review(meta.id, 'merge');

    expect(orchestrator.reconcileArchives()).toBe(0);
    expect(store.get(meta.taskId)?.meta.archivedAt).toBeUndefined();
  });

  it('runs the same reconciliation from reconcileOnBoot, off a freshly-hydrated registry', async () => {
    const origin = initBareGitRepo();
    runGitSync(repo, ['remote', 'add', 'origin', origin]);
    const {
      orchestrator: first,
      store,
      meta,
    } = await dispatchFinishedRun(repo);
    first.review(meta.id, 'merge');
    runGitSync(repo, ['push', 'origin', 'main']);
    runGitSync(repo, ['fetch', 'origin', 'main']);

    // A fresh Orchestrator over the same on-disk project — a daemon restart
    // — has to re-derive the merged run's mergeCommit/baseBranch from the
    // replayed transcript alone before it can reconcile anything.
    const cache2 = new TaskCache();
    cache2.rebuild(store);
    const events2 = new EventBus();
    const second = new Orchestrator({
      rootDir: repo,
      store,
      cache: cache2,
      events: events2,
    });
    second.reconcileOnBoot();

    expect(store.get(meta.taskId)?.meta.archivedAt).toBeDefined();
  });
});

// decorateRunsWithPushed backs the runs API decoration: adds
// `pushedToOrigin` to merged runs only, computed against the live repo.
describe('Orchestrator.decorateRunsWithPushed', () => {
  it('leaves non-merged runs untouched', async () => {
    const { orchestrator, meta } = await dispatchFinishedRun(repo);

    const [decorated] = orchestrator.decorateRunsWithPushed([
      orchestrator.getRun(meta.id)!.meta,
    ]);

    expect(decorated.pushedToOrigin).toBeUndefined();
  });

  it('reports false for a merged run when the repo has no origin remote', async () => {
    const { orchestrator, meta } = await dispatchFinishedRun(repo);
    const reviewed = orchestrator.review(meta.id, 'merge');

    const [decorated] = orchestrator.decorateRunsWithPushed([reviewed]);

    expect(decorated.pushedToOrigin).toBe(false);
  });

  it('reports true for a merged run once its commit reaches origin', async () => {
    const origin = initBareGitRepo();
    runGitSync(repo, ['remote', 'add', 'origin', origin]);
    const { orchestrator, meta } = await dispatchFinishedRun(repo);
    const reviewed = orchestrator.review(meta.id, 'merge');

    expect(
      orchestrator.decorateRunsWithPushed([reviewed])[0].pushedToOrigin
    ).toBe(false);

    runGitSync(repo, ['push', 'origin', 'main']);
    runGitSync(repo, ['fetch', 'origin', 'main']);

    expect(
      orchestrator.decorateRunsWithPushed([reviewed])[0].pushedToOrigin
    ).toBe(true);
  });
});

describe('Orchestrator.freeWorktreeDisk', () => {
  it('removes the worktree directory, keeps the ref, and leaves the run reviewable', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'done\n');
            },
            commitMessage: 'agent: add feature',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Add feature' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const entry = orchestrator.freeWorktreeDisk(meta.branch);

    expect(existsSync(meta.worktreePath)).toBe(false);
    // The ref surviving is what makes this reversible.
    expect(entry.branch).toBe(meta.branch);
    expect(entry.worktreeExists).toBe(false);
    expect(entry.status).toBe('reviewable');
    expect(orchestrator.getRun(meta.id)!.meta.reviewedAt).toBeUndefined();
  });

  it('keeps the run diffable from its snapshot after the worktree is gone', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'done\n');
            },
            commitMessage: 'agent: add feature',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Add feature' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    const before = orchestrator.diff(meta.id);

    orchestrator.freeWorktreeDisk(meta.branch);

    // This is the load-bearing assertion for the whole action: diff() already
    // falls back to the snapshot persisted just before removal, so freeing
    // disk must never break the review surface.
    expect(existsSync(diffSnapshotPath(repo, meta.id))).toBe(true);
    expect(orchestrator.diff(meta.id).files).toEqual(before.files);
  });
});

describe('Orchestrator.deleteBranch guards', () => {
  it('deletes a merged orphan ref outright', () => {
    const { orchestrator } = makeOrchestrator(repo);
    runGitSync(repo, ['branch', 'dispatch/t-ghost-r000000', 'main']);

    orchestrator.deleteBranch('dispatch/t-ghost-r000000');

    expect(orchestrator.listBranches()).toEqual([]);
  });

  it('refuses an unmerged branch without force, and deletes it with force', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) => {
              writeFileSync(join(cwd, 'feature.txt'), 'done\n');
            },
            commitMessage: 'agent: add feature',
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Add feature' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    expect(() => orchestrator.deleteBranch(meta.branch)).toThrow(
      OrchestratorConflictError
    );
    expect(orchestrator.listBranches()).toHaveLength(1);

    orchestrator.deleteBranch(meta.branch, { force: true });

    expect(orchestrator.listBranches()).toEqual([]);
  });

  it('refuses a branch whose run is still live', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    // A script that parks on an approval gate keeps the run non-terminal for
    // the duration of the test, which is exactly the 'active' case.
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({
        steps: [
          {
            approval: {
              requestId: 'req-1',
              toolName: 'edit_file',
              input: { path: 'x' },
            },
          },
        ],
        finish: { state: 'finished' },
      })
    );
    const task = store.create({ title: 'Add feature' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'awaiting-approval'
    );

    expect(orchestrator.listBranches()[0].status).toBe('active');
    expect(() => orchestrator.deleteBranch(meta.branch)).toThrow(
      /has a live run/
    );
    expect(() => orchestrator.freeWorktreeDisk(meta.branch)).toThrow(
      /has a live run/
    );
  });

  it('refuses the branch currently checked out in the main repo', () => {
    const { orchestrator } = makeOrchestrator(repo);
    runGitSync(repo, ['checkout', '-b', 'dispatch/t-here-r000000']);

    expect(() => orchestrator.deleteBranch('dispatch/t-here-r000000')).toThrow(
      /checked out in the main repo/
    );
  });

  it('refuses a branch that another branch is stacked on', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'fake',
      new FakeExecutor({ steps: [], finish: { state: 'finished' } })
    );
    const task = store.create({ title: 'Blocker' });
    const blocker = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(blocker.id)?.meta.state === 'finished'
    );
    // Stand in for a stacked dependent: a dispatch ref whose recorded base is
    // the blocker's branch. Built by hand because base-resolution for
    // dependents is the stacked-dispatch work, not this feature.
    const dependent = 'dispatch/t-dep-r111111';
    runGitSync(repo, ['branch', dependent, 'main']);
    const runsPath = runsDir(repo);
    mkdirSync(runsPath, { recursive: true });
    new Transcript(join(runsPath, 'r-111111.jsonl')).writeHeader({
      ...blocker,
      id: 'r-111111',
      branch: dependent,
      baseBranch: blocker.branch,
      state: 'finished',
      worktreePath: join(worktreesDir(repo), 'r-111111'),
    });
    orchestrator.reconcileOnBoot();

    expect(() =>
      orchestrator.deleteBranch(blocker.branch, { force: true })
    ).toThrow(new RegExp(`is the base of ${dependent}`));
  });

  it('404s an unknown branch', () => {
    const { orchestrator } = makeOrchestrator(repo);

    expect(() => orchestrator.deleteBranch('dispatch/nope')).toThrow(
      OrchestratorNotFoundError
    );
  });
});
