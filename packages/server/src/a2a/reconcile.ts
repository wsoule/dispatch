import type { TaskRow } from '@dispatch/a2a';
import { parseWorkExt, shapeDraft, unwrapExternalData } from '@dispatch/a2a';
import type { Message } from '@dispatch/protocol';
import {
  isDecidingAuthor,
  isSystemMarker,
  SYSTEM_ADDRESS,
} from '@dispatch/protocol';

import { handleProposal, proposalKey, sendProposalGate } from './handoff.js';
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

// The draft a handoff root asked for, rebuilt from its wrapped work request;
// null when the root carries none.
function createDraft(
  deps: BridgeDeps,
  row: TaskRow,
  root: Message
): string | null {
  const payload =
    root.data === undefined ? null : unwrapExternalData(root.data);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return null;
  const work = parseWorkExt(payload.work);
  if (work?.skill !== 'handoff') return null;
  return deps.createTask(shapeDraft(work, root.body, row.client, root.id)).meta
    .id;
}

// Brings one open handoff back to its draft, gate and effect: finds the draft
// by its provenance line or rebuilds it, adopts or sends the proposal gate,
// and applies an owner's answer the bridge missed. Returns the send, if any.
function reconcileHandoff(
  deps: BridgeDeps,
  hub: BridgeWatch,
  row: TaskRow
): Promise<void> | null {
  const root = deps.engine.getMessage(row.id);
  if (root === null || row.canceledAt !== null) return null;
  let task = row.dispatchTask;
  if (task === null) {
    const marker = `(message ${row.id})`;
    task =
      deps.tasks
        .list()
        .find((t) => t.meta.labels.includes('a2a') && t.body.includes(marker))
        ?.meta.id ?? createDraft(deps, row, root);
    if (task === null) return null;
    deps.store.updateTask(row.id, { dispatchTask: task });
  }
  let gate = row.gate;
  if (gate === null) {
    gate =
      deps.messages.byIdemKey(SYSTEM_ADDRESS, proposalKey(row.id))?.id ?? null;
    if (gate === null) {
      const title = deps.tasks.get(task)?.meta.title;
      if (title === undefined) return null;
      return sendProposalGate(deps, { ...row, dispatchTask: task }, title).then(
        () => hub.recomputeLogged(row.id)
      );
    }
    deps.store.updateTask(row.id, { gate });
  }
  const question = deps.engine.getMessage(gate);
  const answer = deps.engine.answerOf(gate);
  if (
    question === null ||
    answer === null ||
    isSystemMarker(answer, 'x-closed') ||
    !isDecidingAuthor(answer.from) ||
    deps.engine.answerOf(row.id) !== null
  )
    return null;
  return handleProposal(deps, hub, question, answer);
}

// Boot: gives every keyed question or handoff a client sent its row, which a
// crash between the engine's commit and a2a.db can lose, brings each open
// handoff back to its draft and gate, then recomputes open tasks; one that
// fails is logged and skipped. `settled` resolves once any sends are through.
export function reconcileA2A(
  deps: BridgeDeps,
  watch: BridgeWatch
): { created: number; recomputed: number; settled: Promise<void> } {
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
  const pending: Promise<void>[] = [];
  const logged = (id: string) => (err: unknown) =>
    console.error(`a2a: could not reconcile handoff ${id}`, err);
  for (const row of deps.store.openTasks()) {
    if (row.skill !== 'handoff') continue;
    try {
      const sending = reconcileHandoff(deps, watch, row);
      if (sending !== null) pending.push(sending.catch(logged(row.id)));
    } catch (err) {
      logged(row.id)(err);
    }
  }
  const open = deps.store.openTasks();
  for (const row of open) watch.recomputeLogged(row.id);
  return {
    created,
    recomputed: open.length,
    settled: Promise.all(pending).then(() => undefined),
  };
}
