import type { Sender } from '@dispatch-foo/protocol';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { TERMINAL_RUN_STATES } from '../../src/orchestrator/types.js';
import { StallingExecutor } from '../orchestrator/helpers.js';
import {
  HUMAN,
  makeOrchestrator,
  openRecovered,
  useTempProject,
  waitFor,
} from './harness.js';

const project = useTempProject();

describe('outgoing run messages', () => {
  it("logs a run's message to a human on the run's own transcript", async () => {
    const { orchestrator, store, events } = makeOrchestrator(project.root());
    const logged: unknown[] = [];
    events.subscribe((e) => {
      if (e.type === 'run.log') logged.push(e.entry);
    });
    orchestrator.registerExecutor('stalling', new StallingExecutor());
    const messaging = await openRecovered(project.root(), orchestrator, store);
    const task = store.create({ title: 'Schema work' });
    const meta = await orchestrator.dispatch(task.meta.id, 'stalling', {});
    const run: Sender = { address: `run:${meta.id}`, canDecide: false };
    const { message } = await messaging.engine.send(
      {
        to: ['human:wyat'],
        kind: 'notice',
        body: 'Heads up: the schema moved',
      },
      run
    );
    expect(orchestrator.getRun(meta.id)?.entries.at(-1)).toMatchObject({
      kind: 'message',
      from: 'agent',
      toUser: true,
      text: 'Heads up: the schema moved',
      messageId: message.id,
      fromLabel: `Schema work (${meta.id})`,
    });
    // A connected Session tab hears it live, too.
    expect(logged.at(-1)).toMatchObject({
      kind: 'message',
      messageId: message.id,
    });
    // A well-formed task id; nothing needs to exist there.
    await messaging.engine.send(
      { to: ['task:t-00ff01'], kind: 'notice', body: 'agents only' },
      run
    );
    expect(orchestrator.getRun(meta.id)?.entries.at(-1)).toMatchObject({
      messageId: message.id,
    });
    await orchestrator.cancel(meta.id);
    messaging.close();
  });
});

describe('human wakes', () => {
  it('a human wake continues a finished, unreviewed run in its own worktree', async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    orchestrator.registerExecutor(
      'agent',
      new FakeExecutor({
        session: 's-1',
        finish: { state: 'finished', sessionId: 's-1' },
      })
    );
    const messaging = await openRecovered(project.root(), orchestrator, store);
    const task = store.create({ title: 'Ship the cart' });
    const first = await orchestrator.dispatch(task.meta.id, 'agent', {});
    await waitFor(
      () => orchestrator.getRun(first.id)?.meta.state === 'finished'
    );
    const stalling = new StallingExecutor();
    orchestrator.registerExecutor('agent', stalling);

    await messaging.engine.send(
      {
        to: [`task:${task.meta.id}`],
        kind: 'message',
        body: 'Please also cover the empty cart',
        wake: 'request',
      },
      HUMAN
    );

    expect(messaging.engine.openBlocking()).toEqual([]);
    const next = orchestrator.list().find((r) => r.resumedFrom === first.id);
    expect(next?.worktreePath).toBe(first.worktreePath);
    expect(stalling.started[0]?.resumeSessionId).toBe('s-1');
    await waitFor(() =>
      stalling.sent.some((s) => s.includes('Please also cover the empty cart'))
    );
    if (next !== undefined) await orchestrator.cancel(next.id);
    messaging.close();
  });

  it("a human's wake of one run continues that run, not the task's newest", async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    const finishing = (session: string) =>
      new FakeExecutor({
        session,
        finish: { state: 'finished', sessionId: session },
      });
    const messaging = await openRecovered(project.root(), orchestrator, store);
    const task = store.create({ title: 'Two attempts' });
    orchestrator.registerExecutor('agent', finishing('s-1'));
    const older = await orchestrator.dispatch(task.meta.id, 'agent', {});
    await waitFor(
      () => orchestrator.getRun(older.id)?.meta.state === 'finished'
    );
    orchestrator.registerExecutor('agent', finishing('s-2'));
    const newer = await orchestrator.dispatch(task.meta.id, 'agent', {});
    await waitFor(
      () => orchestrator.getRun(newer.id)?.meta.state === 'finished'
    );
    const stalling = new StallingExecutor();
    orchestrator.registerExecutor('agent', stalling);

    await messaging.engine.send(
      {
        to: [`run:${older.id}`],
        kind: 'message',
        body: 'rename foo to bar',
        wake: 'request',
      },
      HUMAN
    );

    const next = orchestrator.list().find((r) => r.resumedFrom !== undefined);
    expect(next?.resumedFrom).toBe(older.id);
    expect(next?.worktreePath).toBe(older.worktreePath);
    expect(stalling.started[0]?.resumeSessionId).toBe('s-1');
    await waitFor(() =>
      stalling.sent.some((s) => s.includes('rename foo to bar'))
    );
    if (next !== undefined) await orchestrator.cancel(next.id);
    messaging.close();
  });

  it('tells the human why a woken run cannot be continued', async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    orchestrator.registerExecutor(
      'agent',
      new FakeExecutor({
        session: 's-1',
        finish: { state: 'finished', sessionId: 's-1' },
      })
    );
    const messaging = await openRecovered(project.root(), orchestrator, store);
    const task = store.create({ title: 'Reviewed already' });
    const run = await orchestrator.dispatch(task.meta.id, 'agent', {});
    await waitFor(() => orchestrator.getRun(run.id)?.meta.state === 'finished');
    orchestrator.review(run.id, 'discard');

    await messaging.engine.send(
      {
        to: [`run:${run.id}`],
        kind: 'message',
        body: 'one more thing',
        wake: 'request',
      },
      HUMAN
    );

    expect(orchestrator.list()).toHaveLength(1);
    const notices = messaging.engine
      .inbox('human:wyat')
      .filter((i) => i.message.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message.body).toStartWith(
      `Could not wake run:${run.id}: run has already been reviewed (discarded)`
    );
    messaging.close();
  });

  it('a human wake of a task that never ran dispatches it with no gate', async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    const stalling = new StallingExecutor();
    orchestrator.registerExecutor('claude', stalling);
    const messaging = await openRecovered(project.root(), orchestrator, store);
    const task = store.create({ title: 'Fresh' });
    await messaging.engine.send(
      {
        to: [`task:${task.meta.id}`],
        kind: 'message',
        body: 'start please',
        wake: 'request',
      },
      HUMAN
    );
    expect(messaging.engine.openBlocking()).toEqual([]);
    await waitFor(() => stalling.sent.some((s) => s.includes('start please')));
    for (const run of orchestrator.list()) await orchestrator.cancel(run.id);
    messaging.close();
  });

  it("an agent's wake still asks the owner below rung 3", async () => {
    const { orchestrator, store } = makeOrchestrator(project.root());
    orchestrator.registerExecutor('stalling', new StallingExecutor());
    const messaging = await openRecovered(project.root(), orchestrator, store);
    const asker = store.create({ title: 'Asker' });
    const sleeper = store.create({ title: 'Sleeper' });
    const meta = await orchestrator.dispatch(asker.meta.id, 'stalling', {});
    await messaging.engine.send(
      {
        to: [`task:${sleeper.meta.id}`],
        kind: 'message',
        body: 'wake',
        wake: 'request',
      },
      { address: `run:${meta.id}`, canDecide: false }
    );
    expect(messaging.engine.openBlocking()[0]?.data).toMatchObject({
      type: 'wake',
      target: `task:${sleeper.meta.id}`,
    });
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('an agent wake at rung 3 never continues a finished run, even one whose base needs a human', async () => {
    mkdirSync(join(project.root(), '.dispatch'), { recursive: true });
    writeFileSync(
      join(project.root(), '.dispatch', 'config.yml'),
      'policy:\n  rung: 3\n'
    );
    const { orchestrator, store } = makeOrchestrator(project.root());
    orchestrator.registerExecutor(
      'agent',
      new FakeExecutor({
        session: 's-1',
        finish: { state: 'finished', sessionId: 's-1' },
      })
    );
    orchestrator.registerExecutor('stalling', new StallingExecutor());
    const messaging = await openRecovered(project.root(), orchestrator, store);
    const sleeper = store.create({ title: 'Finished work' });
    const first = await orchestrator.dispatch(sleeper.meta.id, 'agent', {});
    await waitFor(
      () => orchestrator.getRun(first.id)?.meta.state === 'finished'
    );
    orchestrator.flagRunRestackFailure(first.id, 'its base was discarded');
    const asker = store.create({ title: 'Asker' });
    const meta = await orchestrator.dispatch(asker.meta.id, 'stalling', {});

    await messaging.engine.send(
      {
        to: [`task:${sleeper.meta.id}`],
        kind: 'message',
        body: 'please redo',
        wake: 'request',
      },
      { address: `run:${meta.id}`, canDecide: false }
    );

    expect(messaging.engine.openBlocking()).toEqual([]);
    expect(orchestrator.list().some((r) => r.resumedFrom === first.id)).toBe(
      false
    );
    expect(orchestrator.getRun(first.id)?.meta.baseDiscarded).toBe(true);
    for (const run of orchestrator.list())
      if (!TERMINAL_RUN_STATES.has(run.state))
        await orchestrator.cancel(run.id);
    messaging.close();
  });
});
