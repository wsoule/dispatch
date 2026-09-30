import type {
  GateTypeName,
  OpenGateFact,
  TaskFacts,
  TaskLink,
  TaskRow,
} from '@dispatch/a2a';
import { GATE_SENTENCES, gateInScope, scopeOf } from '@dispatch/a2a';
import type { HandoffStatuses } from '@dispatch/a2a';
import { canonicalStatus } from '@dispatch/core';
import type { Delivery, Message } from '@dispatch/protocol';
import { gateOf } from '@dispatch/protocol';

import { workFacts } from './artifacts.js';
import { linkOf } from './handoff.js';
import type { BridgeDeps } from './port.js';

function byMessage(deliveries: Delivery[]): Map<string, Delivery[]> {
  const out = new Map<string, Delivery[]>();
  for (const d of deliveries)
    out.set(d.messageId, [...(out.get(d.messageId) ?? []), d]);
  return out;
}

function isA2AGate(type: string): type is GateTypeName {
  return Object.hasOwn(GATE_SENTENCES, type);
}

// The client's traffic with an approved handoff's task and its runs, which
// need not sit in the root's thread.
function linkedTraffic(
  deps: BridgeDeps,
  row: TaskRow,
  link: TaskLink
): Message[] {
  const task = `task:${link.taskId}`;
  const sent = deps.messages
    .messagesFrom(row.client, row.createdAt)
    .filter((m) => m.to.includes(task));
  const received = deps.engine
    .inbox(row.client)
    .map(({ message }) => message)
    .filter(
      (m) =>
        m.from === task ||
        (m.from.startsWith('run:') && link.runIds.has(m.from.slice(4)))
    );
  return [...sent, ...received];
}

// A handoff's Dispatch task as the projection reads it.
function taskFact(
  deps: BridgeDeps,
  statuses: HandoffStatuses,
  link: TaskLink | null
): TaskFacts['task'] {
  if (link === null) return null;
  const doc = deps.tasks.get(link.taskId);
  if (doc === null) return 'deleted';
  return {
    id: doc.meta.id,
    title: doc.meta.title,
    status: canonicalStatus(doc.meta.status),
    phase: statuses.phase(doc.meta.status),
    approved: link.approved,
  };
}

// The open owner gates holding a handoff: its proposal, then the linked
// task's and runs' tool, scope and wake gates.
function openGatesOf(
  deps: BridgeDeps,
  row: TaskRow,
  link: TaskLink | null
): OpenGateFact[] {
  const out: OpenGateFact[] = [];
  for (const q of deps.engine.openBlocking()) {
    const type = gateOf(q)?.type;
    if (type === undefined || !isA2AGate(type)) continue;
    if (gateInScope(q, row.gate, link))
      out.push({ id: q.id, type, openedAt: q.createdAt });
  }
  return out;
}

// Everything the projection needs about one A2A task, read fresh. A dropped
// recipient task fails only an unanswered ask, so a finished task stays final.
// `work: false` leaves out the run results, for a caller that only decides.
export function gatherFacts(
  deps: BridgeDeps,
  row: TaskRow,
  opts: { work?: boolean } = {}
): TaskFacts {
  const root = deps.engine.getMessage(row.id);
  if (root === null) throw new Error(`a2a task ${row.id} has no root message`);
  const thread = deps.engine.thread(root.thread);
  const candidates = [...thread.messages];
  const deliveries = byMessage(thread.deliveries);
  const link = linkOf(deps, row);
  if (link?.approved === true) {
    const seen = new Set(candidates.map((m) => m.id));
    for (const m of linkedTraffic(deps, row, link)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      candidates.push(m);
      deliveries.set(m.id, deps.messages.deliveries({ messageId: m.id }));
    }
  }
  const scope = scopeOf({
    root,
    client: row.client,
    candidates,
    deliveries,
    link,
  });
  const openQuestions = scope.filter(
    (m) =>
      m.kind === 'question' &&
      m.blocking &&
      m.from !== row.client &&
      (deliveries.get(m.id) ?? []).some((d) => d.recipient === row.client) &&
      deps.engine.answerOf(m.id) === null
  );
  const own = scope.filter((m) => m.from === row.client).map((m) => m.id);
  const answer = deps.engine.answerOf(root.id);
  const statuses = deps.statuses();
  const task = taskFact(deps, statuses, link);
  const dropped =
    task !== null && task !== 'deleted' && task.phase === 'dropped';
  return {
    id: row.id,
    contextId: row.contextId,
    skill: row.skill,
    client: row.client,
    createdAt: row.createdAt,
    canceledAt: row.canceledAt,
    declinedAt: row.declinedAt,
    root,
    scope,
    rootDeliveries: (deliveries.get(root.id) ?? []).map((d) => d.state),
    answer,
    openQuestions,
    openGates: row.skill === 'handoff' ? openGatesOf(deps, row, link) : [],
    task,
    dropped: dropped ? (row.canceledAt === null ? 'other' : 'client') : null,
    recipientTaskDropped:
      answer === null &&
      root.to.some((a) => {
        if (!a.startsWith('task:')) return false;
        const doc = deps.tasks.get(a.slice('task:'.length));
        return doc !== null && statuses.phase(doc.meta.status) === 'dropped';
      }),
    // An approved handoff's run results; a draft or a declined one shares none.
    work:
      opts.work !== false &&
      task !== null &&
      task !== 'deleted' &&
      task.approved
        ? workFacts(deps, task.id, task.phase === 'landed')
        : {},
    clientIds: Object.fromEntries(deps.messages.idemKeysFor(own)),
  };
}
