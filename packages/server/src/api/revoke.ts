import { isClientAddress } from '@dispatch-foo/a2a';
import { gateOf, SYSTEM_ADDRESS } from '@dispatch-foo/protocol';
import type { DeliveryEngine, Message } from '@dispatch-foo/protocol';

import type { ApiContext } from '../api.js';
import { closeGate, SYSTEM_SENDER } from '../messaging/gates.js';
import { runOperator } from '../orchestrator/types.js';

type CascadeContext = Pick<
  ApiContext,
  | 'messaging'
  | 'memory'
  | 'docs'
  | 'orchestrator'
  | 'events'
  | 'a2a'
  | 'actorContext'
>;

/**
 * XH-R3: what revoking teammate `handle` takes with it, once their token is
 * gone. Their agents and A2A clients (`agent:<handle>/…`) are revoked; asks
 * they or their agents left open and proposals they raised are closed; live
 * runs acting for them are stopped; their event sockets are closed. Each step
 * is logged and skipped on failure, so one stuck piece never keeps the rest
 * acting for someone who has left.
 */
export async function revokeCascade(
  ctx: CascadeContext,
  handle: string
): Promise<void> {
  const human = `human:${handle}`;
  const prefix = `agent:${handle}/`;
  const reason = `${human}'s access was revoked`;
  const runOperatorOf = (address: string): string | null => {
    if (!address.startsWith('run:')) return null;
    const meta = ctx.orchestrator
      .list()
      .find((r) => r.id === address.slice('run:'.length));
    return meta === undefined ? null : runOperator(meta);
  };
  const theirs = (address: string | null | undefined): boolean =>
    address !== null &&
    address !== undefined &&
    (address === human ||
      address.startsWith(prefix) ||
      runOperatorOf(address) === human);

  step(`revoke ${handle}'s agents`, () => revokeAgents(ctx, prefix));
  step(`cancel ${handle}'s pairing offers`, () =>
    ctx.a2a?.cancelOffersBy(human)
  );
  const closed: Message[] = [];
  step(`close ${handle}'s asks and proposals`, () => {
    for (const question of ctx.messaging.engine.openBlocking()) {
      if (!theirs(question.from) && !theirs(proposer(ctx, question))) continue;
      step(`settle the proposal behind ${question.id}`, () =>
        settleProposal(ctx, question, reason)
      );
      if (closeGate(ctx.messaging.engine, question.id, reason))
        closed.push(question);
    }
  });
  await tellOwner(ctx, human, closed);
  for (const meta of ctx.orchestrator.list()) {
    if (runOperator(meta) !== human || !ctx.orchestrator.isRunLive(meta.id))
      continue;
    try {
      await ctx.orchestrator.cancel(meta.id);
    } catch (err) {
      console.error(`dispatchd: could not stop ${meta.id} on revoke`, err);
    }
  }
  step(`close ${handle}'s sockets`, () => ctx.events.revalidate());
}

// One cascade step; a failure is logged, never thrown.
function step(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`dispatchd: could not ${what}`, err);
  }
}

// Revokes every agent row under `prefix`, closing any registration gate it
// still has; an A2A client also loses its open asks and webhooks.
function revokeAgents(ctx: CascadeContext, prefix: string): void {
  const store = ctx.messaging.store;
  for (const agent of store.agents()) {
    if (!agent.address.startsWith(prefix) || agent.status === 'revoked')
      continue;
    store.putAgent({ ...agent, status: 'revoked', approvedBy: null });
    for (const question of ctx.messaging.engine.openBlocking()) {
      const gate = gateOf(question);
      if (gate?.type === 'agent-registration' && gate.agent === agent.address)
        closeGate(
          ctx.messaging.engine,
          question.id,
          'its teammate was revoked'
        );
    }
    ctx.memory.host.agentDecided(agent.address, false);
    if (isClientAddress(agent.address)) ctx.a2a?.clientRevoked(agent.address);
  }
}

// A close answers no gate handler, so the memory or doc proposal a closed
// gate stood for is settled here: a memory proposal expires, a doc proposal
// is rejected by the system with the revoke as its reason.
function settleProposal(
  ctx: CascadeContext,
  question: Message,
  reason: string
): void {
  if (question.from !== SYSTEM_ADDRESS) return;
  const gate = gateOf(question);
  if (gate?.type === 'memory')
    ctx.memory.engine?.applyGateAnswer({
      proposalId: gate.proposalId,
      gateId: question.id,
      choice: 'reject',
      by: SYSTEM_ADDRESS,
      reason,
      expired: true,
    });
  else if (gate?.type === 'doc' && ctx.docs.available)
    ctx.docs.rejectProposal(gate.proposal, SYSTEM_ADDRESS, reason);
}

// One notice to the owner listing what the revoke closed, so it stays seen.
async function tellOwner(
  ctx: CascadeContext,
  human: string,
  closed: readonly Message[]
): Promise<void> {
  if (closed.length === 0) return;
  const lines = closed.map((m) => `- ${m.body.split('\n', 1)[0]} (${m.id})`);
  try {
    await ctx.messaging.engine.send(
      {
        to: [ctx.actorContext.humanRef],
        kind: 'notice',
        body: `Revoking ${human} closed ${closed.length} open item${closed.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
        refs: closed.map((m) => ({ type: 'message' as const, id: m.id })),
      },
      SYSTEM_SENDER
    );
  } catch (err) {
    console.error(
      `dispatchd: could not tell the owner what revoking ${human} closed`,
      err
    );
  }
}

// Who raised the proposal a system gate asks about, or null for any other
// question: a memory or doc proposal's author, a task proposal's client.
function proposer(ctx: CascadeContext, question: Message): string | null {
  if (question.from !== SYSTEM_ADDRESS) return null;
  const gate = gateOf(question);
  switch (gate?.type) {
    case 'memory':
      return ctx.memory.shared?.getProposal(gate.proposalId)?.author ?? null;
    case 'doc': {
      const p = ctx.docs.proposalForGate(gate.proposal);
      return p === null ? null : p.runId === null ? p.author : `run:${p.runId}`;
    }
    case 'task-proposal':
      return gate.proposedBy;
    default:
      return null;
  }
}

/**
 * Whether `address` speaks for a teammate who no longer holds a usable token:
 * `human:<handle>` or one of their `agent:<handle>/…`. The owner never does.
 */
export function speaksForRevoked(
  address: string,
  ownerHandle: string,
  hasAccess: (handle: string) => boolean
): boolean {
  const match = /^(?:human:([^/]+)|agent:([^/]+)\/.+)$/.exec(address);
  const handle = match?.[1] ?? match?.[2];
  return handle !== undefined && handle !== ownerHandle && !hasAccess(handle);
}

/**
 * XH-R3: a question that lands after its sender was revoked (a request that
 * passed auth before the revoke and wrote after its cascade) is closed on
 * arrival, as the cascade would have closed it. Returns its unsubscribe.
 */
export function closeAsksOfRevoked(
  engine: DeliveryEngine,
  revoked: (address: string) => boolean
): () => void {
  return engine.subscribe((e) => {
    if (e.type !== 'message' || !e.message.blocking) return;
    const { id, from } = e.message;
    if (!revoked(from)) return;
    // After the send that emitted this has finished with the store.
    queueMicrotask(() => {
      try {
        closeGate(engine, id, `${from}'s access was revoked`);
      } catch (err) {
        console.error(`dispatchd: could not close ${id} on revoke`, err);
      }
    });
  });
}
