import {
  approvalReply,
  findOverseerActionGate,
  findOverseerApprovalGate,
  type Message,
  type OverseerRecord,
  type ReplyInput,
} from '@dispatch/client';

// The Overseer on the phone, without React: which open gate answers a card in
// the conversation, and what the answer says. The desktop's session hook
// (useOverseerSession) does the same through react-query, which the phone
// does not use; the reply shapes here must match it.

/** The answer to a queued Overseer action: confirm runs it, cancel drops it.
 *  The phone grants nothing beyond the one action. */
export function actionReply(confirm: boolean): ReplyInput {
  return { body: '', choice: confirm ? 'confirm' : 'cancel' };
}

/** The answer to a built-in tool call the running turn is parked on. Allow
 *  is once only on the phone: no "for this conversation" grant. */
export function toolCallReply(allow: boolean): ReplyInput {
  return approvalReply(allow);
}

export type OverseerCardRef =
  | { kind: 'action'; actionId: string }
  | { kind: 'approval'; requestId: string };

/** The open gate message a card's answer replies to, or null once it is
 *  gone (decided elsewhere, or the turn ended). */
export function gateForCard(
  gates: readonly Message[],
  conversationId: string,
  card: OverseerCardRef
): Message | null {
  return card.kind === 'action'
    ? findOverseerActionGate(gates, conversationId, card.actionId)
    : findOverseerApprovalGate(gates, conversationId, card.requestId);
}

/** The stream ids of the record's rows: live segments it already holds. */
export function committedSegments(
  record: OverseerRecord | undefined
): Set<string> {
  return new Set(
    record?.messages.flatMap((m) =>
      m.streamId === undefined ? [] : [m.streamId]
    ) ?? []
  );
}
