import type {
  Address,
  DeliveryEngine,
  GateData,
  Message,
  Sender,
  SqliteMessageStore,
} from '@dispatch-foo/protocol';
import { gateOf, SYSTEM_ADDRESS } from '@dispatch-foo/protocol';
import { randomBytes } from 'node:crypto';

import type { OverseerToolContext } from '../orchestrator/overseerTools.js';
import { OrchestratorConflictError } from '../orchestrator/types.js';
import { closeGate, openToolApprovalGate, SYSTEM_SENDER } from './gates.js';
import { INTERNAL_TOKEN_PREFIX } from './internalAgents.js';
import { TOOL_APPROVAL_CHOICES, toolApprovalGateData } from './toolApproval.js';

// Creates the overseer's agent record, approved, only when none exists, so a
// human's revoke survives restarts.
export function ensureOverseerActor(
  store: SqliteMessageStore,
  overseer: Address,
  now: string
): void {
  if (store.getAgent(overseer) !== null) return;
  store.putAgent({
    address: overseer,
    displayName: 'Overseer',
    client: 'dispatch',
    tokenHash: `${INTERNAL_TOKEN_PREFIX}${randomBytes(16).toString('hex')}`,
    status: 'approved',
    muted: false,
    approvedBy: SYSTEM_ADDRESS,
    createdAt: now,
  });
}

export interface OverseerBus {
  /** The overseer's own address, `agent:<owner>/overseer`. */
  readonly overseer: Address;
  // A human line from `speaker`, or the overseer's reply to that speaker.
  post(
    line:
      | { speaker: Sender; text: string; replyTo: string | null }
      | { overseerTo: Address; text: string; replyTo: string | null }
  ): Promise<Message>;
  raiseAction(
    conversationId: string,
    action: { id: string; summary: string; lastError?: string }
  ): Promise<void>;
  raiseToolApproval(
    conversationId: string,
    approval: {
      requestId: string;
      toolName: string;
      input: unknown;
      summary: string;
    }
  ): Promise<void>;
  closeGate(
    conversationId: string,
    key: { actionId: string } | { requestId: string },
    reason: string
  ): void;
  // The overseer's AgentRecord is anything but approved.
  revoked(): boolean;
}

// The open gate a conversation raised for one action or one parked call.
function conversationGate(
  engine: DeliveryEngine,
  conversationId: string,
  key: { actionId: string } | { requestId: string }
): Message | null {
  return (
    engine.openBlocking().find((m) => {
      const gate = gateOf(m);
      if ('actionId' in key) {
        return (
          gate?.type === 'overseer-action' &&
          gate.conversation === conversationId &&
          gate.actionId === key.actionId
        );
      }
      return (
        gate?.type === 'tool-approval' &&
        gate.conversation === conversationId &&
        gate.requestId === key.requestId
      );
    }) ?? null
  );
}

// The overseer's conversations on the bus: its lines with humans, and the
// gates its queued actions and parked tool calls raise to the owner.
export function createOverseerBus(
  engine: DeliveryEngine,
  store: SqliteMessageStore,
  opts: { owner: Address; overseer: Address }
): OverseerBus {
  const asOverseer: Sender = { address: opts.overseer, canDecide: false };
  return {
    overseer: opts.overseer,
    async post(line) {
      if ('overseerTo' in line) {
        const sent = await engine.send(
          {
            to: [line.overseerTo],
            kind: 'message',
            body: line.text,
            replyTo: line.replyTo,
          },
          asOverseer
        );
        return sent.message;
      }
      const sent = await engine.send(
        {
          to: [opts.overseer],
          kind: 'message',
          body: line.text,
          replyTo: line.replyTo,
        },
        line.speaker
      );
      // The manager consumed the line already; it never waits in a mailbox.
      for (const d of sent.deliveries)
        if (d.recipient === opts.overseer) engine.markRead(d.id);
      return sent.message;
    },
    async raiseAction(conversationId, action) {
      const failed =
        action.lastError === undefined
          ? ''
          : ` (the last attempt failed: ${action.lastError})`;
      await engine.send(
        {
          to: [opts.owner],
          kind: 'question',
          blocking: true,
          choices: ['confirm', 'cancel'],
          body: `The overseer wants to: ${action.summary}${failed}`,
          data: {
            type: 'overseer-action',
            conversation: conversationId,
            actionId: action.id,
            summary: action.summary,
          } satisfies GateData,
        },
        SYSTEM_SENDER
      );
    },
    async raiseToolApproval(conversationId, approval) {
      await engine.send(
        {
          to: [opts.owner],
          kind: 'question',
          blocking: true,
          choices: [...TOOL_APPROVAL_CHOICES],
          body: `The overseer wants to run ${approval.summary}`,
          data: toolApprovalGateData(
            { conversation: conversationId },
            approval
          ),
        },
        SYSTEM_SENDER
      );
    },
    // A no-op once the gate is answered, including while its answer applies.
    closeGate(conversationId, key, reason) {
      try {
        const gate = conversationGate(engine, conversationId, key);
        if (gate !== null) closeGate(engine, gate.id, reason);
      } catch (err) {
        console.error('messaging: could not close an overseer gate', err);
      }
    },
    revoked: () => store.getAgent(opts.overseer)?.status !== 'approved',
  };
}

// The real OverseerToolContext['messaging'], over the engine: a confirmed
// action answers a run's gate, or messages it, as the human who confirmed it.
export function overseerToolMessaging(
  engine: DeliveryEngine
): OverseerToolContext['messaging'] {
  return {
    async answerRunApproval(runId, requestId, answer, actor) {
      const gate = openToolApprovalGate(engine, runId, requestId);
      if (gate === null) {
        throw new OrchestratorConflictError(
          `run is not awaiting approval: ${runId}`
        );
      }
      await engine.reply(
        gate.id,
        { body: answer.body, choice: answer.choice },
        { address: actor, canDecide: true }
      );
    },
    async sendAsHuman(to, text, actor) {
      await engine.send(
        { to: [to], kind: 'message', body: text },
        { address: actor, canDecide: true }
      );
    },
  };
}
