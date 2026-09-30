import type { GateData, Message } from '@dispatch/client';
import type { NotificationKind } from '@dispatch/core/browser';
import { notificationKindForMessage } from '@dispatch/core/browser';
import { GATE_TYPES, gateTypeOf } from '@dispatch/protocol/browser';

/** A plain blocking question a run's agent asked a human, as its card shows it. */
export interface RunQuestion {
  /** The question message's id; the answer replies to it. */
  id: string;
  runId: string;
  question: string;
  /** One-click answers; free text is always accepted too. */
  options: string[];
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
}

/** A run's open scope gate, as the scope card shows it. */
export interface RunScopeRequest {
  /** The gate message's id; the decision replies to it. */
  id: string;
  runId: string;
  paths: string[];
  reason: string;
  requestedAt: string;
  granted: boolean | null;
  decisionReason: string | null;
  decidedAt: string | null;
  decidedBy: 'app' | 'api' | null;
}

type ToolApprovalGate = Extract<GateData, { type: 'tool-approval' }>;

const KNOWN_GATES: ReadonlySet<string> = new Set(GATE_TYPES);

/** The open gates query (`GET /api/decisions/open`): what a deciding human is asked. */
export function openGatesKey(
  port: number | undefined
): readonly ['dispatch-open-gates', number | undefined] {
  return ['dispatch-open-gates', port] as const;
}

/** The message's gate payload, or null for a plain message or `x-` data. A
 *  gate of a type this build does not know is still a gate: a decision card. */
export function gateOf(message: Message): GateData | null {
  return gateTypeOf(message, KNOWN_GATES) === null
    ? null
    : (message.data as GateData);
}

/** A daemon marker (a close, a breaker pause); the same data from anyone else
 *  is ordinary. Mirrors @dispatch/protocol's isSystemMarker. */
export function isSystemMarker(
  message: Pick<Message, 'from' | 'data'>,
  type: 'x-closed' | 'x-breaker'
): boolean {
  const data = message.data;
  return (
    message.from === 'agent:dispatch' &&
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as { type?: unknown }).type === type
  );
}

/** A tool-approval gate's payload, or null for any other message. */
export function toolApprovalOf(message: Message): ToolApprovalGate | null {
  const gate = gateOf(message);
  return gate?.type === 'tool-approval' ? gate : null;
}

/** A task-proposal gate's draft, its A2A proposer and the client's root
 *  message; null for any other message, or a look-alike not from the system. */
export function taskProposalOf(
  message: Message
): { task: string; proposedBy: string; message: string } | null {
  const gate = gateOf(message);
  if (gate?.type !== 'task-proposal' || message.from !== 'agent:dispatch') {
    return null;
  }
  const { task, proposedBy, message: root } = gate;
  return typeof task === 'string' &&
    typeof proposedBy === 'string' &&
    typeof root === 'string'
    ? { task, proposedBy, message: root }
    : null;
}

function isBlockingQuestion(message: Message): boolean {
  return message.kind === 'question' && message.blocking;
}

/** The run a message is about: a tool-approval gate's run, else a `run:` sender's id. */
export function runIdOf(message: Message): string | null {
  const approvalRun = toolApprovalOf(message)?.runId;
  if (approvalRun !== undefined) return approvalRun;
  return message.from.startsWith('run:') ? message.from.slice(4) : null;
}

/** A plain blocking question (no gate data) from a `run:` sender, else null. */
export function toRunQuestion(message: Message): RunQuestion | null {
  if (!isBlockingQuestion(message) || gateOf(message) !== null) return null;
  const runId = runIdOf(message);
  if (runId === null) return null;
  return {
    id: message.id,
    runId,
    question: message.body,
    options: message.choices ?? [],
    askedAt: message.createdAt,
    answer: null,
    answeredAt: null,
  };
}

/** An open scope gate from a `run:` sender, else null. */
export function toScopeRequest(message: Message): RunScopeRequest | null {
  const gate = gateOf(message);
  if (!isBlockingQuestion(message) || gate?.type !== 'scope') return null;
  if (!message.from.startsWith('run:')) return null;
  return {
    id: message.id,
    runId: message.from.slice(4),
    paths: gate.paths,
    reason: gate.reason,
    requestedAt: message.createdAt,
    granted: null,
    decisionReason: null,
    decidedAt: null,
    decidedBy: null,
  };
}

/** Every open run question, grouped by run in the order the gates arrived. */
export function questionsByRun(
  gates: readonly Message[]
): Map<string, RunQuestion[]> {
  const byRun = new Map<string, RunQuestion[]>();
  for (const message of gates) {
    const question = toRunQuestion(message);
    if (question === null) continue;
    const existing = byRun.get(question.runId);
    if (existing === undefined) byRun.set(question.runId, [question]);
    else existing.push(question);
  }
  return byRun;
}

/** Each run's newest open scope gate; its message id is what a decision replies to. */
export function scopeRequestsByRun(
  gates: readonly Message[]
): Map<string, RunScopeRequest> {
  const newest = new Map<string, RunScopeRequest>();
  for (const message of gates) {
    const request = toScopeRequest(message);
    if (request === null) continue;
    const seen = newest.get(request.runId);
    if (seen === undefined || request.requestedAt >= seen.requestedAt) {
      newest.set(request.runId, request);
    }
  }
  return newest;
}

/** The open tool-approval gate for one parked call: (run, request id) names it. */
export function findToolApprovalGate(
  gates: readonly Message[],
  runId: string,
  requestId: string
): Message | null {
  return (
    gates.find((message) => {
      const gate = toolApprovalOf(message);
      return gate?.runId === runId && gate.requestId === requestId;
    }) ?? null
  );
}

/** The open gate for one action an overseer conversation queued. */
export function findOverseerActionGate(
  gates: readonly Message[],
  conversationId: string,
  actionId: string
): Message | null {
  return (
    gates.find((message) => {
      const gate = gateOf(message);
      return (
        gate?.type === 'overseer-action' &&
        gate.conversation === conversationId &&
        gate.actionId === actionId
      );
    }) ?? null
  );
}

/** The open tool-approval gate for one call an overseer conversation parked. */
export function findOverseerApprovalGate(
  gates: readonly Message[],
  conversationId: string,
  requestId: string
): Message | null {
  return (
    gates.find((message) => {
      const gate = toolApprovalOf(message);
      return (
        gate?.conversation === conversationId && gate.requestId === requestId
      );
    }) ?? null
  );
}

/** The gate answer an approval card's decision stands for. */
export function approvalReply(
  allow: boolean,
  opts?: { scope?: 'once' | 'session'; reason?: string }
): { body: string; choice: 'approve' | 'approve-session' | 'deny' } {
  const body = opts?.reason ?? '';
  if (!allow) return { body, choice: 'deny' };
  return {
    body,
    choice: opts?.scope === 'session' ? 'approve-session' : 'approve',
  };
}

function firstLine(text: string): string {
  return text.split(/\r\n|[\n\r\u2028\u2029]/)[0]?.trim() ?? '';
}

/** The OS notification a new gate raises, or null: overseer gates show in the
 *  chat, and the question edge detector already notifies a run's question. */
export function gateNotification(
  message: Message,
  titleOfRun: (runId: string) => string | undefined
): { title: string; body: string; kind: NotificationKind } | null {
  if (!message.to.some((address) => address.startsWith('human:'))) return null;
  const kind = notificationKindForMessage(message);
  if (kind === null) return null;
  const gate = gateOf(message);
  if (gate?.type === 'overseer-action') return null;
  if (gate?.type === 'tool-approval' && gate.conversation !== undefined) {
    return null;
  }
  const runId = runIdOf(message);
  if (gate === null && runId !== null) return null;
  const runTitle = runId === null ? null : (titleOfRun(runId) ?? runId);
  if (gate?.type === 'tool-approval') {
    return {
      title: 'Approval needed',
      body: runTitle === null ? gate.tool : `${gate.tool} · ${runTitle}`,
      kind,
    };
  }
  if (kind === 'approval') {
    return { title: 'Approval needed', body: firstLine(message.body), kind };
  }
  if (kind === 'memory') {
    return {
      title: 'Memory proposal to review',
      body: firstLine(message.body),
      kind,
    };
  }
  if (kind === 'scope-request') {
    return {
      title: 'An agent needs scope approval',
      body: runTitle ?? firstLine(message.body),
      kind,
    };
  }
  return {
    title: 'An agent has a question',
    body: firstLine(message.body),
    kind,
  };
}

/** The open gates once `message` lands (an answer closes its gate, a blocking
 *  message to a human joins); `open` itself when nothing changes. */
export function openGatesAfter(open: Message[], message: Message): Message[] {
  if (message.kind === 'answer') {
    const closed = message.replyTo;
    return open.some((m) => m.id === closed)
      ? open.filter((m) => m.id !== closed)
      : open;
  }
  const asksHuman =
    message.blocking && message.to.some((addr) => addr.startsWith('human:'));
  return asksHuman && !open.some((m) => m.id === message.id)
    ? [...open, message]
    : open;
}

/** True when `message` is a tool approval for a run that already has another
 *  open, so the notification that run raised first covers this one too. */
export function foldsIntoOpenApproval(
  message: Message,
  openGates: readonly Message[]
): boolean {
  const runId = toolApprovalOf(message)?.runId;
  if (runId === undefined) return false;
  return openGates.some(
    (open) => open.id !== message.id && toolApprovalOf(open)?.runId === runId
  );
}
