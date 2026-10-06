import type { DecisionItem } from './decisionFeed';

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
}

// An item is mine unless it names a different owner; with no known me, every item is.
function isMine(item: DecisionItem, me: string | null): boolean {
  return item.owner === undefined || me === null || item.owner === me;
}

/** The one definition of "needs you": open, blocking asks, one row per gate message. */
export function needsYou(
  decisions: readonly DecisionItem[],
  me: string | null
): NeedsYou {
  const seen = new Set<string>();
  const byGroup = new Map<AskGroup, DecisionItem[]>();
  const teammates: DecisionItem[] = [];
  for (const item of decisions) {
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
  for (const group of ASK_GROUP_ORDER) {
    const items = byGroup.get(group);
    if (items === undefined) continue;
    items.sort((a, b) => a.since.localeCompare(b.since));
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
  };
}
