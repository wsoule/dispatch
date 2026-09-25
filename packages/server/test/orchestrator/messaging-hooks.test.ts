import type {
  McpStdioServerConfig,
  Options,
  Query,
} from '@anthropic-ai/claude-agent-sdk';
import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import type { ServerEvent } from '../../src/events.js';
import { EventBus } from '../../src/events.js';
import type { Messaging } from '../../src/messaging/service.js';
import { openMessaging } from '../../src/messaging/service.js';
import { ClaudeExecutor } from '../../src/orchestrator/executors/claude.js';
import type { CliSpawner } from '../../src/orchestrator/executors/cli.js';
import { CliExecutor } from '../../src/orchestrator/executors/cli.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { runTokenPath } from '../../src/orchestrator/paths.js';
import type { RunRegistry } from '../../src/orchestrator/registry.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  NormalizedEntry,
} from '../../src/orchestrator/types.js';
import { OrchestratorConflictError } from '../../src/orchestrator/types.js';
import { initGitRepo, StallingExecutor } from './helpers.js';

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

function makeOrchestrator(rootDir: string): {
  orchestrator: Orchestrator;
  store: TaskStore;
  events: EventBus;
} {
  const store = TaskStore.init(rootDir);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({ rootDir, store, cache, events });
  return { orchestrator, store, events };
}

async function openTestMessaging(
  orchestrator: Orchestrator,
  store: TaskStore,
  events: EventBus
): Promise<Messaging> {
  const messaging = openMessaging({
    rootDir: repo,
    orchestrator,
    store,
    events,
    ownerRef: 'human:wyat',
    dbPath: join(fakeHome, 'messages.db'),
  });
  await messaging.recover();
  return messaging;
}

// Re-registers a run's meta without its ExecutorRun: the zombie a daemon
// restart leaves behind (live state, nothing running it).
function dropExecutorRun(orchestrator: Orchestrator, runId: string): void {
  const registry = (orchestrator as unknown as { registry: RunRegistry })
    .registry;
  registry.create({ ...orchestrator.getRun(runId)!.meta });
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await Bun.sleep(10);
  }
}

// A CLI agent process that keeps running until it is killed.
function hangingCliSpawner(): CliSpawner {
  return () => {
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          streams.push(controller);
        },
      });
    let exit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    return {
      stdout: stream(),
      stderr: stream(),
      exited,
      writeStdin: () => {},
      closeStdin: () => {},
      kill: () => {
        for (const controller of streams) controller.close();
        exit(143);
      },
    };
  };
}

// A live run whose interrupt() waits until the test releases it, so a test can
// act while a cancel is still in progress.
class SlowInterruptExecutor implements Executor {
  readonly sent: string[] = [];
  readonly notified: string[] = [];
  private releaseInterrupt: () => void = () => {};
  private readonly interrupted = new Promise<void>((resolve) => {
    this.releaseInterrupt = resolve;
  });

  release(): void {
    this.releaseInterrupt();
  }

  start(): ExecutorRun {
    return {
      interrupt: () => this.interrupted,
      requestStop: () => {},
      send: (message) => {
        this.sent.push(message);
      },
      approve: () => {},
      notify: (text) => {
        this.notified.push(text);
      },
    };
  }
}

// An Agent SDK session that produces nothing until it is interrupted, so the
// run it backs stays live.
function hangingQuery(): Query {
  let end: () => void = () => {};
  const ended = new Promise<IteratorResult<never, undefined>>((resolve) => {
    end = () => resolve({ done: true, value: undefined });
  });
  const session = {
    next: () => ended,
    return: () => {
      end();
      return ended;
    },
    [Symbol.asyncIterator]: () => session,
    interrupt: () => {
      end();
      return Promise.resolve();
    },
    close: () => end(),
  };
  return session as unknown as Query;
}

// A run that finishes only when the test calls finish().
class FinishOnDemandExecutor implements Executor {
  private events: ExecutorEvents | undefined;

  finish(): void {
    this.events?.onFinish({ state: 'finished' });
  }

  start(_opts: unknown, events: ExecutorEvents): ExecutorRun {
    this.events = events;
    return {
      interrupt: () => Promise.resolve(),
      requestStop: () => {},
      send: () => {},
      approve: () => {},
      notify: () => {},
    };
  }
}

// A Claude session that reports its result, then holds its wind-down until
// the test calls releaseWindDown(); windingDown resolves once it is there.
function windingDownClaude(): {
  executor: ClaudeExecutor;
  windingDown: Promise<void>;
  releaseWindDown: () => void;
} {
  let reachWindDown!: () => void;
  const windingDown = new Promise<void>((resolve) => {
    reachWindDown = resolve;
  });
  let releaseWindDown!: () => void;
  const windDownHeld = new Promise<void>((resolve) => {
    releaseWindDown = resolve;
  });
  const executor = new ClaudeExecutor(() => {
    const messages = (function* (): Generator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: 's' };
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
        session_id: 's',
        result: 'done',
        terminal_reason: 'completed',
        modelUsage: {},
        errors: [],
      };
    })();
    return Object.assign(messages, {
      stopTask: () => Promise.resolve(),
      applyFlagSettings: () => {
        reachWindDown();
        return windDownHeld;
      },
      interrupt: () => Promise.resolve(),
      close: () => {},
    }) as unknown as Query;
  });
  return { executor, windingDown, releaseWindDown };
}

describe('Orchestrator messaging hooks', () => {
  it('mints a run token at start and fires onRunStarted', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stall', executor);
    const task = store.create({ title: 'Task' });

    orchestrator.setRunTokenMinter((id) => `${id}.tok`);
    const started: string[] = [];
    orchestrator.onRunStarted((m) => started.push(m.id));

    const meta = await orchestrator.dispatch(task.meta.id, 'stall');

    expect(started).toEqual([meta.id]);
    expect(executor.lastRunToken).toBe(`${meta.id}.tok`);
    expect(orchestrator.liveRunIdForTask(task.meta.id)).toBe(meta.id);
    expect(orchestrator.taskIdOfRun(meta.id)).toBe(task.meta.id);
    expect(orchestrator.isRunLive(meta.id)).toBe(true);
  });

  it('gives the MCP a 0600 run token file, never the token, and removes it when the run ends', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    let captured: Options | undefined;
    orchestrator.registerExecutor(
      'claude',
      new ClaudeExecutor((args: { options?: Options }) => {
        captured = args.options;
        return hangingQuery();
      })
    );
    orchestrator.setRunTokenMinter((id) => `${id}.SECRET-RUN-TOKEN`);
    const task = store.create({ title: 'Task' });

    const meta = await orchestrator.dispatch(task.meta.id, 'claude');
    const token = `${meta.id}.SECRET-RUN-TOKEN`;

    expect(JSON.stringify(captured)).not.toContain(token);
    expect(Object.values(process.env)).not.toContain(token);
    const dispatch = captured?.mcpServers?.dispatch as McpStdioServerConfig;
    const file = dispatch.env?.DISPATCH_RUN_TOKEN_FILE;
    expect(file).toBe(runTokenPath(repo, meta.id));
    expect(readFileSync(file!, 'utf8')).toBe(token);
    expect(statSync(file!).mode & 0o777).toBe(0o600);

    await orchestrator.cancel(meta.id);
    expect(existsSync(file!)).toBe(false);
  });

  it('removes the run token file when the run finishes on its own', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new FinishOnDemandExecutor();
    orchestrator.registerExecutor('finisher', executor);
    orchestrator.setRunTokenMinter((id) => `${id}.tok`);
    const task = store.create({ title: 'Task' });

    const meta = await orchestrator.dispatch(task.meta.id, 'finisher');
    const file = runTokenPath(repo, meta.id);
    expect(existsSync(file)).toBe(true);

    executor.finish();
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('finished');
    expect(existsSync(file)).toBe(false);
  });

  it('removes a crashed run token file at boot', async () => {
    const first = makeOrchestrator(repo);
    first.orchestrator.registerExecutor('stall', new StallingExecutor());
    first.orchestrator.setRunTokenMinter((id) => `${id}.tok`);
    const task = first.store.create({ title: 'Task' });
    const meta = await first.orchestrator.dispatch(task.meta.id, 'stall');
    const file = runTokenPath(repo, meta.id);
    expect(existsSync(file)).toBe(true);

    const rebooted = makeOrchestrator(repo);
    rebooted.orchestrator.reconcileOnBoot();

    expect(rebooted.orchestrator.getRun(meta.id)?.meta.state).toBe('failed');
    expect(existsSync(file)).toBe(false);
  });

  it('replaces a leftover run token file with a fresh 0600 one', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stall', executor);
    // Minting runs just before the file is written, so it can plant a stale,
    // world-readable file at the run's token path first.
    orchestrator.setRunTokenMinter((id) => {
      const path = runTokenPath(repo, id);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'stale', { mode: 0o644 });
      return `${id}.tok`;
    });
    const task = store.create({ title: 'Task' });

    const meta = await orchestrator.dispatch(task.meta.id, 'stall');

    const file = runTokenPath(repo, meta.id);
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');
    expect(executor.lastRunToken).toBe(`${meta.id}.tok`);
    expect(readFileSync(file, 'utf8')).toBe(`${meta.id}.tok`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await orchestrator.cancel(meta.id);
  });

  for (const deliver of ['deliverToRun', 'notifyRun'] as const) {
    it(`${deliver} fails a zombie run and throws`, async () => {
      const { orchestrator, store } = makeOrchestrator(repo);
      const executor = new StallingExecutor();
      orchestrator.registerExecutor('stall', executor);
      const task = store.create({ title: 'Task' });
      const meta = await orchestrator.dispatch(task.meta.id, 'stall');
      dropExecutorRun(orchestrator, meta.id);
      expect(orchestrator.getRun(meta.id)?.meta.state).toBe('running');

      expect(() =>
        deliver === 'deliverToRun'
          ? orchestrator.deliverToRun(meta.id, 'x', {
              label: 'human:wyat',
              messageId: 'm-x',
              human: true,
            })
          : orchestrator.notifyRun(meta.id, 'x')
      ).toThrow(/executor is no longer alive/);

      expect(orchestrator.getRun(meta.id)?.meta.state).toBe('failed');
      expect(orchestrator.isRunLive(meta.id)).toBe(false);
      expect(executor.sent).toEqual([]);
      expect(executor.notified).toEqual([]);
    });
  }

  it('deliverToRun sends and logs; notifyRun notes and logs', async () => {
    const { orchestrator, store, events } = makeOrchestrator(repo);
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stall', executor);
    const task = store.create({ title: 'Task' });
    const logged: NormalizedEntry[] = [];
    events.subscribe((e: ServerEvent) => {
      if (e.type === 'run.log' && e.entry.kind === 'message') {
        logged.push(e.entry);
      }
    });

    const meta = await orchestrator.dispatch(task.meta.id, 'stall');
    orchestrator.deliverToRun(
      meta.id,
      '[message from human:wyat · message · m-1]\nhi',
      { label: 'human:wyat', messageId: 'm-1', human: true }
    );
    orchestrator.notifyRun(meta.id, '📬 digest');

    expect(executor.sent).toEqual([
      '[message from human:wyat · message · m-1]\nhi',
    ]);
    expect(executor.notified).toEqual(['📬 digest']);
    const expected: NormalizedEntry[] = [
      {
        ts: expect.any(String),
        kind: 'message',
        from: 'user',
        fromLabel: 'human:wyat',
        text: '[message from human:wyat · message · m-1]\nhi',
        messageId: 'm-1',
      },
      {
        ts: expect.any(String),
        kind: 'message',
        from: 'agent',
        fromLabel: 'dispatch',
        text: '📬 digest',
        digest: true,
      },
    ];
    const transcript = orchestrator
      .getRun(meta.id)
      ?.entries.filter((entry) => entry.kind === 'message');
    expect(transcript).toEqual(expected);
    expect(logged).toEqual(expected);
  });

  it('refuses delivery to a finished run', async () => {
    const { orchestrator, store } = makeOrchestrator(repo);
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stall', executor);
    const task = store.create({ title: 'Task' });

    const meta = await orchestrator.dispatch(task.meta.id, 'stall');
    await orchestrator.cancel(meta.id);

    expect(() =>
      orchestrator.deliverToRun(meta.id, 'x', {
        label: 'a',
        messageId: 'm',
        human: false,
      })
    ).toThrow();
    expect(() => orchestrator.notifyRun(meta.id, 'x')).toThrow();
    expect(orchestrator.isRunLive(meta.id)).toBe(false);
    expect(orchestrator.liveRunIdForTask(task.meta.id)).toBeNull();
  });

  it('refuses delivery to a CLI run, so task mail waits for the next run', async () => {
    const { orchestrator, store, events } = makeOrchestrator(repo);
    orchestrator.registerExecutor(
      'cli',
      new CliExecutor({
        command: { run: ['agent', '{prompt}'] },
        spawn: hangingCliSpawner(),
      })
    );
    const next = new StallingExecutor();
    orchestrator.registerExecutor('stall', next);
    const messaging = await openTestMessaging(orchestrator, store, events);
    const task = store.create({ title: 'Task' });

    const cliRun = await orchestrator.dispatch(task.meta.id, 'cli');
    expect(() =>
      orchestrator.deliverToRun(cliRun.id, 'x', {
        label: 'human:wyat',
        messageId: 'm-x',
        human: true,
      })
    ).toThrow(OrchestratorConflictError);
    expect(() => orchestrator.notifyRun(cliRun.id, 'x')).toThrow(
      OrchestratorConflictError
    );
    expect(
      orchestrator
        .getRun(cliRun.id)
        ?.entries.filter((entry) => entry.kind === 'message')
    ).toEqual([]);

    const sent = await messaging.engine.send(
      {
        to: [`task:${task.meta.id}`],
        kind: 'message',
        body: 'also update the README',
      },
      { address: 'human:wyat', canDecide: true }
    );
    const deliveryId = sent.deliveries[0].id;
    expect(messaging.store.getDelivery(deliveryId)).toMatchObject({
      state: 'held',
      runId: null,
    });

    await orchestrator.cancel(cliRun.id);
    const nextRun = await orchestrator.dispatch(task.meta.id, 'stall');
    await waitFor(() =>
      next.sent.some((text) => text.includes('also update the README'))
    );
    expect(messaging.store.getDelivery(deliveryId)).toMatchObject({
      state: 'pushed',
      runId: nextRun.id,
    });

    await orchestrator.cancel(nextRun.id);
    messaging.close();
  });

  it('re-holds a push that arrives while the run is being cancelled', async () => {
    const { orchestrator, store, events } = makeOrchestrator(repo);
    const slow = new SlowInterruptExecutor();
    orchestrator.registerExecutor('slow', slow);
    const next = new StallingExecutor();
    orchestrator.registerExecutor('stall', next);
    const messaging = await openTestMessaging(orchestrator, store, events);
    const task = store.create({ title: 'Task' });

    const run = await orchestrator.dispatch(task.meta.id, 'slow');
    const cancelling = orchestrator.cancel(run.id);
    expect(() =>
      orchestrator.deliverToRun(run.id, 'x', {
        label: 'human:wyat',
        messageId: 'm-x',
        human: true,
      })
    ).toThrow(OrchestratorConflictError);
    expect(() => orchestrator.notifyRun(run.id, 'x')).toThrow(
      OrchestratorConflictError
    );

    const sent = await messaging.engine.send(
      {
        to: [`task:${task.meta.id}`],
        kind: 'message',
        body: 'one more thing',
      },
      { address: 'human:wyat', canDecide: true }
    );
    const deliveryId = sent.deliveries[0].id;
    expect(messaging.store.getDelivery(deliveryId)).toMatchObject({
      state: 'held',
      runId: null,
    });
    expect(slow.sent).toEqual([]);

    slow.release();
    await cancelling;
    const nextRun = await orchestrator.dispatch(task.meta.id, 'stall');
    await waitFor(() =>
      next.sent.some((text) => text.includes('one more thing'))
    );
    expect(messaging.store.getDelivery(deliveryId)).toMatchObject({
      state: 'pushed',
      runId: nextRun.id,
    });

    await orchestrator.cancel(nextRun.id);
    messaging.close();
  });

  it('re-holds a push that arrives after a graceful stop request', async () => {
    const { orchestrator, store, events } = makeOrchestrator(repo);
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stall', executor);
    const messaging = await openTestMessaging(orchestrator, store, events);
    const task = store.create({ title: 'Task' });

    const run = await orchestrator.dispatch(task.meta.id, 'stall');
    orchestrator.requestStop(run.id);
    expect(() =>
      orchestrator.deliverToRun(run.id, 'x', {
        label: 'human:wyat',
        messageId: 'm-x',
        human: true,
      })
    ).toThrow(OrchestratorConflictError);
    expect(() => orchestrator.notifyRun(run.id, 'x')).toThrow(
      OrchestratorConflictError
    );

    const sent = await messaging.engine.send(
      { to: [`task:${task.meta.id}`], kind: 'message', body: 'after stop' },
      { address: 'human:wyat', canDecide: true }
    );
    expect(messaging.store.getDelivery(sent.deliveries[0].id)).toMatchObject({
      state: 'held',
      runId: null,
    });
    expect(executor.sent).toEqual([]);

    await orchestrator.cancel(run.id);
    messaging.close();
  });

  it('re-holds a push that arrives while a Claude run winds down after its result', async () => {
    const { orchestrator, store, events } = makeOrchestrator(repo);
    const { executor, windingDown, releaseWindDown } = windingDownClaude();
    orchestrator.registerExecutor('claude', executor);
    const messaging = await openTestMessaging(orchestrator, store, events);
    const task = store.create({ title: 'Task' });

    const run = await orchestrator.dispatch(task.meta.id, 'claude');
    await windingDown;
    expect(orchestrator.getRun(run.id)?.meta.state).toBe('running');
    expect(() =>
      orchestrator.deliverToRun(run.id, 'x', {
        label: 'human:wyat',
        messageId: 'm-x',
        human: true,
      })
    ).toThrow(OrchestratorConflictError);
    expect(() => orchestrator.notifyRun(run.id, 'x')).toThrow(
      OrchestratorConflictError
    );

    const sent = await messaging.engine.send(
      { to: [`task:${task.meta.id}`], kind: 'message', body: 'after result' },
      { address: 'human:wyat', canDecide: true }
    );
    expect(messaging.store.getDelivery(sent.deliveries[0].id)).toMatchObject({
      state: 'held',
      runId: null,
    });

    releaseWindDown();
    await waitFor(() => orchestrator.getRun(run.id)?.meta.state === 'finished');
    messaging.close();
  });

  it('wakes the task once the Claude run that blocked a wake finishes winding down', async () => {
    const { orchestrator, store, events } = makeOrchestrator(repo);
    const { executor, windingDown, releaseWindDown } = windingDownClaude();
    orchestrator.registerExecutor('claude', executor);
    const messaging = await openTestMessaging(orchestrator, store, events);
    const task = store.create({ title: 'Task' });

    const run = await orchestrator.dispatch(task.meta.id, 'claude');
    await windingDown;
    const next = new StallingExecutor();
    orchestrator.registerExecutor('claude', next);
    const sent = await messaging.engine.send(
      {
        to: [`task:${task.meta.id}`],
        kind: 'message',
        body: 'one more change',
        wake: 'request',
      },
      { address: 'human:wyat', canDecide: true }
    );
    const deliveryId = sent.deliveries[0].id;
    expect(messaging.store.getDelivery(deliveryId)?.state).toBe('held');
    expect(orchestrator.list()).toHaveLength(1);

    releaseWindDown();
    await waitFor(() =>
      next.sent.some((text) => text.includes('one more change'))
    );
    const successor = orchestrator.list().find((r) => r.resumedFrom === run.id);
    expect(successor?.worktreePath).toBe(run.worktreePath);
    expect(messaging.store.getDelivery(deliveryId)).toMatchObject({
      state: 'pushed',
      runId: successor?.id,
    });

    if (successor !== undefined) await orchestrator.cancel(successor.id);
    messaging.close();
  });
});
