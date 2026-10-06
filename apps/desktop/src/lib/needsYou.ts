import type { MailboxItem } from '@dispatch/client';

import type { DecisionItem } from './decisionFeed';

/** A mailbox entry, as `getMailbox` returns it. */
export type MailboxAsk = MailboxItem;

// The memory gate body for a lesson a git restore brought back (server memory/gate.ts).
const RESTORED = 'restored from the receipt log';

/** The pinned block's groups, in the order they always render. */
export type AskGroup =
  | 'work'
  | 'knowledge'
  | 'people'
  | 'outside'
  | 'agent'
  | 'admin';

export const ASK_GROUP_ORDER: readonly AskGroup[] = [
  'work',
  'knowledge',
  'people',
  'outside',
  'agent',
  'admin',
];

export const ASK_GROUP_LABEL: Record<AskGroup, string> = {
  work: 'Work',
  knowledge: 'Knowledge',
  people: 'People',
  outside: 'Outside',
  agent: 'Agent',
  admin: 'Admin',
};

/** Which group an ask belongs to, or `null` when the item is not an ask (a failed run is ✕). */
export function askGroup(item: DecisionItem): AskGroup | null {
  switch (item.kind) {
    case 'approval':
      if (item.conversation !== undefined) return 'agent';
      switch (item.reason) {
        case 'overseer-action':
          return 'agent';
        case 'task-proposal':
          return 'outside';
        case 'agent-registration':
          return 'admin';
        default:
          return 'work';
      }
    case 'scope-request':
    case 'fix-loop-capped':
      return 'work';
    case 'run-stalled':
      return item.reason === 'failed' ? null : 'work';
    case 'question':
      // A run's question is work; one with no run came from a person.
      return item.runId === undefined ? 'people' : 'work';
    case 'doc':
    case 'memory':
      return 'knowledge';
  }
}

export interface AskGroupRows {
  group: AskGroup;
  items: DecisionItem[];
}

export interface NeedsYou {
  /** Every ask of mine, in render order: group order, oldest first within a group. */
  asks: DecisionItem[];
  groups: AskGroupRows[];
  /** `asks.length`: the orb badge, `tasks ●` and the "Needs you" header all show this. */
  count: number;
  /** Asks owned by someone else on this daemon; shown muted, never counted. */
  teammates: DecisionItem[];
  /** Asks per task, in the same units as `count`. */
  byTask: ReadonlyMap<string, number>;
  taskIds: ReadonlySet<string>;
  /** Restored lessons shown as one row (its first item) that counts as one. */
  restored: DecisionItem[];
}

export interface NeedsYouOptions {
  /** My mailbox: handoffs and blocking questions to me or my tasks are asks too. */
  mailbox?: readonly MailboxAsk[];
  myTaskIds?: ReadonlySet<string>;
}

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// A handoff or blocking question in my mailbox, as a decision-feed row; null when not an ask.
function mailboxAsk(
  entry: MailboxAsk,
  me: string | null,
  myTaskIds: ReadonlySet<string>
): DecisionItem | null {
  const { delivery, message } = entry;
  if (delivery.state === 'answered' || message.from === me) return null;
  const asks =
    message.kind === 'handoff' ||
    (message.kind === 'question' && message.blocking);
  if (!asks) return null;
  const taskId = message.to
    .filter((a) => a.startsWith('task:'))
    .map((a) => a.slice('task:'.length))
    .find((id) => myTaskIds.has(id));
  if (taskId === undefined && (me === null || !message.to.includes(me))) {
    return null;
  }
  const runId = message.from.startsWith('run:')
    ? message.from.slice('run:'.length)
    : undefined;
  return {
    id: `mail:${message.id}`,
    kind: 'question',
    reason: message.kind,
    summary: oneLine(message.body),
    messageId: message.id,
    ...(runId === undefined ? {} : { runId }),
    ...(taskId === undefined ? {} : { taskId }),
    since: message.createdAt,
    ageMs: 0,
    state: 'open',
    disposition: 'blocking',
  };
}

// An item is mine unless it names a different owner; with no known me, every item is.
function isMine(item: DecisionItem, me: string | null): boolean {
  return item.owner === undefined || me === null || item.owner === me;
}

/** The one definition of "needs you": open, blocking asks, one row per gate message. */
export function needsYou(
  decisions: readonly DecisionItem[],
  me: string | null,
  options: NeedsYouOptions = {}
): NeedsYou {
  const myTaskIds = options.myTaskIds ?? new Set<string>();
  const fromMail = (options.mailbox ?? []).flatMap((entry) => {
    const ask = mailboxAsk(entry, me, myTaskIds);
    return ask === null ? [] : [ask];
  });
  const seen = new Set<string>();
  const byGroup = new Map<AskGroup, DecisionItem[]>();
  const teammates: DecisionItem[] = [];
  for (const item of [...decisions, ...fromMail]) {
    if (item.state !== 'open' || item.disposition !== 'blocking') continue;
    const group = askGroup(item);
    if (group === null) continue;
    const key = item.messageId ?? item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isMine(item, me)) {
      teammates.push(item);
      continue;
    }
    const rows = byGroup.get(group) ?? [];
    rows.push(item);
    byGroup.set(group, rows);
  }
  const groups: AskGroupRows[] = [];
  let restored: DecisionItem[] = [];
  for (const group of ASK_GROUP_ORDER) {
    let items = byGroup.get(group);
    if (items === undefined) continue;
    items.sort((a, b) => a.since.localeCompare(b.since));
    if (group === 'knowledge') {
      const lessons = items.filter(
        (i) => i.kind === 'memory' && i.summary.includes(RESTORED)
      );
      // Two or more restored lessons fold into the first one's row.
      if (lessons.length > 1) {
        restored = lessons;
        const rest = new Set(lessons.slice(1));
        items = items.filter((i) => !rest.has(i));
      }
    }
    groups.push({ group, items });
  }
  const asks = groups.flatMap((g) => g.items);
  const byTask = new Map<string, number>();
  for (const ask of asks) {
    if (ask.taskId === undefined) continue;
    byTask.set(ask.taskId, (byTask.get(ask.taskId) ?? 0) + 1);
  }
  return {
    asks,
    groups,
    count: asks.length,
    teammates,
    byTask,
    taskIds: new Set(byTask.keys()),
    restored,
  };
}
