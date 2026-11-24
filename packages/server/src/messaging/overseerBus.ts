import type {
  Address,
  DeliveryEngine,
  GateData,
  Message,
  Sender,
  SqliteMessageStore,
} from '@dispatch-foo/protocol';
import { gateOf, isSystemMarker, SYSTEM_ADDRESS } from '@dispatch-foo/protocol';
import { randomBytes } from 'node:crypto';

import type { OverseerQuestion } from '../orchestrator/overseerBackend.js';
import type { OverseerToolContext } from '../orchestrator/overseerTools.js';
import { OrchestratorConflictError } from '../orchestrator/types.js';
import type { RootFinder } from './conversations.js';
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
  /** The daemon owner, whom the overseer's gates and questions go to by default. */
  readonly owner: Address;
  // A human line from `speaker`, or the overseer's reply to that speaker.
  post(
    line:
      | { speaker: Sender; text: string; replyTo: string | null }
      | { overseerTo: Address; text: string; replyTo: string | null }
  ): Promise<Message>;
  raiseAction(
    conversationId: string,
    action: { id: string; summary: string }
  ): Promise<void>;
  raiseToolApproval(
    conversationId: string,
    approval: {
      requestId: string;
      toolName: string;
      input: unknown;
      summary: string;
      held?: boolean;
    }
  ): Promise<void>;
  closeGate(
    conversationId: string,
    key: { actionId: string } | { requestId: string },
    reason: string
  ): void;
  // One question of an AskUserQuestion call, asked of the owner as a blocking
  // question (not a gate: any answer, typed or chosen, settles it). Resolves
  // with the question message's id, which its answer replies to.
  askQuestion(question: OverseerBusQuestion): Promise<string>;
  // Closes an asked question nobody answered; a no-op once it is answered.
  closeQuestion(messageId: string, reason: string): void;
  // Calls `listener` with every answer to a question the overseer asked.
  onAnswer(listener: (answer: OverseerBusAnswer) => void): () => void;
  // The overseer's AgentRecord is anything but approved.
  revoked(): boolean;
}

/** One question the overseer asks on the bus, of one human. */
export interface OverseerBusQuestion {
  /** Who is asked: the conversation's owner. Only their answer counts. */
  to: Address;
  conversation: string;
  /** The AskUserQuestion call it belongs to, and its place in that call. */
  requestId: string;
  index: number;
  question: OverseerQuestion;
}

/** An answer to a question the overseer asked: who, the choice, and the text. */
export interface OverseerBusAnswer {
  questionId: string;
  from: Address;
  body: string;
  choice?: string;
}

/** The `data` an overseer question carries, so a client can find its conversation. */
export interface OverseerQuestionData {
  overseerQuestion: { conversation: string; requestId: string; index: number };
}

// The question's text as a reader sees it in a thread or under Needs you:
// the question, then each option and what it means.
function questionBody(q: OverseerQuestion): string {
  const options = q.options.map((o) =>
    o.description.trim() === ''
      ? `- ${o.label}`
      : `- ${o.label}: ${o.description}`
  );
  const how = q.multiSelect
    ? 'Answer with every option that applies, separated by commas, or in your own words.'
    : 'Pick one, or answer in your own words.';
  return [q.question, '', ...options, '', how].join('\n');
}

// A single-choice question's options as buttons. Only labels the protocol
// takes as distinct one-line choices; otherwise the answer is typed.
function questionChoices(q: OverseerQuestion): string[] | undefined {
  if (q.multiSelect) return undefined;
  const labels = q.options.map((o) => o.label.trim());
  const usable =
    labels.length > 0 &&
    labels.every((l) => l !== '' && !l.includes('\n')) &&
    new Set(labels).size === labels.length;
  return usable ? labels : undefined;
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
    owner: opts.owner,
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
      await engine.send(
        {
          to: [opts.owner],
          kind: 'question',
          blocking: true,
          choices: ['confirm', 'cancel'],
          body: `The overseer wants to: ${action.summary}`,
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
          // A held call is never offered for the whole conversation.
          choices:
            approval.held === true
              ? TOOL_APPROVAL_CHOICES.filter((c) => c !== 'approve-session')
              : [...TOOL_APPROVAL_CHOICES],
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
    async askQuestion(q) {
      const choices = questionChoices(q.question);
      const sent = await engine.send(
        {
          to: [q.to],
          kind: 'question',
          blocking: true,
          ...(choices !== undefined ? { choices } : {}),
          body: questionBody(q.question),
          data: {
            overseerQuestion: {
              conversation: q.conversation,
              requestId: q.requestId,
              index: q.index,
            },
          } satisfies OverseerQuestionData,
        },
        asOverseer
      );
      return sent.message.id;
    },
    closeQuestion(messageId, reason) {
      try {
        if (engine.answerOf(messageId) !== null) return;
        closeGate(engine, messageId, reason);
      } catch (err) {
        console.error('messaging: could not close an overseer question', err);
      }
    },
    onAnswer(listener) {
      return engine.subscribe((event) => {
        if (event.type !== 'message') return;
        const m = event.message;
        if (m.kind !== 'answer' || m.replyTo === null) return;
        // A close is the system's answer, not a human's.
        if (isSystemMarker(m, 'x-closed')) return;
        const question = engine.getMessage(m.replyTo);
        if (question === null || question.from !== opts.overseer) return;
        // The overseer reads its answers here; none waits in its mailbox.
        for (const d of engine.deliveriesOf(m.id))
          if (d.recipient === opts.overseer && d.state !== 'read')
            engine.markRead(d.id);
        listener({
          questionId: question.id,
          from: m.from,
          body: m.body,
          ...(m.choice !== undefined && m.choice !== null
            ? { choice: m.choice }
            : {}),
        });
      });
    },
    revoked: () => store.getAgent(opts.overseer)?.status !== 'approved',
  };
}

// The real OverseerToolContext['messaging'], over the engine: a confirmed
// action answers a run's gate, or messages it, as the human who confirmed it,
// into the newest open root `findRoot` names for that human and run.
export function overseerToolMessaging(
  engine: DeliveryEngine,
  findRoot: RootFinder = () => null
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
    async sendAsHuman(to, text, actor, data) {
      const sender: Sender = { address: actor, canDecide: true };
      const root = findRoot(sender, to);
      const draftedBy = data?.draftedBy;
      await engine.send(
        {
          to: [to],
          kind: 'message',
          body: text,
          ...(root === null ? {} : { replyTo: root.id }),
          ...(draftedBy === undefined ? {} : { data: { draftedBy } }),
        },
        sender
      );
    },
  };
}
