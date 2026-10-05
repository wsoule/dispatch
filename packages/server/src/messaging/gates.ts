import type {
  DeliveryEngine,
  GateData,
  Message,
  Sender,
} from '@dispatch/protocol';
import { gateOf, MessagingError, SYSTEM_ADDRESS } from '@dispatch/protocol';
import { AsyncLocalStorage } from 'node:async_hooks';

export const SYSTEM_SENDER: Sender = {
  address: SYSTEM_ADDRESS,
  canDecide: true,
};

// Whether the human sending or answering in this request used the owner's app
// token; gate handlers and wakes read it, and a replay or system answer reads false.
const answering = new AsyncLocalStorage<boolean>();

export function answeringWith<T>(
  ownerCredential: boolean,
  fn: () => Promise<T>
): Promise<T> {
  return answering.run(ownerCredential, fn);
}

export function answeredWithOwnerCredential(): boolean {
  return answering.getStore() === true;
}

export type GateHandler = (question: Message, answer: Message) => Promise<void>;

// Routes an answered gate question to the handler registered for its
// `data.type`; the daemon host's onAnswered hook fans out through it.
export class GateHandlers {
  private readonly handlers = new Map<GateData['type'], GateHandler>();

  register(type: GateData['type'], handler: GateHandler): void {
    this.handlers.set(type, handler);
  }

  // A gate type with no registered handler is ignored, including when the
  // engine replays it after a crash.
  async handle(question: Message, answer: Message): Promise<void> {
    const gate = gateOf(question);
    if (gate === null) return;
    const handler = this.handlers.get(gate.type);
    if (handler === undefined) return;
    await handler(question, answer);
  }
}

// Closes an open question as the system; false when an answer got there first.
/** Which registration a card decides: a prefix of the agent row's token hash. */
export function registrationKey(tokenHash: string): string {
  return tokenHash.slice(0, 16);
}

export function closeGate(
  engine: DeliveryEngine,
  questionId: string,
  reason: string
): boolean {
  try {
    engine.close(questionId, reason);
    return true;
  } catch (err) {
    if (err instanceof MessagingError && err.code === 'conflict') return false;
    throw err;
  }
}

// The open tool-approval gate a run's parked call is waiting on.
export function openToolApprovalGate(
  engine: DeliveryEngine,
  runId: string,
  requestId: string
): Message | null {
  return (
    engine.openBlocking().find((m) => {
      const gate = gateOf(m);
      return (
        gate?.type === 'tool-approval' &&
        gate.runId === runId &&
        gate.requestId === requestId
      );
    }) ?? null
  );
}

// Open blocking questions a human on this machine is asked (decisions/open, the
// decision feed); a question held only by a remote teammate is theirs.
export function openHumanDecisions(engine: DeliveryEngine): Message[] {
  return engine
    .openBlocking()
    .filter((m) =>
      engine.deliveriesOf(m.id).some((d) => d.recipient.startsWith('human:'))
    );
}

// Closes what a run's end leaves unanswerable: approvals parked on it, and what
// a run with no task asked. An execute run's questions wait for its task.
export function closeRunGates(
  engine: DeliveryEngine,
  run: { id: string; hasTask: boolean },
  reason: string
): number {
  let closed = 0;
  for (const question of engine.openBlocking()) {
    // A teammate's question is closed only by its settler (spec "Only the settler closes").
    if (question.origin !== undefined) continue;
    const gate = gateOf(question);
    const parked = gate?.type === 'tool-approval' && gate.runId === run.id;
    const orphaned = question.from === `run:${run.id}` && !run.hasTask;
    if ((parked || orphaned) && closeGate(engine, question.id, reason))
      closed++;
  }
  return closed;
}

// Boot: runs the previous daemon left behind are gone, and so is every overseer
// conversation (they live in memory), so their gates close.
export function closeOrphanedGates(
  engine: DeliveryEngine,
  runs: {
    isRunLive(runId: string): boolean;
    taskIdOfRun(runId: string): string | null;
  }
): number {
  let closed = 0;
  const dead = new Set<string>();
  for (const question of engine.openBlocking()) {
    if (question.origin !== undefined) continue;
    const gate = gateOf(question);
    const conversation =
      gate?.type === 'overseer-action' || gate?.type === 'tool-approval'
        ? gate.conversation
        : undefined;
    if (conversation !== undefined) {
      if (closeGate(engine, question.id, 'the daemon restarted')) closed++;
      continue;
    }
    const runId =
      gate?.type === 'tool-approval'
        ? gate.runId
        : question.from.startsWith('run:')
          ? question.from.slice('run:'.length)
          : undefined;
    if (runId !== undefined && !runs.isRunLive(runId)) dead.add(runId);
  }
  for (const id of dead) {
    closed += closeRunGates(
      engine,
      { id, hasTask: runs.taskIdOfRun(id) !== null },
      'the daemon restarted'
    );
  }
  return closed;
}
