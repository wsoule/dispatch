import type { NormalizedEntry } from './orchestrator/types.js';

// Single WS message shape the server ever sends. `hello` greets a freshly
// opened socket; `task.changed` tells every connected client "something
// changed, go refetch" — clients never receive a diff, so a duplicate event
// is harmless (see EventBus.broadcast callers in index.ts/api.ts for why
// duplicates can happen).
//
// The `run.*` variants are the orchestrator's equivalents: `run.changed` is
// "some run's lifecycle/registry state changed, go refetch" (same
// refetch-not-diff contract as task.changed); `run.log` streams one
// NormalizedEntry as it's produced, keyed by runId so a client can append it
// to the right run's log without a refetch; `approval.requested` tells
// clients a run is now waiting on a human decision.
export type ServerEvent =
  | { type: 'task.changed' }
  | { type: 'hello'; version: string }
  | { type: 'run.changed' }
  | { type: 'run.log'; runId: string; entry: NormalizedEntry }
  | {
      type: 'approval.requested';
      runId: string;
      requestId: string;
      toolName: string;
    }
  // Phase 5 P1: a plan's state (running -> ready|failed) changed, or it was
  // just confirmed — same "go refetch, no payload beyond the id" contract as
  // run.changed.
  | { type: 'plan.changed'; planId: string }
  // A note/triage/follow-up was created, edited, promoted, or deleted — same
  // "go refetch" contract as task.changed. Lets an agent-created triage (via
  // the MCP `dispatch_note` tool) show up live in an open Notes tab.
  | { type: 'note.changed' }
  // The merge queue's state changed (entry added/removed/advanced) — same
  // "go refetch" contract as run.changed.
  | { type: 'merge-queue.changed' };

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
