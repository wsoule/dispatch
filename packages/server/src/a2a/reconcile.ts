import type { TaskRow } from '@dispatch/a2a';
import type { Message } from '@dispatch/protocol';

import type { BridgeDeps } from './port.js';
import type { BridgeWatch } from './watch.js';

const HOUR_MS = 60 * 60 * 1000;

// The tasks row a client's question or handoff opens.
export function rowFor(client: string, m: Message): TaskRow {
  return {
    id: m.id,
    client,
    contextId: m.thread,
    skill: m.kind === 'handoff' ? 'handoff' : 'ask',
    dispatchTask: null,
    gate: null,
    state: 'WORKING',
    statusAt: m.createdAt,
    canceledAt: null,
    declinedAt: null,
    createdAt: m.createdAt,
  };
}

// Boot: gives every keyed question or handoff a client sent its row, which a
// crash between the engine's commit and a2a.db can lose, then recomputes open
// tasks; one that cannot be recomputed is logged and skipped.
export function reconcileA2A(
  deps: BridgeDeps,
  watch: BridgeWatch
): { created: number; recomputed: number } {
  let created = 0;
  for (const client of deps.store.clients()) {
    const newest = deps.store.newestTaskAt(client.address);
    const since =
      newest === null
        ? client.createdAt
        : new Date(Date.parse(newest) - HOUR_MS).toISOString();
    const openers = deps.messages.messagesFrom(client.address, since, [
      'question',
      'handoff',
    ]);
    const keyed = deps.messages.idemKeysFor(openers.map((m) => m.id));
    for (const m of openers) {
      if (keyed.has(m.id) && deps.store.insertTask(rowFor(client.address, m)))
        created += 1;
    }
  }
  const open = deps.store.openTasks();
  for (const row of open) watch.recomputeLogged(row.id);
  return { created, recomputed: open.length };
}
