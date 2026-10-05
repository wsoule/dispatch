import type {
  GateAnswer,
  MemoryEngine,
  MemoryKind,
  MemoryProposal,
  MemoryStore,
} from '@dispatch/memory';
import { isRestoredOrigin } from '@dispatch/memory';
import { gateOf, isSystemMarker, SYSTEM_ADDRESS } from '@dispatch/protocol';
import type { DeliveryEngine, Message, Ref } from '@dispatch/protocol';

import { closeGate, SYSTEM_SENDER } from '../messaging/gates.js';
import { settle } from '../messaging/host.js';
import type { Messaging } from '../messaging/service.js';

// The kind a gate names: the proposal's content kind, or its retire target's.
export function memoryGateKind(
  p: MemoryProposal,
  shared: MemoryStore
): MemoryKind {
  if (p.content !== null) return p.content.kind;
  if (p.target === null) return 'fact';
  return shared.getEntry(p.target)?.kind ?? 'fact';
}

// The open memory gate the system raised for `proposalId` to `to`, if any. One
// from anyone else is never adopted (M5): its text was not the system's. One
// to someone else is not reused, so a re-raise can re-address it.
function openGateFor(
  engine: DeliveryEngine,
  proposalId: string,
  to: string
): Message | undefined {
  return engine.openBlocking().find((m) => {
    const gate = gateOf(m);
    return (
      m.from === SYSTEM_ADDRESS &&
      gate?.type === 'memory' &&
      gate.proposalId === proposalId &&
      m.to.includes(to)
    );
  });
}

// Sends `to` (the proposing run's operator or the owner, XH-R9) a content-free
// memory gate, keyed by proposal so overlapping raises share one; an already
// open gate is reused.
export async function raiseMemoryGate(
  engine: DeliveryEngine,
  to: string,
  p: MemoryProposal,
  kind: MemoryKind
): Promise<string> {
  const open = openGateFor(engine, p.id, to);
  if (open !== undefined) return open.id;
  const verb = p.action === 'retire' ? 'proposes retiring' : 'proposes';
  const source = isRestoredOrigin(p.origin)
    ? ' restored from the receipt log; check it before approving'
    : '';
  const refs: Ref[] = [
    ...(p.taskId === null ? [] : [{ type: 'task' as const, id: p.taskId }]),
    ...(p.runId === null ? [] : [{ type: 'run' as const, id: p.runId }]),
  ];
  const sent = await engine.send(
    {
      to: [to],
      kind: 'question',
      blocking: true,
      choices: ['approve', 'reject'],
      body: `${p.author} ${verb} a ${p.scope} memory (${kind})${source}. Review it in Needs you.`,
      refs,
      data: {
        type: 'memory',
        proposalId: p.id,
        action: p.action,
        scope: p.scope,
        kind,
      },
      idempotencyKey: `memory-gate:${p.id}:${to}`,
    },
    SYSTEM_SENDER
  );
  return sent.message.id;
}

// What an answer to a memory gate decides; the expiry sweep's reply, or a
// system close, only expires the proposal. Null for any other gate.
export function memoryGateAnswer(
  question: Message,
  answer: Message
): GateAnswer | null {
  const gate = gateOf(question);
  if (gate?.type !== 'memory' || question.from !== SYSTEM_ADDRESS) return null;
  const expired =
    (answer.data as { type?: unknown } | undefined)?.type === 'x-expired' ||
    isSystemMarker(answer, 'x-closed');
  return {
    proposalId: gate.proposalId,
    gateId: question.id,
    choice: answer.choice === 'approve' ? 'approve' : 'reject',
    by: answer.from,
    reason: answer.body,
    expired,
  };
}

// A deciding human's (or the expiry sweep's) answer applies the proposal
// once; a throw leaves the gate unapplied, so messaging replays it at boot.
export function registerMemoryGate(
  messaging: Pick<Messaging, 'gates'>,
  memory: MemoryEngine
): void {
  messaging.gates.register('memory', (question, answer) =>
    settle(() => {
      const decided = memoryGateAnswer(question, answer);
      if (decided !== null) memory.applyGateAnswer(decided);
    })
  );
}

// Why a memory gate can no longer decide its proposal, or null when it still can.
function strayReason(p: MemoryProposal | null, gateId: string): string | null {
  if (p === null) return 'this memory proposal no longer exists';
  if (p.state !== 'open') return `this memory proposal was already ${p.state}`;
  if (p.gate !== null && p.gate !== gateId)
    return 'another gate holds this memory proposal';
  return null;
}

// Boot: closes every open memory gate whose proposal is gone or decided, or
// records a different gate, so each open proposal keeps exactly one.
export function closeStrayMemoryGates(
  engine: DeliveryEngine,
  shared: MemoryStore
): number {
  let closed = 0;
  for (const question of engine.openBlocking()) {
    const gate = gateOf(question);
    if (gate?.type !== 'memory') continue;
    const reason =
      question.from === SYSTEM_ADDRESS
        ? strayReason(shared.getProposal(gate.proposalId), question.id)
        : 'only Dispatch raises memory gates';
    if (reason !== null && closeGate(engine, question.id, reason)) closed++;
  }
  return closed;
}
