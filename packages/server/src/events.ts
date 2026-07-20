// Single WS message shape the server ever sends. `hello` greets a freshly
// opened socket; `task.changed` tells every connected client "something
// changed, go refetch" — clients never receive a diff, so a duplicate event
// is harmless (see EventBus.broadcast callers in index.ts/api.ts for why
// duplicates can happen).
export type ServerEvent =
  | { type: 'task.changed' }
  | { type: 'hello'; version: string };

// The subset of Bun's ServerWebSocket used here, kept minimal so tests can
// pass plain mock objects instead of real sockets.
export interface BroadcastClient {
  send(data: string): void;
}

// Fan-out hub for connected WS clients. The watcher (external file edits) and
// the API mutation handlers (our own writes) both call `broadcast()`.
// Sockets are closed via `Bun.serve`'s own `server.stop(true)` on shutdown
// (see index.ts) rather than a `closeAll()` here — closing each
// ServerWebSocket ourselves right before `server.stop(true)` hangs that call
// forever on Bun 1.3.14, so `stop(true)` is left to own the close.
export class EventBus {
  private readonly clients = new Set<BroadcastClient>();

  add(client: BroadcastClient): void {
    this.clients.add(client);
  }

  remove(client: BroadcastClient): void {
    this.clients.delete(client);
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) client.send(payload);
  }
}
