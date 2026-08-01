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
  // A task draft changed state or was dismissed — no id, since a client can
  // have several drafts running and is expected to refetch the whole list.
  | { type: 'draft.changed' }
  // A note/triage/follow-up was created, edited, promoted, or deleted — same
  // "go refetch" contract as task.changed. Lets an agent-created triage (via
  // the MCP `dispatch_note` tool) show up live in an open Notes tab.
  | { type: 'note.changed' }
  // The brain-dump inbox changed (captured, retyped, dismissed or converted).
  | { type: 'inbox.changed' }
  // A run's review comments changed (added, replied to, resolved).
  | { type: 'review.changed'; runId: string }
  // .dispatch/config.yml changed through the Settings screen.
  | { type: 'config.changed' }
  // A run agent asked the human a question and is blocked on the answer, or
  // that question just got answered — same "go refetch the open questions"
  // contract as the *.changed events.
  | { type: 'question.asked'; runId: string; questionId: string }
  | { type: 'question.answered'; runId: string; questionId: string }
  // The merge queue's state changed (entry added/removed/advanced) — same
  // "go refetch" contract as run.changed.
  | { type: 'merge-queue.changed' }
  // One chunk of a merge-queue entry's verify output, as it is produced.
  // Deliberately its own event rather than folded into `merge-queue.changed`:
  // that one carries a full snapshot, so emitting it per output chunk would be
  // pathologically chatty. Mirrors the `run.log` contract — the payload is the
  // increment, and a client that wants the whole picture refetches.
  | { type: 'merge-queue.log'; runId: string; chunk: string }
  // The queue just finished draining (>=1 merge, or a retried push) and
  // attempted to push origin's base up to date. Carries its own payload
  // (unlike the *.changed events above) so the UI can show the outcome
  // without a follow-up fetch.
  | {
      type: 'queue.drained';
      merged: number;
      pushed: boolean;
      pushError?: string;
    };

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
