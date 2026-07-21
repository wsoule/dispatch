import type { ServerEvent } from './apiClient.js';

// Minimal subset of the DOM/Node `WebSocket` interface `connectEvents` needs
// — lets tests inject a fake socket instead of opening a real connection.
export interface SocketLike {
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  close(): void;
}

export interface ConnectEventsOptions {
  // Defaults to `(url) => new WebSocket(url)` — Node >=22's global
  // WebSocket, the same one `--watch` relies on for the CLI to stay
  // Node-runnable with no new dependency. Tests override this to inject a
  // fake socket.
  createSocket?: (url: string) => SocketLike;
  // Defaults to 500ms. Tests override so reconnect assertions don't wait a
  // full backoff period.
  reconnectDelayMs?: number;
  // I2(a): called every time a socket successfully opens — the FIRST
  // connection and every reconnect after it. A caller uses this to refetch
  // authoritative state over HTTP, which is the only way to recover an
  // event that was broadcast while disconnected (or before the very first
  // 'open'): the WS protocol here is fire-and-forget, nothing is queued
  // server-side for a client that wasn't listening yet.
  onOpen?: () => void;
  // I2(b): called once a connection attempt has failed
  // `maxConsecutiveFailures` times in a row with no successful 'open'
  // in between — connectEvents stops retrying at that point (as if
  // `dispose()` had been called) rather than reconnecting forever against
  // a daemon that's gone for good. Any successful 'open' resets the streak
  // back to zero.
  onGiveUp?: () => void;
  // Defaults to 10. See `onGiveUp`.
  maxConsecutiveFailures?: number;
}

// Swaps an http(s) baseUrl for its ws(s) `/ws` equivalent — pure and
// Node-safe (no `window.location` fallback the way
// packages/client/src/api.ts's own `wsUrl` has, since every CLI caller
// already has a concrete `http://127.0.0.1:<port>` baseUrl from
// ensureDaemon, never a same-origin default).
export function wsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws')}/ws`;
}

// Opens a WS connection to dispatchd and calls `onEvent` for every parsed
// ServerEvent. Reconnects on close/error with a fixed backoff, the same
// "briefly less live, never wrong" contract packages/client/src/api.ts's
// connectEvents documents — reimplemented locally here (see the phase's
// design notes) rather than importing @dispatch/client, whose only export
// barrel pulls in `react` for an unrelated hook this package has no use for.
// Returns a disposer that stops reconnecting and closes the current socket.
export function connectEvents(
  baseUrl: string,
  onEvent: (event: ServerEvent) => void,
  options: ConnectEventsOptions = {}
): () => void {
  const createSocket =
    options.createSocket ?? ((url) => new WebSocket(url) as SocketLike);
  const reconnectDelayMs = options.reconnectDelayMs ?? 500;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 10;

  let closed = false;
  let socket: SocketLike | null = null;
  // A failed socket fires 'error' then 'close', both of which call
  // scheduleReconnect — this guard caps it at one pending reconnect per
  // socket generation, same rationale as the client package's own version.
  let scheduled = false;
  // Whether THIS generation's socket ever reached 'open' — a generation
  // that opened successfully and later closed still counts as "we were
  // connected," so it resets `consecutiveFailures` even though it also
  // needs a reconnect.
  let openedThisGeneration = false;
  let consecutiveFailures = 0;

  function scheduleReconnect() {
    if (closed || scheduled) return;
    if (openedThisGeneration) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
    }
    if (consecutiveFailures >= maxConsecutiveFailures) {
      // I2(b): stop retrying for good — same end state as dispose(), just
      // reached on our own instead of by the caller closing us.
      closed = true;
      socket?.close();
      options.onGiveUp?.();
      return;
    }
    scheduled = true;
    setTimeout(connect, reconnectDelayMs);
  }

  function connect() {
    if (closed) return;
    scheduled = false;
    openedThisGeneration = false;
    socket = createSocket(wsUrl(baseUrl));
    socket.addEventListener('open', () => {
      openedThisGeneration = true;
      options.onOpen?.();
    });
    socket.addEventListener('message', (event) => {
      // A malformed frame must never take down the reconnect loop or crash
      // the CLI's watch session — ignore it and wait for the next message.
      let data: ServerEvent;
      try {
        data = JSON.parse(event.data as string) as ServerEvent;
      } catch {
        return;
      }
      onEvent(data);
    });
    socket.addEventListener('close', scheduleReconnect);
    socket.addEventListener('error', scheduleReconnect);
  }

  connect();
  return () => {
    closed = true;
    socket?.close();
  };
}
