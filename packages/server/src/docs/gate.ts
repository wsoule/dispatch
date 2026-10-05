import type { DocProposal, PolicyRuling } from '@dispatch-foo/core';
import { describePolicyAuthorization } from '@dispatch-foo/core';
import type { DeliveryEngine, Message, Ref } from '@dispatch-foo/protocol';
import { gateOf, SYSTEM_ADDRESS } from '@dispatch-foo/protocol';

import type { EventBus } from '../events.js';
import type { LedgerStorePort } from '../ledger.js';
import { closeGate, SYSTEM_SENDER } from '../messaging/gates.js';
import { settle } from '../messaging/host.js';
import type { OperatorRouting } from '../messaging/operatorRouting.js';
import { consultProjectPolicy } from '../policyEngine.js';
import type { AuthTier } from '../tiers.js';
import { tierAllows } from '../tiers.js';
import { DocsError } from './errors.js';
import type { DocsGatePort, DocsHost } from './host.js';
import type { DocsService } from './service.js';

// The doc gate: raising it for a proposal, applying its answer, and the ledger
// receipt of a policy approval.

// Who proposed, as the gate names them: the run when there is one.
function proposer(p: DocProposal): string {
  return p.runId === null ? p.author : `run:${p.runId}`;
}

// Sends `to` (the proposing run's operator or the owner, XH-R9) a content-free
// gate for a proposal (title, body and diff stay in docs.db); an open gate for
// the same proposal is reused.
export async function raiseDocGate(
  engine: DeliveryEngine,
  to: string,
  p: DocProposal
): Promise<string> {
  const open = engine.openBlocking().find((m) => {
    const gate = gateOf(m);
    return gate?.type === 'doc' && gate.proposal === p.rev;
  });
  if (open !== undefined) return open.id;
  const refs: Ref[] = [
    { type: 'doc', id: p.doc },
    ...(p.taskId === null ? [] : [{ type: 'task' as const, id: p.taskId }]),
    ...(p.runId === null ? [] : [{ type: 'run' as const, id: p.runId }]),
  ];
  const sent = await engine.send(
    {
      to: [to],
      kind: 'question',
      blocking: true,
      choices: ['approve', 'reject'],
      body: `${proposer(p)} proposes an edit to an accepted doc. Review it in Needs you.`,
      refs,
      data: {
        type: 'doc',
        doc: p.doc,
        proposal: p.rev,
        ...(p.taskId === null ? {} : { taskId: p.taskId }),
        ...(p.runId === null ? {} : { runId: p.runId }),
      },
    },
    SYSTEM_SENDER
  );
  return sent.message.id;
}

// The doc gate's effect: only the system's own gate for an open proposal that
// recorded this question, and only an answer from the system or a human who
// can decide now. Idempotent under recover()'s replay; with docs.db closed it
// throws, so the answer stays unapplied until a boot that can open it.
export function docGateHandler(
  service: DocsService,
  host: Pick<DocsHost, 'canDecide' | 'notice'>
): (question: Message, answer: Message) => Promise<void> {
  return async (question, answer) => {
    const gate = gateOf(question);
    if (gate?.type !== 'doc' || question.from !== SYSTEM_ADDRESS) return;
    if (!service.available) {
      throw new DocsError(
        'unavailable',
        'docs.db is not open; the answer waits for a build that can open it'
      );
    }
    const p = service.proposalForGate(gate.proposal);
    if (p === null) return;
    if (p.state !== 'open') {
      host.notice(
        answer.from,
        question.id,
        `That doc proposal is ${p.state}; nothing changed.`
      );
      return;
    }
    if (p.gate !== question.id) {
      host.notice(
        answer.from,
        question.id,
        'That doc gate was replaced by a newer one; nothing changed. Answer the open gate.'
      );
      return;
    }
    const decides =
      answer.from === SYSTEM_ADDRESS ||
      (answer.from.startsWith('human:') && host.canDecide(answer.from));
    if (!decides) {
      await service.regate(p.rev);
      host.notice(
        answer.from,
        question.id,
        'Your answer did not apply: only a human who can decide may answer a doc gate. A fresh gate was raised.'
      );
      return;
    }
    if (answer.choice === 'approve')
      service.approveProposal(p.rev, answer.from, null);
    else service.rejectProposal(p.rev, answer.from, answer.body);
  };
}

interface PolicyReceiptDeps {
  ledgerStore: Pick<LedgerStorePort, 'add'>;
  events: Pick<EventBus, 'broadcast'>;
  appendPolicyActivity: (taskId: string, text: string) => void;
  ownerRef: string;
  epicOf: (taskId: string) => string | null;
}

// A policy approval's receipt: a ledger decision and the source task's
// [policy] Activity line, naming the doc by id, never its title.
function recordDocPolicyApproval(
  deps: PolicyReceiptDeps,
  p: DocProposal,
  ruling: Extract<PolicyRuling, { mode: 'auto' }>
): void {
  const title = `Doc edit approved: ${p.doc}`;
  const authorization = describePolicyAuthorization(ruling);
  deps.ledgerStore.add({
    kind: 'decision',
    title,
    detail: `proposal ${p.rev} from ${proposer(p)} — ${authorization}`,
    authoredBy: deps.ownerRef,
    epicId: p.taskId === null ? null : deps.epicOf(p.taskId),
    sourceTaskId: p.taskId,
  });
  deps.events.broadcast({ type: 'ledger.changed' });
  if (p.taskId !== null)
    deps.appendPolicyActivity(p.taskId, `[policy] ${title} — ${authorization}`);
}

// The daemon's DocsGatePort over messaging, policy, the ledger and teammates'
// tiers; DaemonDocsHost.bindGates takes it before messaging.recover().
export function docGatePort(
  deps: PolicyReceiptDeps & {
    rootDir: string;
    engine: DeliveryEngine;
    issuedTier: (handle: string) => AuthTier | null;
    routing: Pick<OperatorRouting, 'gateFor'>;
  }
): DocsGatePort {
  const { engine, ownerRef } = deps;
  return {
    canDecide: (address) =>
      address === ownerRef ||
      (address.startsWith('human:') &&
        tierAllows(
          deps.issuedTier(address.slice('human:'.length)) ?? 'request',
          'decide'
        )),
    rule: (risk) => consultProjectPolicy(deps.rootDir, 'doc', risk),
    raiseGate: (p) => raiseDocGate(engine, deps.routing.gateFor(p.runId).to, p),
    closeGate: (gate, reason) => closeGate(engine, gate, reason),
    notice: (to, replyTo, body) => {
      // The system itself has no inbox to tell.
      if (to === SYSTEM_ADDRESS) return;
      const refs: Ref[] =
        replyTo === null ? [] : [{ type: 'message', id: replyTo }];
      void settle(() =>
        engine.send(
          { to: [engine.deliverableAddress(to)], kind: 'notice', body, refs },
          SYSTEM_SENDER
        )
      ).catch((err: unknown) => console.error('docs: notice failed', err));
    },
    recordPolicyApproval: (p, ruling) =>
      recordDocPolicyApproval(deps, p, ruling),
    openDocGates: () =>
      engine.openBlocking().flatMap((m) => {
        const gate = gateOf(m);
        return gate?.type === 'doc'
          ? [{ id: m.id, proposal: gate.proposal }]
          : [];
      }),
  };
}
