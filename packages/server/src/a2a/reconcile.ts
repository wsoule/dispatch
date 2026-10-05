import type { HandoffRequest, TaskRow } from '@dispatch-foo/a2a';
import {
  handoffSupported,
  parseWorkExt,
  provenanceLine,
  shapeDraft,
  unwrapExternalData,
} from '@dispatch-foo/a2a';
import type { TaskDoc } from '@dispatch-foo/core';
import { untrustedInline } from '@dispatch-foo/core';
import type { Message } from '@dispatch-foo/protocol';
import {
  isDecidingAuthor,
  isSystemMarker,
  SYSTEM_ADDRESS,
} from '@dispatch-foo/protocol';

import {
  finishCancel,
  handleProposal,
  orphanDraft,
  proposalKey,
  sendProposalGate,
} from './handoff.js';
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

// The handoff request a root's wrapped data carries; null when it has none.
function handoffWork(root: Message): HandoffRequest | null {
  const payload =
    root.data === undefined ? null : unwrapExternalData(root.data);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return null;
  const work = parseWorkExt(payload.work);
  return work?.skill === 'handoff' ? work : null;
}

// Whether `task` is the draft `root` asked for: its exact title and provenance line.
export function draftOfRoot(task: TaskDoc, root: Message): boolean {
  const work = handoffWork(root);
  return (
    work !== null &&
    task.meta.title === untrustedInline(work.title) &&
    task.body.includes(provenanceLine(root.from, root.id))
  );
}

// The draft a handoff root asked for, rebuilt from its wrapped work request;
// null when the root carries none.
function createDraft(
  deps: BridgeDeps,
  row: TaskRow,
  root: Message
): string | null {
  const work = handoffWork(root);
  const statuses = deps.statuses();
  if (work === null || !handoffSupported(statuses)) return null;
  return deps.createTask(
    shapeDraft(work, root.body, row.client, root.id, statuses.draft)
  ).meta.id;
}

// Restores one open handoff's draft, proposal gate and any missed owner answer;
// returns the gate send, if any.
export function reconcileHandoff(
  deps: BridgeDeps,
  hub: BridgeWatch,
  row: TaskRow
): Promise<void> | null {
  const root = deps.engine.getMessage(row.id);
  if (root === null) return null;
  // A crash between recording a cancel and closing its gate: finish the cancel.
  if (row.canceledAt !== null)
    return deps.engine.answerOf(row.id) === null
      ? finishCancel(deps, hub, row)
      : null;
  let task = row.dispatchTask;
  if (task === null) {
    task = orphanDraft(deps, row.id)?.meta.id ?? createDraft(deps, row, root);
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

// Boot: restores rows a crash lost, each open handoff's draft and gate, then
// recomputes open tasks (failures logged); `settled` awaits the sends.
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
