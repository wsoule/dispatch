import { describe, expect, it } from 'bun:test';

import type { SocketLike } from '../src/watch.js';
import { connectEvents, wsUrl } from '../src/watch.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Minimal stand-in for the global WebSocket: tracks its registered listeners
// and lets tests fire them directly, so connectEvents's reconnect/backoff
// logic can be exercised without a real WS server — mirrors
// packages/client/test/connect-events.test.ts's own FakeSocket exactly,
// since this module's reconnect logic was ported from that same design.
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
    if (type === 'open') {
      this.openListeners.push(listener as () => void);
    } else if (type === 'message') {
      this.messageListeners.push(
        listener as (event: { data: unknown }) => void
      );
    } else if (type === 'close') {
      this.closeListeners.push(listener as () => void);
    } else {
      this.errorListeners.push(listener as () => void);
    }
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    for (const listener of this.openListeners) listener();
  }

  emitMessage(data: unknown): void {
    for (const listener of this.messageListeners) listener({ data });
  }

  emitClose(): void {
    for (const listener of this.closeListeners) listener();
  }

  emitError(): void {
    for (const listener of this.errorListeners) listener();
  }
}

const BASE_URL = 'http://127.0.0.1:4771';

describe('wsUrl', () => {
  it('swaps http for ws and appends /ws', () => {
    expect(wsUrl('http://127.0.0.1:4771')).toBe('ws://127.0.0.1:4771/ws');
  });

  it('swaps https for wss', () => {
    expect(wsUrl('https://example.com')).toBe('wss://example.com/ws');
  });
});

describe('connectEvents', () => {
  it('opens exactly one socket up front', () => {
    const created: FakeSocket[] = [];
    const dispose = connectEvents(BASE_URL, () => {}, {
      createSocket: () => {
        const socket = new FakeSocket();
        created.push(socket);
        return socket;
      },
    });

    expect(created.length).toBe(1);
    dispose();
  });

  it('calls onEvent for every parsed frame, ignoring malformed ones', () => {
    const created: FakeSocket[] = [];
    const seen: string[] = [];
    const dispose = connectEvents(
      BASE_URL,
      (event) => {
        seen.push(event.type);
      },
      {
        createSocket: () => {
          const socket = new FakeSocket();
          created.push(socket);
          return socket;
        },
      }
    );

    created[0].emitMessage('not json');
    created[0].emitMessage(JSON.stringify({ type: 'hello', version: '0.0.1' }));
    created[0].emitMessage(JSON.stringify({ type: 'task.changed' }));
    created[0].emitMessage(JSON.stringify({ type: 'run.changed' }));
    created[0].emitMessage(
      JSON.stringify({
        type: 'run.log',
        runId: 'r-abc123',
        entry: { ts: '2026-01-01T00:00:00.000Z', kind: 'assistant' },
      })
    );
    created[0].emitMessage(
      JSON.stringify({
        type: 'approval.requested',
        runId: 'r-abc123',
        requestId: 'req-1',
        toolName: 'Bash',
      })
    );

    expect(seen).toEqual([
      'hello',
      'task.changed',
      'run.changed',
      'run.log',
      'approval.requested',
    ]);
    dispose();
  });

  it('reconnects with a fresh socket after the current one closes', async () => {
    const created: FakeSocket[] = [];
    const dispose = connectEvents(BASE_URL, () => {}, {
      createSocket: () => {
        const socket = new FakeSocket();
        created.push(socket);
        return socket;
      },
      reconnectDelayMs: 5,
    });

    expect(created.length).toBe(1);
    created[0].emitClose();

    await sleep(30);
    expect(created.length).toBe(2);

    dispose();
  });

  it('reconnects on a socket error the same way it does on close', async () => {
    const created: FakeSocket[] = [];
    const dispose = connectEvents(BASE_URL, () => {}, {
      createSocket: () => {
        const socket = new FakeSocket();
        created.push(socket);
        return socket;
      },
      reconnectDelayMs: 5,
    });

    created[0].emitError();
    await sleep(30);
    expect(created.length).toBe(2);

    dispose();
  });

  it('schedules only one reconnect when a socket fires error then close', async () => {
    const created: FakeSocket[] = [];
    const dispose = connectEvents(BASE_URL, () => {}, {
      createSocket: () => {
        const socket = new FakeSocket();
        created.push(socket);
        return socket;
      },
      reconnectDelayMs: 5,
    });

    created[0].emitError();
    created[0].emitClose();

    await sleep(30);
    expect(created.length).toBe(2);

    dispose();
  });

  it('dispose closes the current socket and stops further reconnects', async () => {
    const created: FakeSocket[] = [];
    const dispose = connectEvents(BASE_URL, () => {}, {
      createSocket: () => {
        const socket = new FakeSocket();
        created.push(socket);
        return socket;
      },
      reconnectDelayMs: 5,
    });

    dispose();
    expect(created[0].closed).toBe(true);

    created[0].emitClose();
    await sleep(30);
    expect(created.length).toBe(1);
  });

  // I2(a): every (re)connect must give the caller a chance to refetch
  // authoritative state over HTTP — a WS event that landed while
  // disconnected (or before the very first connection finished opening) is
  // otherwise gone forever.
  it('calls onOpen every time a socket successfully opens, including reconnects', async () => {
    const created: FakeSocket[] = [];
    let opens = 0;
    const dispose = connectEvents(BASE_URL, () => {}, {
      createSocket: () => {
        const socket = new FakeSocket();
        created.push(socket);
        return socket;
      },
      reconnectDelayMs: 5,
      onOpen: () => {
        opens++;
      },
    });

    created[0].emitOpen();
    expect(opens).toBe(1);

    created[0].emitClose();
    await sleep(30);
    created[1].emitOpen();
    expect(opens).toBe(2);

    dispose();
  });

  // I2(b): a socket that never opens (immediate error/close every attempt)
  // must not retry forever — after `maxConsecutiveFailures` failed
  // attempts in a row, connectEvents gives up and calls `onGiveUp` instead
  // of scheduling yet another reconnect.
  it('gives up after maxConsecutiveFailures consecutive failed attempts', async () => {
    const created: FakeSocket[] = [];
    let gaveUp = 0;
    const dispose = connectEvents(BASE_URL, () => {}, {
      createSocket: () => {
        const socket = new FakeSocket();
        created.push(socket);
        return socket;
      },
      reconnectDelayMs: 2,
      maxConsecutiveFailures: 3,
      onGiveUp: () => {
        gaveUp++;
      },
    });

    // Fail 3 times in a row (the socket never opens between attempts).
    for (let i = 0; i < 3; i++) {
      created[created.length - 1].emitClose();
      await sleep(15);
    }

    expect(gaveUp).toBe(1);
    const countAfterGiveUp = created.length;

    // No further reconnect attempts after giving up.
    await sleep(30);
    expect(created.length).toBe(countAfterGiveUp);

    dispose();
  });

  it('resets the failure count once a connection successfully opens', async () => {
    const created: FakeSocket[] = [];
    let gaveUp = 0;
    const dispose = connectEvents(BASE_URL, () => {}, {
      createSocket: () => {
        const socket = new FakeSocket();
        created.push(socket);
        return socket;
      },
      reconnectDelayMs: 2,
      maxConsecutiveFailures: 3,
      onGiveUp: () => {
        gaveUp++;
      },
    });

    // Two failures, then a successful open, then two more failures — never
    // 3 *consecutive* failures, so this must never give up.
    created[0].emitClose();
    await sleep(15);
    created[1].emitClose();
    await sleep(15);
    created[2].emitOpen();
    created[2].emitClose();
    await sleep(15);
    created[3].emitClose();
    await sleep(15);

    expect(gaveUp).toBe(0);
    dispose();
  });
});
