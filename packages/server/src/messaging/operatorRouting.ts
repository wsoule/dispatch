import type { Address, DeliveryEngine, Message, Ref } from '@dispatch/protocol';
import { gateOf, SYSTEM_ADDRESS } from '@dispatch/protocol';

import type { AuthTier } from '../tiers.js';
import { tierAllows } from '../tiers.js';
import { SYSTEM_SENDER } from './gates.js';

// Where a decision gate raised for a run goes, and who else hears of it.
interface GateRoute {
  to: Address;
  // The operator, told by notice when the gate went to the owner instead.
  tell: Address | null;
}

// XH-R9: a run acts for its operator, so it asks and tells them; its gates go
// to them when they may decide, else to the owner with a notice to them.
export interface OperatorRouting {
  humanFor(runId: string | null): Address;
  gateFor(runId: string | null): GateRoute;
}

export interface OperatorRoutingDeps {
  owner: Address;
  // The run's operator; null when it acts for no one, undefined when unknown.
  operatorOf(runId: string): string | null | undefined;
  // Whether a human may answer gates (decide tier or above).
  canDecide(ref: Address): boolean;
  // Whether a human still holds a usable credential; the owner always does.
  hasAccess(ref: Address): boolean;
}

// Builds the routing over the daemon's runs and credential tiers.
export function operatorRouting(deps: OperatorRoutingDeps): OperatorRouting {
  const operatorFor = (runId: string | null): Address | null => {
    if (runId === null) return null;
    const operator = deps.operatorOf(runId) ?? null;
    if (operator === null || operator === deps.owner) return null;
    return deps.hasAccess(operator) ? operator : null;
  };
  return {
    humanFor: (runId) => operatorFor(runId) ?? deps.owner,
    gateFor: (runId) => {
      const operator = operatorFor(runId);
      if (operator === null) return { to: deps.owner, tell: null };
      return deps.canDecide(operator)
        ? { to: operator, tell: null }
        : { to: deps.owner, tell: operator };
    },
  };
}

// Who may decide and who still holds a credential, read from issued teammate
// tokens by `human:<handle>`; the owner is the caller's to add.
export function teamDeciders(teammates: {
  issuedTier(handle: string): AuthTier | null;
  hasAccess(handle: string): boolean;
}): Pick<OperatorRoutingDeps, 'canDecide' | 'hasAccess'> {
  const handleOf = (ref: Address) =>
    ref.startsWith('human:') ? ref.slice('human:'.length) : null;
  return {
    canDecide: (ref) => {
      const handle = handleOf(ref);
      return (
        handle !== null &&
        teammates.hasAccess(handle) &&
        tierAllows(teammates.issuedTier(handle) ?? 'request', 'decide')
      );
    },
    hasAccess: (ref) => {
      const handle = handleOf(ref);
      return handle !== null && teammates.hasAccess(handle);
    },
  };
}

// The run a gate was raised for: its sender run, the run its data or refs
// name, or for a wake gate the run that asked for the wake; null for none.
function gateRunOf(
  engine: Pick<DeliveryEngine, 'getMessage'>,
  question: Message
): string | null {
  const gate = gateOf(question);
  if (gate === null) return null;
  if (question.from.startsWith('run:')) return question.from.slice(4);
  if ('runId' in gate && typeof gate.runId === 'string') return gate.runId;
  if (gate.type === 'wake') {
    const from = engine.getMessage(gate.message)?.from ?? '';
    return from.startsWith('run:') ? from.slice(4) : null;
  }
  return question.refs.find((r) => r.type === 'run')?.id ?? null;
}

// Tells the operator of a run whose gate went to someone else (XH-R9), a tick
// later so a gate policy answers at once tells no one; keyed by the gate, so
// a replay never repeats it. Returns the unsubscribe.
export function installOperatorNotices(
  engine: DeliveryEngine,
  routing: OperatorRouting
): () => void {
  return engine.subscribe((e) => {
    if (e.type !== 'message') return;
    const question = e.message;
    if (question.kind !== 'question' || question.blocking !== true) return;
    const runId = gateRunOf(engine, question);
    const tell = routing.gateFor(runId).tell;
    if (runId === null || tell === null || question.to.includes(tell)) return;
    if (question.from !== SYSTEM_ADDRESS && question.from !== `run:${runId}`)
      return;
    const refs: Ref[] = question.refs.filter(
      (r) => r.type === 'run' || r.type === 'task'
    );
    if (!refs.some((r) => r.type === 'run'))
      refs.unshift({ type: 'run', id: runId });
    const first = question.body.split('\n', 1)[0];
    const tellLater = () => {
      if (engine.answerOf(question.id) !== null) return;
      void engine
        .send(
          {
            to: [tell],
            kind: 'notice',
            body: `Your run ${runId} is waiting on ${question.to.join(', ')} to decide: ${first}`,
            refs,
            idempotencyKey: `operator-notice:${question.id}`,
          },
          SYSTEM_SENDER
        )
        .catch((err: unknown) =>
          console.error('messaging: operator notice failed', err)
        );
    };
    setTimeout(tellLater, 0);
  });
}
