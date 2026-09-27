import type { TaskFacts, TaskRow } from '@dispatch/a2a';
import { scopeOf } from '@dispatch/a2a';
import type { Delivery } from '@dispatch/protocol';

import type { BridgeDeps } from './port.js';

function byMessage(deliveries: Delivery[]): Map<string, Delivery[]> {
  const out = new Map<string, Delivery[]>();
  for (const d of deliveries)
    out.set(d.messageId, [...(out.get(d.messageId) ?? []), d]);
  return out;
}

// Everything the projection needs about one A2A task, read fresh. A dropped
// recipient task fails only an unanswered ask, so a finished task stays final.
export function gatherFacts(deps: BridgeDeps, row: TaskRow): TaskFacts {
  const root = deps.engine.getMessage(row.id);
  if (root === null) throw new Error(`a2a task ${row.id} has no root message`);
  const thread = deps.engine.thread(root.thread);
  const deliveries = byMessage(thread.deliveries);
  const scope = scopeOf({
    root,
    client: row.client,
    candidates: thread.messages,
    deliveries,
    link: null,
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
    openGates: [],
    task: null,
    dropped: null,
    recipientTaskDropped:
      answer === null &&
      root.to.some(
        (a) =>
          a.startsWith('task:') &&
          deps.tasks.get(a.slice('task:'.length))?.meta.status === 'dropped'
      ),
    work: {},
    clientIds: Object.fromEntries(deps.messages.idemKeysFor(own)),
  };
}
