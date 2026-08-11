import type {
  WardenAction,
  WardenMessage,
  WardenRecord,
} from '@dispatch/client';

// One rendered row of a warden conversation, flattened from the record's
// transcript the same way planThread.ts flattens a plan's. Beyond the plan
// thread's message/pending/failed rows, the warden transcript carries two more
// kinds: `tool` (a read-only status call the assistant made mid-turn) and the
// action lifecycle, which splits into `confirm` (a queued mutation still
// awaiting the human — rendered as the approve/deny card) and `outcome` (a
// decision that already happened, kept as the audit line it is).
export type WardenThreadItem =
  | {
      kind: 'message';
      key: string;
      role: 'user' | 'assistant';
      text: string;
      at: string;
    }
  | { kind: 'tool'; key: string; tool: string; text: string; at: string }
  | {
      kind: 'outcome';
      key: string;
      outcome: 'applied' | 'denied' | 'failed';
      text: string;
      at: string;
    }
  | {
      kind: 'confirm';
      key: string;
      action: WardenAction;
      /** The server's failure text when the last approval attempt threw — the
       * action came back to `pending` for a retry, and the card should say why. */
      failure: string | null;
    }
  | { kind: 'pending'; key: string }
  | { kind: 'failed'; key: string; error: string };

const TURN_FAILED_FALLBACK =
  'The warden stopped before it answered. Send the message again to retry.';

/**
 * Flattens a warden record into the rows the Warden view renders.
 *
 * The transcript is append-only server-side: queueing a mutating action pushes
 * an `action` message at `pending`, and the decision later pushes a *second*
 * `action` message (`applied`/`denied`/`failed`) rather than editing the first.
 * Rendering both would show every decided action twice ("queued" then
 * "Applied"), so the rule here is: an action still on `pendingActions` renders
 * as one `confirm` card at its *latest* transcript position (a failed approval
 * moves it down to where the failure happened, with the failure text on the
 * card); an action already decided drops its stale `pending` rows and keeps
 * only its decided `outcome` rows.
 */
export function buildWardenThread(
  record: WardenRecord | undefined
): WardenThreadItem[] {
  if (record === undefined) return [];

  const pendingById = new Map(record.pendingActions.map((a) => [a.id, a]));
  // The transcript index of each still-pending action's newest lifecycle row —
  // the one position its confirm card renders at.
  const lastActionRow = new Map<string, number>();
  record.messages.forEach((message, i) => {
    if (message.role === 'action' && message.actionId !== undefined) {
      if (pendingById.has(message.actionId)) {
        lastActionRow.set(message.actionId, i);
      }
    }
  });

  const items: WardenThreadItem[] = [];
  const confirmEmitted = new Set<string>();
  record.messages.forEach((message, i) => {
    const item = buildRow(record, message, i, pendingById, lastActionRow);
    if (item !== null) {
      items.push(item);
      if (item.kind === 'confirm') confirmEmitted.add(item.action.id);
    }
  });

  // A pending action with no transcript row should be impossible (queueing
  // writes both), but the confirmation queue must never be invisible — append
  // a card rather than silently dropping a mutation that's awaiting a human.
  for (const action of record.pendingActions) {
    if (!confirmEmitted.has(action.id)) {
      items.push({
        kind: 'confirm',
        key: `${record.id}-confirm-${action.id}`,
        action,
        failure: null,
      });
    }
  }

  if (record.state === 'running') {
    items.push({ kind: 'pending', key: `${record.id}-pending` });
  } else if (record.state === 'failed') {
    items.push({
      kind: 'failed',
      key: `${record.id}-failed`,
      error:
        record.error !== undefined && record.error.trim() !== ''
          ? record.error
          : TURN_FAILED_FALLBACK,
    });
  }
  return items;
}

// One transcript message to its rendered row (or `null` for rows the flatten
// rule drops) — split out of buildWardenThread so the action-row logic reads
// as one decision instead of a nest inside the walk.
function buildRow(
  record: WardenRecord,
  message: WardenMessage,
  index: number,
  pendingById: Map<string, WardenAction>,
  lastActionRow: Map<string, number>
): WardenThreadItem | null {
  const key = `${record.id}-msg-${index}`;
  if (message.role === 'user' || message.role === 'assistant') {
    return {
      kind: 'message',
      key,
      role: message.role,
      text: message.text,
      at: message.at,
    };
  }
  if (message.role === 'tool') {
    return {
      kind: 'tool',
      key,
      tool: message.tool ?? 'tool',
      text: message.text,
      at: message.at,
    };
  }

  // `action` rows. Still awaiting the human: the newest row for that action
  // becomes its confirm card, older rows drop.
  const actionId = message.actionId;
  const pending =
    actionId !== undefined ? pendingById.get(actionId) : undefined;
  if (pending !== undefined && actionId !== undefined) {
    if (lastActionRow.get(actionId) !== index) return null;
    return {
      kind: 'confirm',
      key: `${record.id}-confirm-${actionId}`,
      action: pending,
      // A failed approval restored the action to pending — surface the server's
      // explanation on the card the human will retry from.
      failure: message.outcome === 'failed' ? message.text : null,
    };
  }

  // Decided (or superseded): keep the decided rows as the audit trail, drop
  // the stale "queued" rows a decision replaced.
  if (
    message.outcome === 'applied' ||
    message.outcome === 'denied' ||
    message.outcome === 'failed'
  ) {
    return {
      kind: 'outcome',
      key,
      outcome: message.outcome,
      text: message.text,
      at: message.at,
    };
  }
  return null;
}
