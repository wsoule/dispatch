import type {
  OverseerAction,
  OverseerApproval,
  OverseerMessage,
  OverseerRecord,
} from '@dispatch/client';

import { TASKS_PRESETS, type TasksPreset } from './tasksPresets';

// One rendered row of a overseer conversation, flattened from the record's
// transcript the same way planThread.ts flattens a plan's. Beyond the plan
// thread's message/pending/failed rows, the overseer transcript carries three
// more kinds: `tool` (a tool call the assistant made mid-turn — a status tool
// or a built-in one), the action lifecycle, which splits into `confirm` (a
// queued mutation still awaiting the human — rendered as the approve/deny
// card) and `outcome` (a decision that already happened, kept as the audit
// line it is), and the approval lifecycle: `approve` (a built-in tool call
// the running turn is blocked on — the allow/deny card) settling into the
// same `outcome` rows.
export type OverseerThreadItem =
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
      outcome: 'applied' | 'allowed' | 'denied' | 'failed';
      text: string;
      at: string;
    }
  | {
      kind: 'confirm';
      key: string;
      action: OverseerAction;
      /** The server's failure text when the last approval attempt threw — the
       * action came back to `pending` for a retry, and the card should say why. */
      failure: string | null;
    }
  | { kind: 'approve'; key: string; approval: OverseerApproval }
  | { kind: 'pending'; key: string }
  | { kind: 'failed'; key: string; error: string }
  /** A line across the stream: Stop, a context rollover, a daemon restart. */
  | {
      kind: 'notice';
      key: string;
      notice: 'stopped' | 'rollover' | 'restarted';
      text: string;
      at: string;
    }
  /** Typed during a turn; `waiting` once that turn ended without sending it. */
  | { kind: 'queued'; key: string; text: string; waiting: boolean }
  /** The agent's show_tasks: a door the human opens, never a jump. */
  | { kind: 'door'; key: string; door: OverseerDoor; at: string };

/** Where a show_tasks door opens Tasks. */
export interface OverseerDoor {
  preset?: TasksPreset;
  taskId?: string;
  milestoneId?: string;
}

// The door a show_tasks result recorded, or null for an error or a shape this build does not know.
function doorOf(text: string): OverseerDoor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const door = (parsed as { door?: unknown } | null)?.door;
  if (typeof door !== 'object' || door === null) return null;
  const { preset, taskId, milestoneId } = door as Record<string, unknown>;
  const presets: readonly string[] = TASKS_PRESETS.map((p) => p.id);
  return {
    ...(typeof preset === 'string' && presets.includes(preset)
      ? { preset: preset as TasksPreset }
      : {}),
    ...(typeof taskId === 'string' ? { taskId } : {}),
    ...(typeof milestoneId === 'string' ? { milestoneId } : {}),
  };
}

/** The door's button text. */
export function doorLabel(door: OverseerDoor): string {
  const target =
    door.taskId ??
    door.milestoneId ??
    (door.preset !== undefined && door.preset !== 'all'
      ? TASKS_PRESETS.find((p) => p.id === door.preset)?.label
      : undefined);
  return target === undefined ? 'Show in tasks →' : `Show ${target} in tasks →`;
}

const TURN_FAILED_FALLBACK =
  'The overseer stopped before it answered. Send the message again to retry.';

/**
 * Flattens a overseer record into the rows the Overseer view renders.
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
export function buildOverseerThread(
  record: OverseerRecord | undefined
): OverseerThreadItem[] {
  if (record === undefined) return [];

  const pendingById = new Map(record.pendingActions.map((a) => [a.id, a]));
  const parkedById = new Map(
    record.pendingApprovals.map((a) => [a.requestId, a])
  );
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

  const items: OverseerThreadItem[] = [];
  const confirmEmitted = new Set<string>();
  const approveEmitted = new Set<string>();
  record.messages.forEach((message, i) => {
    const item = buildRow(
      record,
      message,
      i,
      pendingById,
      lastActionRow,
      parkedById
    );
    if (item !== null) {
      items.push(item);
      if (item.kind === 'confirm') confirmEmitted.add(item.action.id);
      if (item.kind === 'approve') approveEmitted.add(item.approval.requestId);
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

  // Same guarantee for a parked built-in call: the turn is blocked on it, so
  // it must be decidable even if its transcript row somehow went missing.
  for (const approval of record.pendingApprovals) {
    if (!approveEmitted.has(approval.requestId)) {
      items.push({
        kind: 'approve',
        key: `${record.id}-approve-${approval.requestId}`,
        approval,
      });
    }
  }

  // A running turn parked on a call is waiting on the human, not working —
  // the card says so, and a spinner under it would say the opposite.
  if (record.state === 'running' && record.pendingApprovals.length === 0) {
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
  (record.queued ?? []).forEach((queued, i) => {
    items.push({
      kind: 'queued',
      key: `${record.id}-queued-${i}`,
      text: queued.text,
      waiting: record.state !== 'running',
    });
  });
  return items;
}

// One transcript message to its rendered row (or `null` for rows the flatten
// rule drops) — split out of buildOverseerThread so the action-row logic reads
// as one decision instead of a nest inside the walk.
function buildRow(
  record: OverseerRecord,
  message: OverseerMessage,
  index: number,
  pendingById: Map<string, OverseerAction>,
  lastActionRow: Map<string, number>,
  parkedById: Map<string, OverseerApproval>
): OverseerThreadItem | null {
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
  if (message.role === 'notice') {
    return {
      kind: 'notice',
      key,
      notice: message.notice ?? 'stopped',
      text: message.text,
      at: message.at,
    };
  }
  if (message.role === 'tool' && message.tool === 'show_tasks') {
    const door = doorOf(message.text);
    if (door !== null) return { kind: 'door', key, door, at: message.at };
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

  // `approval` rows. A parked call renders as its allow/deny card; a decided
  // one keeps its decision row and drops the stale "parked" row it replaced.
  if (message.role === 'approval') {
    const parked =
      message.requestId !== undefined
        ? parkedById.get(message.requestId)
        : undefined;
    if (parked !== undefined) {
      return {
        kind: 'approve',
        key: `${record.id}-approve-${parked.requestId}`,
        approval: parked,
      };
    }
    if (message.outcome === 'allowed' || message.outcome === 'denied') {
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

// The words a row can be found by; cards and spinners have none of their own.
function searchableText(item: OverseerThreadItem): string | null {
  switch (item.kind) {
    case 'message':
    case 'outcome':
    case 'notice':
    case 'queued':
      return item.text;
    case 'tool':
      return `${item.tool} ${item.text}`;
    case 'confirm':
      return item.action.summary;
    case 'approve':
      return item.approval.summary;
    case 'failed':
      return item.error;
    case 'pending':
    case 'door':
      return null;
  }
}

/** ⌘F over the stream: the rows whose text holds `query`, ignoring case. */
export function findInThread(
  items: OverseerThreadItem[],
  query: string
): OverseerThreadItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return items;
  return items.filter(
    (item) => searchableText(item)?.toLowerCase().includes(needle) === true
  );
}
