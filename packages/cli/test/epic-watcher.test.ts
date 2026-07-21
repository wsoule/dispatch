import { describe, expect, it } from 'bun:test';

import type { EpicProgress, ServerEvent } from '../src/apiClient.js';
import { createEpicWatcher } from '../src/commands/plan.js';
import { CliError } from '../src/context.js';
import type { SocketLike } from '../src/watch.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors watch.test.ts's own FakeSocket.
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

function makeProgress(overrides: Partial<EpicProgress> = {}): EpicProgress {
  return {
    epicId: 'e-1',
    active: true,
    children: [],
    liveRuns: [],
    ...overrides,
  };
}

describe('createEpicWatcher', () => {
  it('reports each fetched progress snapshot via onProgress', async () => {
    const created: FakeSocket[] = [];
    const seen: EpicProgress[] = [];
    const watcher = createEpicWatcher(
      'http://127.0.0.1:1',
      () => Promise.resolve(makeProgress()),
      (progress) => seen.push(progress),
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
      }
    );
    created[0].emitOpen();
    await sleep(5);
    expect(seen.length).toBeGreaterThan(0);
    watcher.dispose();
  });

  // M4: overlapping task.changed/run.changed events (a review merge touches
  // both) must never fire more than one fetchProgress() call concurrently —
  // single-flight, not a boolean that can race.
  it('collapses overlapping events into a single in-flight fetch (single-flight, not a race-prone boolean)', async () => {
    const created: FakeSocket[] = [];
    let fetches = 0;
    let resolveFetch!: (p: EpicProgress) => void;
    const watcher = createEpicWatcher(
      'http://127.0.0.1:1',
      () => {
        fetches++;
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      },
      () => {},
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
      }
    );
    created[0].emitOpen();
    await sleep(5);
    expect(fetches).toBe(1);

    // Two more events arrive while the first fetch is still pending.
    created[0].emitMessage({ type: 'task.changed' });
    created[0].emitMessage({ type: 'run.changed' });
    await sleep(5);
    expect(fetches).toBe(1); // still just the one in-flight call

    resolveFetch(makeProgress());
    await sleep(5);
    watcher.dispose();
  });

  it('resolves waitForExit once a fetched progress reports active: false', async () => {
    const created: FakeSocket[] = [];
    let active = true;
    const watcher = createEpicWatcher(
      'http://127.0.0.1:1',
      () => Promise.resolve(makeProgress({ active })),
      () => {},
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
      }
    );
    created[0].emitOpen();
    await sleep(5);

    active = false;
    created[0].emitMessage({ type: 'run.changed' });

    await watcher.waitForExit();
    watcher.dispose();
  });

  // I2(a): a session that completed during a disconnected gap (no
  // task.changed/run.changed ever delivered for it) is still caught by the
  // next reconnect's refetch.
  it('detects completion that happened during a simulated disconnect, via the reconnect refetch', async () => {
    const created: FakeSocket[] = [];
    let active = true;
    const watcher = createEpicWatcher(
      'http://127.0.0.1:1',
      () => Promise.resolve(makeProgress({ active })),
      () => {},
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
        reconnectDelayMs: 5,
      }
    );
    created[0].emitOpen();
    await sleep(5);

    active = false;
    created[0].emitClose();
    await sleep(20);
    created[1].emitOpen();

    await watcher.waitForExit();
    watcher.dispose();
  });

  // M4: a fetch failure (daemon died) must reject waitForExit cleanly, not
  // crash the process with an unhandled rejection.
  it('rejects waitForExit if fetchProgress itself fails', async () => {
    const created: FakeSocket[] = [];
    const watcher = createEpicWatcher(
      'http://127.0.0.1:1',
      () => Promise.reject(new Error('daemon unreachable')),
      () => {},
      {
        createSocket: () => {
          const s = new FakeSocket();
          created.push(s);
          return s;
        },
      }
    );
    const exitResult = watcher.waitForExit();
    created[0].emitOpen();
    await expect(exitResult).rejects.toThrow('daemon unreachable');
    watcher.dispose();
  });

  it('rejects waitForExit with a CliError once the connection is given up on', async () => {
    const created: FakeSocket[] = [];
    const watcher = createEpicWatcher(
      'http://127.0.0.1:1',
      () => Promise.resolve(makeProgress()),
      () => {},
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
    const exitResult = watcher.waitForExit();
    for (let i = 0; i < 3; i++) {
      created[created.length - 1].emitClose();
      await sleep(10);
    }
    await expect(exitResult).rejects.toThrow('lost connection to dispatchd');
    await expect(exitResult).rejects.toBeInstanceOf(CliError);
    watcher.dispose();
  });
});
