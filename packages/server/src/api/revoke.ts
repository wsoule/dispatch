import { isClientAddress } from '@dispatch/a2a';
import { gateOf, SYSTEM_ADDRESS } from '@dispatch/protocol';
import type { DeliveryEngine, Message } from '@dispatch/protocol';

import type { ApiContext } from '../api.js';
import { closeGate } from '../messaging/gates.js';
import { runOperator } from '../orchestrator/types.js';

type CascadeContext = Pick<
  ApiContext,
  'messaging' | 'memory' | 'docs' | 'orchestrator' | 'events' | 'a2a'
>;

/**
 * XH-R3: what revoking teammate `handle` takes with it, once their token is
 * gone. Their agents and A2A clients (`agent:<handle>/…`) are revoked; asks
 * they or their agents left open and proposals they raised are closed, except
 * that a memory or doc proposal their run raised is re-gated to the owner
 * (XH-R9) so it is not lost; live
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
  // A memory or doc proposal their run raised is re-gated, now to the owner,
  // rather than lost (XH-R9); their own and their agents' asks close.
  // The replacement gates, kept open by the close step below.
  const replacements = new Set<string>();
  for (const question of ctx.messaging.engine.openBlocking()) {
    const by = proposer(ctx, question);
    if (by === null || !by.startsWith('run:') || !theirs(by)) continue;
    try {
      const replacement = await regate(ctx, question);
      if (replacement !== null) replacements.add(replacement);
    } catch (err) {
      console.error(`dispatchd: could not re-gate ${question.id}`, err);
    }
  }
  step(`close ${handle}'s asks and proposals`, () => {
    for (const question of ctx.messaging.engine.openBlocking()) {
      if (replacements.has(question.id)) continue;
      if (theirs(question.from) || theirs(proposer(ctx, question)))
        closeGate(ctx.messaging.engine, question.id, reason);
    }
  });
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

// Raises a fresh gate for the memory or doc proposal `question` asks about,
// recorded in its place so closing `question` decides nothing; the new gate's
// id, or null when none was raised.
async function regate(
  ctx: CascadeContext,
  question: Message
): Promise<string | null> {
  const gate = gateOf(question);
  let replacement: string | null = null;
  if (gate?.type === 'memory') {
    const moved = await ctx.memory.engine?.regate(gate.proposalId);
    replacement = moved?.to ?? null;
  } else if (gate?.type === 'doc') {
    await ctx.docs.regate(gate.proposal);
    const p = ctx.docs.proposalForGate(gate.proposal);
    replacement = p !== null && p.state === 'open' ? p.gate : null;
  }
  return replacement === question.id ? null : replacement;
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
