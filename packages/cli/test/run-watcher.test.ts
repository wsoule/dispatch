import { describe, expect, it } from 'bun:test';

import type {
  ApiClient,
  RunDetail,
  RunMeta,
  ServerEvent,
} from '../src/apiClient.js';
import { createRunWatcher } from '../src/commands/orchestrate.js';
import { CliError } from '../src/context.js';
import type { SocketLike } from '../src/watch.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors watch.test.ts's own FakeSocket exactly — a minimal stand-in for
// the global WebSocket, with an `open` event added so tests can simulate a
// successful (re)connect distinctly from a message/close/error.
class FakeSocket implements SocketLike {
  closed = false;
  private readonly openListeners: (() => void)[] = [];
  private readonly messageListeners: ((event: { data: unknown }) => void)[] =
    [];
  private readonly closeListeners: (() => void)[] = [];
  private readonly errorListeners: (() => void)[] = [];

  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: ((event: { data: unknown }) => void) | (() => void)
  ): void {
    if (type === 'open') this.openListeners.push(listener as () => void);
    else if (type === 'message') {
      this.messageListeners.push(
        listener as (event: { data: unknown }) => void
      );
    } else if (type === 'close')
      this.closeListeners.push(listener as () => void);
    else this.errorListeners.push(listener as () => void);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    for (const listener of this.openListeners) listener();
  }

  emitMessage(event: ServerEvent): void {
    for (const listener of this.messageListeners) {
      listener({ data: JSON.stringify(event) });
    }
  }

  emitClose(): void {
    for (const listener of this.closeListeners) listener();
  }
}

function makeRunMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Task',
    executor: 'fake',
    state: 'running',
    branch: 'b',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// A stub ApiClient whose `getRun` is scriptable — every test below only
// needs this one method, matching createRunWatcher's own use of the
// client (approval/message/etc. are irrelevant to watching).
function makeClient(getRun: (id: string) => Promise<RunDetail>): ApiClient {
  return {
    baseUrl: '',
    createRun: () => Promise.reject(new Error('not used')),
    listRuns: () => Promise.reject(new Error('not used')),
    getRun,
    approveRun: () => Promise.reject(new Error('not used')),
    sendRunMessage: () => Promise.reject(new Error('not used')),
    cancelRun: () => Promise.reject(new Error('not used')),
    getRunDiff: () => Promise.reject(new Error('not used')),
    reviewRun: () => Promise.reject(new Error('not used')),
    startPlan: () => Promise.reject(new Error('not used')),
    getPlan: () => Promise.reject(new Error('not used')),
    sendPlanMessage: () => Promise.reject(new Error('not used')),
    confirmPlan: () => Promise.reject(new Error('not used')),
    startEpic: () => Promise.reject(new Error('not used')),
    stopEpic: () => Promise.reject(new Error('not used')),
    getEpicProgress: () => Promise.reject(new Error('not used')),
    getScopeRequest: () => Promise.reject(new Error('not used')),
    decideScopeRequest: () => Promise.reject(new Error('not used')),
  };
}

describe('createRunWatcher', () => {
  it('renders run.log/approval.requested events once the run id is set', () => {
    const lines: string[] = [];
    const created: FakeSocket[] = [];
    const client = makeClient(() =>
      Promise.resolve({
        meta: makeRunMeta(),
        entries: [],
        evidence: [],
        mutations: [],
      })
    );
    const watcher = createRunWatcher(
      { cwd: '/tmp', log: (l) => lines.push(l) },
      client,
      'http://127.0.0.1:1',
      {},
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
      }
    );

    watcher.setRunId('r-1');
    created[0].emitMessage({
      type: 'run.log',
      runId: 'r-1',
      entry: { ts: '2026-01-01T00:00:00Z', kind: 'assistant', text: 'hi' },
    });

    expect(lines).toContain('[assistant] hi');
    watcher.dispose();
  });

  // I2(a): the whole point of refetching on every 'open' is that a run can
  // finish (or fail/cancel) during a gap where the CLI wasn't connected —
  // this proves that gap is recoverable purely from the next reconnect,
  // with no `run.changed` event ever needing to arrive.
  it('detects a run that became terminal during a simulated disconnect, via the reconnect refetch', async () => {
    const created: FakeSocket[] = [];
    let state: RunMeta['state'] = 'running';
    const client = makeClient(() =>
      Promise.resolve({
        meta: makeRunMeta({ state }),
        entries: [],
        evidence: [],
        mutations: [],
      })
    );
    const watcher = createRunWatcher(
      { cwd: '/tmp', log: () => {} },
      client,
      'http://127.0.0.1:1',
      {},
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
        reconnectDelayMs: 5,
      }
    );
    watcher.setRunId('r-1');
    created[0].emitOpen();

    // The run finishes while nothing is watching it (the "gap") — no
    // run.log/run.changed event is ever delivered for it.
    state = 'finished';
    created[0].emitClose();
    await sleep(20);

    // The next reconnect's 'open' must refetch and notice the run is done.
    created[1].emitOpen();

    const code = await watcher.waitForExit();
    expect(code).toBe(0);
    watcher.dispose();
  });

  // C1/I2(b): a daemon that's gone for good must not hang the CLI forever —
  // waitForExit rejects with a CliError once connectEvents gives up, and
  // the caller's try/finally (in commands/orchestrate.ts) disposes the
  // watcher regardless, letting the process actually exit.
  it('rejects waitForExit with a CliError once the connection is given up on', async () => {
    const created: FakeSocket[] = [];
    const client = makeClient(() =>
      Promise.resolve({
        meta: makeRunMeta(),
        entries: [],
        evidence: [],
        mutations: [],
      })
    );
    const watcher = createRunWatcher(
      { cwd: '/tmp', log: () => {} },
      client,
      'http://127.0.0.1:1',
      {},
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
        reconnectDelayMs: 2,
        maxConsecutiveFailures: 3,
      }
    );
    watcher.setRunId('r-1');

    // Subscribe BEFORE triggering the failures, exactly like every real
    // call site does (createRun/getRun resolves, then it awaits
    // waitForExit() immediately) — a promise that rejects before anything
    // is listening would otherwise surface as an unhandled rejection here.
    const exitResult = watcher.waitForExit();

    for (let i = 0; i < 3; i++) {
      created[created.length - 1].emitClose();
      await sleep(10);
    }

    await expect(exitResult).rejects.toThrow('lost connection to dispatchd');
    await expect(exitResult).rejects.toBeInstanceOf(CliError);
    watcher.dispose();
  });

  // The daemon dying mid-fetch (the SIGKILL case orchestrate-e2e's "lost
  // connection mid-watch" exercises): the in-flight refetch rejects with a raw
  // `TypeError: fetch failed` from undici. That is a CONNECTION problem, and the
  // socket layer's reconnect/give-up machinery already handles it — treating it
  // as fatal made it win the race against `onGiveUp`, so `waitForExit` rejected
  // with the undici error instead of the CliError, and the CLI died with an
  // uncaught exception rather than printing "lost connection to dispatchd".
  it('does not fail the watch when a refetch dies from a connection error', async () => {
    const created: FakeSocket[] = [];
    const client = makeClient(() =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), {
          cause: new Error('other side closed'),
        })
      )
    );
    const watcher = createRunWatcher(
      { cwd: '/tmp', log: () => {} },
      client,
      'http://127.0.0.1:1',
      {},
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
        reconnectDelayMs: 2,
        maxConsecutiveFailures: 3,
      }
    );
    // setRunId itself triggers the first refetch, which fails on the dead
    // socket. Deliberately no emitOpen: a generation that reached 'open' resets
    // `consecutiveFailures` (see scheduleReconnect), so give-up would never fire
    // and this would hang rather than assert anything.
    watcher.setRunId('r-1');
    const exitResult = watcher.waitForExit();
    await sleep(10);

    // Then the connection gives up for real. The message the user sees must be
    // the actionable one, not undici's.
    for (let i = 0; i < 3; i++) {
      created[created.length - 1].emitClose();
      await sleep(10);
    }

    await expect(exitResult).rejects.toBeInstanceOf(CliError);
    await expect(exitResult).rejects.toThrow('lost connection to dispatchd');
    watcher.dispose();
  });

  // A refetch failing for a NON-connection reason is still fatal — the run is
  // genuinely unreadable, and silently retrying forever would hang the watch.
  it('still fails the watch when a refetch fails for a non-connection reason', async () => {
    const created: FakeSocket[] = [];
    const client = makeClient(() =>
      Promise.reject(new CliError('run not found: r-1'))
    );
    const watcher = createRunWatcher(
      { cwd: '/tmp', log: () => {} },
      client,
      'http://127.0.0.1:1',
      {},
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
        reconnectDelayMs: 2,
        maxConsecutiveFailures: 3,
      }
    );
    watcher.setRunId('r-1');
    const exitResult = watcher.waitForExit();

    created[created.length - 1].emitOpen();
    await sleep(10);

    await expect(exitResult).rejects.toThrow('run not found: r-1');
    watcher.dispose();
  });

  it('buffers events that arrive before setRunId and replays them once it is called', () => {
    const lines: string[] = [];
    const created: FakeSocket[] = [];
    const client = makeClient(() =>
      Promise.resolve({
        meta: makeRunMeta(),
        entries: [],
        evidence: [],
        mutations: [],
      })
    );
    const watcher = createRunWatcher(
      { cwd: '/tmp', log: (l) => lines.push(l) },
      client,
      'http://127.0.0.1:1',
      {},
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
      }
    );

    // Arrives before the run id is known — must be buffered, not dropped.
    created[0].emitMessage({
      type: 'run.log',
      runId: 'r-1',
      entry: { ts: '2026-01-01T00:00:00Z', kind: 'assistant', text: 'early' },
    });
    expect(lines).toEqual([]);

    watcher.setRunId('r-1');
    expect(lines).toContain('[assistant] early');
    watcher.dispose();
  });
});
