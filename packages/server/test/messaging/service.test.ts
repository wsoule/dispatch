import { TaskStore } from '@dispatch/core';
import type { Delivery, Message } from '@dispatch/protocol';
import {
  openMessagesDb,
  SqliteMessageStore,
  SYSTEM_ADDRESS,
} from '@dispatch/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import type { ServerEvent } from '../../src/events.js';
import { EventBus } from '../../src/events.js';
import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { createRunTokens } from '../../src/messaging/runTokens.js';
import {
  hasNonTerminalRun,
  openMessaging,
} from '../../src/messaging/service.js';
import {
  BOOT_FORCE_FAIL_ERROR,
  Orchestrator,
} from '../../src/orchestrator/orchestrator.js';
import { runsDir } from '../../src/orchestrator/paths.js';
import type { RunMeta } from '../../src/orchestrator/types.js';
import { initGitRepo, StallingExecutor } from '../orchestrator/helpers.js';

// Waits for `check` to become true, polling rather than sleeping a fixed
// amount — the delivery/run-start flows here settle asynchronously.
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function stubMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-00000000000000000000000000',
    thread: 'm-00000000000000000000000000',
    replyTo: null,
    from: 'human:wyat',
    to: ['human:ada'],
    kind: 'message',
    body: 'hello',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  };
}

function stubDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd-00000000000000000000000000',
    messageId: 'm-00000000000000000000000000',
    recipient: 'run:r-000001',
    runId: 'r-000001',
    via: 'direct',
    state: 'sending',
    updatedAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  };
}

// A minimal-but-complete RunMeta for hasNonTerminalRun's pure-function tests.
function stubRun(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-000001',
    taskId: 't-000001',
    taskTitle: 'stub',
    executor: 'claude',
    state: 'running',
    branch: 'dispatch/t-000001-stub',
    baseBranch: 'main',
    worktreePath: '/tmp/nonexistent',
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  };
}

let seededWakes = 0;

// Stores a wake gate for `target`, raised by a message from `from`, and an
// 'approve' answer to it, as recover() would find them after a crash.
function seedApprovedWake(
  messaging: ReturnType<typeof openMessaging>,
  opts: { from: string; target: string }
): { question: Message; answer: Message } {
  seededWakes += 1;
  const n = String(seededWakes).padStart(6, '0');
  const original = stubMessage({
    id: `m-original${n}`,
    thread: `m-original${n}`,
    from: opts.from,
    to: [opts.target],
    wake: 'request',
  });
  const question = stubMessage({
    id: `m-question${n}`,
    thread: `m-question${n}`,
    from: SYSTEM_ADDRESS,
    to: ['human:wyat'],
    kind: 'question',
    blocking: true,
    choices: ['approve', 'deny'],
    data: { type: 'wake', target: opts.target, message: original.id },
  });
  const answer = stubMessage({
    id: `m-answer${n}`,
    thread: question.thread,
    replyTo: question.id,
    from: 'human:wyat',
    to: [SYSTEM_ADDRESS],
    kind: 'answer',
    choice: 'approve',
  });
  messaging.store.insertMessage(original);
  messaging.store.insertMessage(question);
  messaging.store.insertMessage(answer);
  return { question, answer };
}

let root: string;
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-messaging-service-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function makeOrchestrator(): { orchestrator: Orchestrator; store: TaskStore } {
  const store = TaskStore.init(root);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: root,
    store,
    cache,
    events,
  });
  return { orchestrator, store };
}

describe('hasNonTerminalRun', () => {
  it('counts a provisioning run as non-terminal (not only running/awaiting-approval)', () => {
    const runs = [stubRun({ taskId: 't-1', state: 'provisioning' })];
    expect(hasNonTerminalRun(runs, 't-1')).toBe(true);
  });

  it('is false when every run for the task is terminal', () => {
    const runs = [
      stubRun({ taskId: 't-1', state: 'finished' }),
      stubRun({ id: 'r-2', taskId: 't-1', state: 'failed' }),
    ];
    expect(hasNonTerminalRun(runs, 't-1')).toBe(false);
  });

  it('ignores runs belonging to a different task', () => {
    const runs = [stubRun({ taskId: 't-2', state: 'running' })];
    expect(hasNonTerminalRun(runs, 't-1')).toBe(false);
  });
});

describe('openMessaging', () => {
  it('boot recovers before serving', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const dbPath = join(root, 'messages.db');
    // Seed a message.db as if a crash caught a delivery mid-send to a run
    // that is no longer live (dispatchd never registered it this boot).
    const seedDb = openMessagesDb(dbPath);
    const seedStore = new SqliteMessageStore(seedDb);
    const message = stubMessage({ to: ['run:r-000001'] });
    const delivery = stubDelivery();
    seedStore.insertMessage(message);
    seedStore.insertDelivery(delivery);
    seedDb.close();

    const events = new EventBus();
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath,
    });
    await messaging.recover();
    const stored = messaging.store.getDelivery(delivery.id);
    expect(stored?.state).toBe('held');
    expect(stored?.runId).toBeNull();
    messaging.close();
  });

  it('bridges engine events to the bus', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const events = new EventBus();
    const seen: ServerEvent[] = [];
    events.subscribe((e) => {
      if (e.type === 'message.new' || e.type === 'delivery.changed') {
        seen.push(e);
      }
    });
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();
    await messaging.engine.send(
      { to: ['human:ada'], kind: 'message', body: 'hi there' },
      { address: 'human:wyat', canDecide: true }
    );
    expect(seen.map((e) => e.type)).toEqual([
      'message.new',
      'delivery.changed',
    ]);
    messaging.close();
  });

  it('delivers held messages when a run starts', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stalling', executor);
    const task = store.create({ title: 'Read the mail' });
    const events = new EventBus();
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();

    // No run yet: this send is held on the task.
    await messaging.engine.send(
      {
        to: [`task:${task.meta.id}`],
        kind: 'message',
        body: 'are you there?',
      },
      { address: 'human:wyat', canDecide: true }
    );

    const meta = await orchestrator.dispatch(task.meta.id, 'stalling', {});
    await waitFor(() =>
      executor.sent.some((s) => s.includes('are you there?'))
    );
    // Cancel the still-live stalling run before the temp worktree/root this
    // test cleans up in afterEach is removed out from under it.
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('keeps task mail away from a review run and hands it to the next execute run', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('claude', executor);
    const task = store.create({ title: 'Under review' });
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events: new EventBus(),
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();
    const human = { address: 'human:wyat', canDecide: true };

    const before = await messaging.engine.send(
      { to: [`task:${task.meta.id}`], kind: 'message', body: 'held early' },
      human
    );
    const review = await orchestrator.dispatchAuxRun({
      taskId: task.meta.id,
      kind: 'review',
      head: 'main',
      buildPrompt: () => 'review this',
    });
    const during = await messaging.engine.send(
      { to: [`task:${task.meta.id}`], kind: 'message', body: 'held late' },
      human
    );
    expect(during.deliveries[0]?.state).toBe('held');
    expect(messaging.store.getDelivery(before.deliveries[0].id)?.state).toBe(
      'held'
    );
    await orchestrator.cancel(review.id);
    expect(executor.sent).toEqual([]);

    const run = await orchestrator.dispatch(task.meta.id, 'claude', {});
    await waitFor(
      () =>
        executor.sent.some((s) => s.includes('held early')) &&
        executor.sent.some((s) => s.includes('held late'))
    );
    await orchestrator.cancel(run.id);
    messaging.close();
  });

  it("answers a review run's question after it ended, keeping the answer off the task", async () => {
    const { orchestrator, store } = makeOrchestrator();
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('claude', executor);
    const task = store.create({ title: 'Under review' });
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events: new EventBus(),
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();
    const human = { address: 'human:wyat', canDecide: true };

    const review = await orchestrator.dispatchAuxRun({
      taskId: task.meta.id,
      kind: 'review',
      head: 'main',
      buildPrompt: () => 'review this',
    });
    const question = await messaging.engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        body: 'Is the migration safe?',
        blocking: true,
      },
      { address: `run:${review.id}`, canDecide: false }
    );
    await orchestrator.cancel(review.id);

    const answer = await messaging.engine.reply(
      question.message.id,
      { body: 'reviewer answer' },
      human
    );
    expect(answer.message.to).toEqual([`run:${review.id}`]);
    expect(answer.deliveries).toEqual([
      expect.objectContaining({ runId: null, state: 'held' }),
    ]);
    expect(messaging.engine.openBlocking()).toEqual([]);

    // deliverHeld claims every held row it will move at once, so once the
    // task's own mail leaves `held`, the reviewer's answer was passed over.
    const forTask = await messaging.engine.send(
      { to: [`task:${task.meta.id}`], kind: 'message', body: 'implementer' },
      human
    );
    const run = await orchestrator.dispatch(task.meta.id, 'claude', {});
    await waitFor(
      () =>
        messaging.store.getDelivery(forTask.deliveries[0].id)?.state !== 'held'
    );
    expect(messaging.store.getDelivery(answer.deliveries[0].id)).toMatchObject({
      runId: null,
      state: 'held',
    });
    await orchestrator.cancel(run.id);
    messaging.close();
  });

  it('opens with default limits when config.yml is malformed', async () => {
    const { orchestrator, store } = makeOrchestrator();
    writeFileSync(join(root, '.dispatch/config.yml'), 'statuses: [a\n');
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events: new EventBus(),
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();
    const sent = await messaging.engine.send(
      { to: ['human:ada'], kind: 'message', body: 'still up' },
      { address: 'human:wyat', canDecide: true }
    );
    expect(sent.message.body).toBe('still up');
    messaging.close();
  });
});

describe('wake gate handler', () => {
  it('approve dispatches the task', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('claude', executor);
    const task = store.create({ title: 'Wake me' });
    const events = new EventBus();
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();

    // Held (no live run) + wake:'request' makes the engine itself raise the
    // wake gate question to the owner, at the default policy rung (ask).
    await messaging.engine.send(
      {
        to: [`task:${task.meta.id}`],
        kind: 'message',
        body: 'please wake up',
        wake: 'request',
      },
      { address: 'human:asker', canDecide: true }
    );
    const [question] = messaging.engine.openBlocking();
    expect(question).toBeDefined();

    await messaging.engine.reply(
      question.id,
      { body: 'approved', choice: 'approve' },
      { address: 'human:wyat', canDecide: true }
    );

    expect(executor.started).toHaveLength(1);
    expect(orchestrator.list().some((r) => r.taskId === task.meta.id)).toBe(
      true
    );
    await orchestrator.cancel(orchestrator.list()[0].id);
    messaging.close();
  });

  it('is a no-op replay when the task already has a live run', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('claude', executor);
    const task = store.create({ title: 'Wake me' });
    const events = new EventBus();
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();

    const meta = await orchestrator.dispatch(task.meta.id, 'claude', {});
    expect(executor.started).toHaveLength(1);

    // Hand-built as if recover() replayed it: an approved wake for a task that
    // already has a live run by the time it replays.
    const original = stubMessage({
      id: 'm-original000000000000000001',
      thread: 'm-original000000000000000001',
      from: 'human:asker',
      to: [`task:${task.meta.id}`],
      wake: 'request',
    });
    const question = stubMessage({
      id: 'm-question000000000000000001',
      thread: 'm-question000000000000000001',
      from: SYSTEM_ADDRESS,
      to: ['human:wyat'],
      kind: 'question',
      blocking: true,
      choices: ['approve', 'deny'],
      data: {
        type: 'wake',
        target: `task:${task.meta.id}`,
        message: original.id,
      },
    });
    const answer = stubMessage({
      id: 'm-answer0000000000000000001',
      thread: question.thread,
      replyTo: question.id,
      from: 'human:wyat',
      to: [SYSTEM_ADDRESS],
      kind: 'answer',
      choice: 'approve',
    });
    messaging.store.insertMessage(original);
    messaging.store.insertMessage(question);
    messaging.store.insertMessage(answer);
    const wakes: string[] = [];
    const dispatchOrResume = orchestrator.dispatchOrResume.bind(orchestrator);
    orchestrator.dispatchOrResume = (taskId, request) => {
      wakes.push(taskId);
      return dispatchOrResume(taskId, request);
    };

    await messaging.gates.handle(question, answer);

    expect(executor.started).toHaveLength(1);
    expect(wakes).toEqual([]);
    expect(
      messaging.engine
        .inbox('human:asker')
        .filter((i) => i.message.kind === 'notice')
    ).toEqual([]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('is a no-op replay while the task has a provisioning run', async () => {
    const store = TaskStore.init(root);
    const task = store.create({ title: 'Coming up' });
    const wakes: string[] = [];
    const orchestrator = {
      setRunTokenMinter: () => {},
      onRunStarted: () => () => {},
      list: () => [stubRun({ taskId: task.meta.id, state: 'provisioning' })],
      liveRunIdForTask: () => null,
      isRunLive: () => false,
      taskIdOfRun: () => null,
      deliverToRun: () => {},
      notifyRun: () => {},
      dispatchOrResume: (taskId: string) => {
        wakes.push(taskId);
        return Promise.resolve(stubRun({ id: 'r-000009', taskId }));
      },
    } as unknown as Orchestrator;
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events: new EventBus(),
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    const { question, answer } = seedApprovedWake(messaging, {
      from: 'human:asker',
      target: `task:${task.meta.id}`,
    });

    await messaging.gates.handle(question, answer);

    expect(wakes).toEqual([]);
    messaging.close();
  });

  it('tells a sender whose run has ended through its task, and never replays the wake', async () => {
    const { orchestrator, store } = makeOrchestrator();
    // Only 'stalling' is registered, so waking onto the default executor fails.
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stalling', executor);
    const asking = store.create({ title: 'Asking task' });
    const sleeping = store.create({ title: 'Sleeping task' });
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events: new EventBus(),
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();

    const run = await orchestrator.dispatch(asking.meta.id, 'stalling', {});
    await messaging.engine.send(
      {
        to: [`task:${sleeping.meta.id}`],
        kind: 'message',
        body: 'wake up',
        wake: 'request',
      },
      { address: `run:${run.id}`, canDecide: false }
    );
    const [question] = messaging.engine.openBlocking();
    await orchestrator.cancel(run.id);
    await messaging.engine.reply(
      question.id,
      { body: 'approved', choice: 'approve' },
      { address: 'human:wyat', canDecide: true }
    );

    const notice = messaging.engine
      .inbox(`task:${asking.meta.id}`)
      .find((i) => i.message.kind === 'notice');
    expect(notice?.message.body).toContain(
      `Could not wake task:${sleeping.meta.id}`
    );
    expect(notice?.delivery.state).toBe('held');
    expect(messaging.store.unappliedAnsweredGates()).toEqual([]);

    orchestrator.registerExecutor('claude', executor);
    expect((await messaging.recover()).replayed).toBe(0);
    expect(
      orchestrator.list().filter((r) => r.taskId === sleeping.meta.id)
    ).toEqual([]);
    messaging.close();
  });

  it('marks the wake applied even when its failure notice cannot be delivered', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const sleeping = store.create({ title: 'Sleeping task' });
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events: new EventBus(),
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();

    // A run this daemon has no record of: its notice has nowhere to go.
    await messaging.engine.send(
      {
        to: [`task:${sleeping.meta.id}`],
        kind: 'message',
        body: 'wake up',
        wake: 'request',
      },
      { address: 'run:r-0000ff', canDecide: false }
    );
    const [question] = messaging.engine.openBlocking();
    await messaging.engine.reply(
      question.id,
      { body: 'approved', choice: 'approve' },
      { address: 'human:wyat', canDecide: true }
    );

    expect(messaging.store.unappliedAnsweredGates()).toEqual([]);
    expect((await messaging.recover()).replayed).toBe(0);
    messaging.close();
  });

  for (const status of ['dropped', 'landed'] as const) {
    it(`does not wake a task that became ${status} before the approval`, async () => {
      const { orchestrator, store } = makeOrchestrator();
      const executor = new StallingExecutor();
      orchestrator.registerExecutor('claude', executor);
      const task = store.create({ title: 'Closed out later' });
      const messaging = openMessaging({
        rootDir: root,
        orchestrator,
        store,
        events: new EventBus(),
        ownerRef: 'human:wyat',
        dbPath: join(root, 'messages.db'),
      });
      await messaging.recover();

      await messaging.engine.send(
        {
          to: [`task:${task.meta.id}`],
          kind: 'message',
          body: 'wake up',
          wake: 'request',
        },
        { address: 'human:asker', canDecide: true }
      );
      const [question] = messaging.engine.openBlocking();
      store.update(task.meta.id, { status });
      await messaging.engine.reply(
        question.id,
        { body: 'approved', choice: 'approve' },
        { address: 'human:wyat', canDecide: true }
      );

      expect(executor.started).toHaveLength(0);
      expect(store.get(task.meta.id)?.meta.status).toBe(status);
      const notices = messaging.engine
        .inbox('human:asker')
        .filter((i) => i.message.kind === 'notice')
        .map((i) => i.message.body);
      expect(notices).toEqual([
        `Not woken: task ${task.meta.id} is ${status}.`,
      ]);
      messaging.close();
    });
  }

  it('does not wake an epic or a missing task on replay', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('claude', executor);
    const epic = store.create({ title: 'An epic', kind: 'epic' });
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events: new EventBus(),
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();

    for (const target of [`task:${epic.meta.id}`, 'task:t-000000']) {
      const { question, answer } = seedApprovedWake(messaging, {
        from: 'human:asker',
        target,
      });
      await messaging.gates.handle(question, answer);
    }

    expect(executor.started).toHaveLength(0);
    const notices = messaging.engine
      .inbox('human:asker')
      .filter((i) => i.message.kind === 'notice')
      .map((i) => i.message.body);
    expect(notices).toEqual([
      `Not woken: task ${epic.meta.id} is an epic.`,
      'Not woken: task t-000000 is missing.',
    ]);
    messaging.close();
  });

  it('sends a notice to the original sender when the wake fails', async () => {
    // No executor registered at all: dispatchOrResume's default executor
    // name will never resolve, so host.wake() reports { ok: false }.
    const { orchestrator, store } = makeOrchestrator();
    const task = store.create({ title: 'Wake me' });
    const events = new EventBus();
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();

    await messaging.engine.send(
      {
        to: [`task:${task.meta.id}`],
        kind: 'message',
        body: 'ping',
        wake: 'request',
      },
      { address: 'human:asker', canDecide: true }
    );
    const [question] = messaging.engine.openBlocking();
    await messaging.engine.reply(
      question.id,
      { body: 'approved', choice: 'approve' },
      { address: 'human:wyat', canDecide: true }
    );

    const notice = messaging.engine
      .inbox('human:asker')
      .find((i) => i.message.kind === 'notice');
    expect(notice?.message.body).toContain('Could not wake');
    messaging.close();
  });
});

describe('agent-registration gate handler', () => {
  function seedPendingAgent(messaging: ReturnType<typeof openMessaging>) {
    messaging.store.putAgent({
      address: 'agent:reviewer',
      displayName: 'Reviewer',
      client: 'test-client',
      tokenHash: 'hash',
      status: 'pending',
      muted: false,
      approvedBy: null,
      createdAt: '2026-09-23T10:00:00.000Z',
    });
  }

  function registrationQuestion(): Message {
    return stubMessage({
      id: 'm-question0000000000000000001',
      thread: 'm-question0000000000000000001',
      from: SYSTEM_ADDRESS,
      to: ['human:wyat'],
      kind: 'question',
      blocking: true,
      choices: ['approve', 'deny'],
      data: {
        type: 'agent-registration',
        agent: 'agent:reviewer',
        client: 'test-client',
      },
    });
  }

  it('approve sets the agent approved with approvedBy the answerer', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const events = new EventBus();
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();
    seedPendingAgent(messaging);
    const question = registrationQuestion();
    const answer = stubMessage({
      id: 'm-answer0000000000000000001',
      thread: question.thread,
      replyTo: question.id,
      from: 'human:wyat',
      to: [SYSTEM_ADDRESS],
      kind: 'answer',
      choice: 'approve',
    });

    await messaging.gates.handle(question, answer);

    const agent = messaging.store.getAgent('agent:reviewer');
    expect(agent?.status).toBe('approved');
    expect(agent?.approvedBy).toBe('human:wyat');
    messaging.close();
  });

  it('deny sets the agent revoked with no approver', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const events = new EventBus();
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();
    seedPendingAgent(messaging);
    const question = registrationQuestion();
    const answer = stubMessage({
      id: 'm-answer0000000000000000002',
      thread: question.thread,
      replyTo: question.id,
      from: 'human:wyat',
      to: [SYSTEM_ADDRESS],
      kind: 'answer',
      choice: 'deny',
    });

    await messaging.gates.handle(question, answer);

    const agent = messaging.store.getAgent('agent:reviewer');
    expect(agent?.status).toBe('revoked');
    expect(agent?.approvedBy).toBeNull();
    messaging.close();
  });

  it('a repeated (replayed) answer for an already-applied status is a no-op', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const events = new EventBus();
    const messaging = openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.recover();
    seedPendingAgent(messaging);
    const question = registrationQuestion();
    const firstAnswer = stubMessage({
      id: 'm-answer0000000000000000003',
      thread: question.thread,
      replyTo: question.id,
      from: 'human:alice',
      to: [SYSTEM_ADDRESS],
      kind: 'answer',
      choice: 'approve',
    });
    await messaging.gates.handle(question, firstAnswer);
    expect(messaging.store.getAgent('agent:reviewer')?.approvedBy).toBe(
      'human:alice'
    );

    // A second, different answerer replaying the same already-applied
    // decision must not overwrite who actually approved it.
    const secondAnswer = stubMessage({
      ...firstAnswer,
      id: 'm-answer0000000000000000004',
      from: 'human:bob',
    });
    await messaging.gates.handle(question, secondAnswer);
    expect(messaging.store.getAgent('agent:reviewer')?.approvedBy).toBe(
      'human:alice'
    );
    messaging.close();
  });
});

describe('boot ordering', () => {
  // recover() must run after reconcileOnBoot(), or a replayed wake's run is
  // force-failed as an orphan of the previous process.
  it('a wake approved before a crash dispatches cleanly on the next boot, without being force-failed', async () => {
    const store = TaskStore.init(root);
    const task = store.create({ title: 'Wake me on reboot' });

    const dbPath = join(runsDir(root), 'messages.db');
    const seedDb = openMessagesDb(dbPath);
    const seedStore = new SqliteMessageStore(seedDb);
    const original = stubMessage({
      id: 'm-original0000000000000001',
      thread: 'm-original0000000000000001',
      from: 'human:asker',
      to: [`task:${task.meta.id}`],
      wake: 'request',
    });
    const question = stubMessage({
      id: 'm-question0000000000000001',
      thread: 'm-question0000000000000001',
      from: SYSTEM_ADDRESS,
      to: ['human:wyat'],
      kind: 'question',
      blocking: true,
      choices: ['approve', 'deny'],
      data: {
        type: 'wake',
        target: `task:${task.meta.id}`,
        message: original.id,
      },
    });
    const answer = stubMessage({
      id: 'm-answer00000000000000001',
      thread: question.thread,
      replyTo: question.id,
      from: 'human:wyat',
      to: [SYSTEM_ADDRESS],
      kind: 'answer',
      choice: 'approve',
    });
    seedStore.insertMessage(original);
    seedStore.insertMessage(question);
    // No gate_effects row: this answer's effect was never recorded, as if
    // the daemon crashed between the answer landing and the wake running.
    seedStore.insertMessage(answer);
    seedDb.close();

    const executor = new StallingExecutor();
    let handle: ServerHandle | undefined;
    try {
      handle = await startServer({
        rootDir: root,
        port: 0,
        writeDaemonFile: false,
        registerExecutors: (orchestrator) => {
          orchestrator.registerExecutor('claude', executor);
        },
      });
      const runs = handle.orchestrator
        .list()
        .filter((r) => r.taskId === task.meta.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.state).not.toBe('failed');
      expect(runs[0]?.error).not.toBe(BOOT_FORCE_FAIL_ERROR);
    } finally {
      await handle?.stop();
    }
  });
});

describe('run tokens', () => {
  it('round-trip and reject tampering', () => {
    const tokens = createRunTokens(Buffer.from('a-fixed-test-secret'));
    const minted = tokens.mint('r-000001');
    expect(tokens.verify(minted)).toBe('r-000001');

    const forged = `r-000002.${minted.split('.')[1]}`;
    expect(tokens.verify(forged)).toBeNull();
    expect(tokens.verify('garbage')).toBeNull();
  });
});
