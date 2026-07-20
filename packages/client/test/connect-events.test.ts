import { describe, expect, it } from 'bun:test';

import { connectEvents } from '../src/api';
import type { SocketLike } from '../src/api';

// Plain setTimeout-based sleep rather than `Bun.sleep` — this package's
// tsconfig deliberately excludes the ambient `Bun` global (it targets the
// browser, same as @dispatch/web), so tests stick to portable APIs.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Minimal stand-in for a DOM WebSocket: tracks its registered listeners and
// lets tests fire them directly, so connectEvents's reconnect/backoff logic
// can be exercised without a real WS server. `close()` just flips a flag —
// there's nothing else to simulate closing.
class FakeSocket implements SocketLike {
  closed = false;
  private readonly messageListeners: ((event: { data: unknown }) => void)[] =
    [];
  private readonly closeListeners: (() => void)[] = [];
  private readonly errorListeners: (() => void)[] = [];

  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: ((event: { data: unknown }) => void) | (() => void)
  ): void {
    if (type === 'message') {
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

// A non-empty baseUrl throughout — connectEvents falls back to
// `window.location.origin` for an empty one, and there's no `window` global
// under bun:test.
const BASE_URL = 'http://127.0.0.1:4771';

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

  it('calls onChange only for task.changed, ignoring hello and malformed frames', () => {
    const created: FakeSocket[] = [];
    let changeCount = 0;
    const dispose = connectEvents(
      BASE_URL,
      () => {
        changeCount++;
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

    expect(changeCount).toBe(1);
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

    // Reconnect is scheduled via setTimeout(reconnectDelayMs); wait past it.
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

  it('schedules only one reconnect when a socket fires error then close (reconnect storm regression)', async () => {
    // A failed browser WebSocket fires 'error' then 'close' for the same
    // socket. Both listeners used to call scheduleReconnect independently,
    // so a single failed connection queued two reconnect timers — each of
    // which opens its own socket that can fail the same way, doubling again
    // on every generation (measured: 16,383 sockets in 100ms with a 5ms
    // backoff). Exactly one new socket must appear after the backoff.
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

    // A close event arriving after dispose() (e.g. the underlying socket
    // finishing its teardown asynchronously) must not schedule a reconnect.
    created[0].emitClose();
    await sleep(30);
    expect(created.length).toBe(1);
  });
});
