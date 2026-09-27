import type {
  FixLoopState,
  MergeQueueSnapshot,
  RepoPr,
  RunMeta,
} from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';

import type { TaskSpec } from '../components/tasks/TaskSpecView';
import type { FeedRowModel } from './controlRoom';
import { buildFeed } from './controlRoom';
import type { FeedState } from './feedState';
import { FEED_STATE_LABEL, isUrgentState } from './feedState';
import type { RunQuestion } from './gates';
import type { InboxEntry } from './inbox';
import { parseTaskSections } from './taskDisplay';

/** Everything `buildFeed` needs that the Inbox actually varies on — the Inbox is the
 * Control room's urgent tiers re-surfaced as a to-do list, so it feeds the exact same
 * derivation rather than keeping a second set of "what needs a human" rules that drift
 * (the old rules missed failed runs without sessions, rulings, and held merges entirely,
 * and stacked one row per run instead of one per task). */
export interface InboxInput {
  runs: RunMeta[];
  tasks: TaskDoc[];
  epics: TaskDoc[];
  repoPrs: RepoPr[];
  mergeQueue: MergeQueueSnapshot | null;
  pendingApprovals: ReadonlyMap<string, readonly { toolName: string }[]>;
  openQuestions: ReadonlyMap<string, RunQuestion[]>;
  openScopeRequests: ReadonlyMap<string, { paths: readonly string[] }>;
  fixLoops: ReadonlyMap<string, FixLoopState>;
  /** This window's ActorRef. When set, asks on runs someone else dispatched are
   * that person's to answer: still listed, under Teammates, but not in Needs you
   * and not in the badge. Absent means everything is yours — a solo project. */
  me?: string | null;
}

interface InboxSection {
  state: FeedState;
  rows: FeedRowModel[];
}

export interface InboxData {
  /** One section per urgent move (answer/approve/review/ruling/unblock/failed), in the
   * feed's own priority order, empty sections dropped. One row per task, never per run. */
  sections: InboxSection[];
  /** Reviewed, finished runs whose work still hasn't landed: not queued, no open PR, task
   * not yet landed/dropped. The remaining human move is queueing the merge, so they belong
   * in the inbox rather than only on the Landing page. Newest run per task. */
  readyToLand: FeedRowModel[];
  /** Open repo PRs no local run claims — reviewable, but only on GitHub. */
  prs: RepoPr[];
  /** Rows across sections, ready-to-land, and unclaimed PRs — the sidebar badge.
   * Excludes rows a teammate owns: their parked approval is theirs to answer. */
  total: number;
  /** runId → the teammate who dispatched it, for runs that are not yours.
   * `buildInbox` always sets it; optional only so hand-built InboxData literals
   * (test fixtures) predating it stay valid, the same rule config blocks use. */
  teammateOwners?: ReadonlyMap<string, string>;
}

/**
 * Everything waiting on a human. A thin filter over `buildFeed` — the one place the
 * whose-move states, question overrides, merge-queue phases, aux-agent folding, and
 * superseded-round dedupe live — keeping this page and the Control room incapable of
 * disagreeing about what needs you.
 */
export function buildInbox(input: InboxInput): InboxData {
  const feed = buildFeed({
    runs: input.runs,
    tasks: input.tasks,
    epics: input.epics,
    // Ready/blocked only affect ribbon counts the Inbox never shows.
    readyIds: new Set(),
    blockedIds: new Set(),
    mergeQueue: input.mergeQueue,
    pendingApprovals: input.pendingApprovals,
    openQuestions: input.openQuestions,
    openScopeRequests: input.openScopeRequests,
    fixLoops: input.fixLoops,
    query: '',
    activeStates: new Set(),
    collapsed: new Set(),
  });

  const sections = feed.groups
    .filter((group) => isUrgentState(group.state))
    .map((group) => ({ state: group.state, rows: group.rows }));

  const claimedUrls = new Set(
    input.runs
      .map((run) => run.prUrl)
      .filter((url): url is string => url !== undefined)
  );
  const prs = input.repoPrs.filter((pr) => !claimedUrls.has(pr.url));

  const readyToLand = collectReadyToLand(input);

  // The "whose attention" axis. A run someone else dispatched is theirs to
  // answer for: its asks stay visible, the way a recorded gate stays in the
  // ledger, but they stop demanding anything of you.
  const me = input.me ?? null;
  const teammateOwners = new Map<string, string>();
  if (me !== null) {
    for (const run of input.runs) {
      if (run.dispatchedBy !== undefined && run.dispatchedBy !== me) {
        teammateOwners.set(run.id, run.dispatchedBy);
      }
    }
  }
  const mine = (row: FeedRowModel) => !teammateOwners.has(row.runId);

  return {
    sections,
    readyToLand,
    prs,
    total:
      sections.reduce(
        (count, section) => count + section.rows.filter(mine).length,
        0
      ) +
      readyToLand.filter(mine).length +
      prs.length,
    teammateOwners,
  };
}

/** See `InboxData.readyToLand`. Reviewed runs leave `buildFeed` entirely (their review ask
 * is answered), so this set is collected directly: the newest reviewed-but-unlanded run per
 * task, in reviewed-order newest first. A run already in the merge queue is the queue's to
 * report (the feed's landing/unblock states), and a run with an open PR lands via GitHub. */
function collectReadyToLand(input: InboxInput): FeedRowModel[] {
  const queuedRunIds = new Set(
    (input.mergeQueue?.entries ?? []).map((entry) => entry.runId)
  );
  const taskById = new Map(input.tasks.map((t) => [t.meta.id, t]));
  const epicTitleById = new Map(
    input.epics.map((e) => [e.meta.id, e.meta.title])
  );

  const newestByTask = new Map<string, (typeof input.runs)[number]>();
  for (const run of input.runs) {
    if ((run.kind ?? 'execute') !== 'execute') continue;
    if (run.archivedAt !== undefined) continue;
    if (run.state !== 'finished' || run.reviewedAt === undefined) continue;
    if (run.prUrl !== undefined) continue;
    if (queuedRunIds.has(run.id)) continue;
    const task = taskById.get(run.taskId);
    const status = task?.meta.status;
    if (status === 'landed' || status === 'dropped') continue;
    const seen = newestByTask.get(run.taskId);
    if (seen === undefined || run.createdAt > seen.createdAt) {
      newestByTask.set(run.taskId, run);
    }
  }

  return [...newestByTask.values()]
    .sort((a, b) =>
      (b.reviewedAt ?? b.updatedAt).localeCompare(a.reviewedAt ?? a.updatedAt)
    )
    .map((run) => {
      const task = taskById.get(run.taskId);
      const parentId = task?.meta.parent ?? null;
      return {
        runId: run.id,
        taskId: run.taskId,
        title: run.taskTitle,
        state: 'landing' as const,
        epicTitle:
          parentId === null ? null : (epicTitleById.get(parentId) ?? null),
        priority: task?.meta.priority ?? null,
        since: run.reviewedAt ?? run.updatedAt,
        activity: 'Reviewed, not landed',
        attention: null,
        fixLoop: null,
      };
    });
}

/**
 * One row of the Inbox list. The live queue (`buildInbox`) and the persisted notification
 * record (`lib/inbox.ts`) are two different things — an ask is still open, a notification
 * already happened — but Linear's inbox shows both in one list, so they meet here as one
 * item shape the list can render, filter, group and mark read without caring which it has.
 */
export type InboxItem =
  | { kind: 'ask'; key: string; ts: string; row: FeedRowModel; owner?: string }
  | {
      kind: 'landing';
      key: string;
      ts: string;
      row: FeedRowModel;
      owner?: string;
    }
  | { kind: 'pr'; key: string; ts: string; pr: RepoPr }
  | { kind: 'notification'; key: string; ts: string; entry: InboxEntry };

/** The list-pane filter: everything, only what is still waiting on you, or only what
 * already happened. */
export type InboxFilter = 'all' | 'needs-you' | 'teammates' | 'earlier';

export const INBOX_FILTER_LABEL: Record<InboxFilter, string> = {
  all: 'All',
  'needs-you': 'Needs you',
  teammates: 'Teammates',
  earlier: 'Earlier',
};

// A live row's read key carries its state, so a task that moves from review to failed
// comes back unread — the same task, a new thing to look at.
function rowKey(row: FeedRowModel): string {
  return `${row.state}:${row.taskId}:${row.runId}`;
}

// Spread into an ask or landing item: `{ owner }` when a teammate owns its run,
// nothing otherwise, so a solo project's items keep exactly their old shape.
function ownerOf(data: InboxData, row: FeedRowModel): { owner?: string } {
  const owner = data.teammateOwners?.get(row.runId);
  return owner === undefined ? {} : { owner };
}

/** The teammate an item belongs to, or undefined when it is yours (or no one's). */
export function teammateOf(item: InboxItem): string | undefined {
  return item.kind === 'ask' || item.kind === 'landing'
    ? item.owner
    : undefined;
}

/** Flattens the inbox into list items: asks in the feed's priority order, then ready-to-land,
 * then unclaimed PRs, then the notification record newest first. */
export function buildInboxItems(
  data: InboxData,
  entries: readonly InboxEntry[]
): InboxItem[] {
  const items: InboxItem[] = [];
  for (const section of data.sections) {
    for (const row of section.rows) {
      items.push({
        kind: 'ask',
        key: rowKey(row),
        ts: row.since,
        row,
        ...ownerOf(data, row),
      });
    }
  }
  for (const row of data.readyToLand) {
    items.push({
      kind: 'landing',
      key: rowKey(row),
      ts: row.since,
      row,
      ...ownerOf(data, row),
    });
  }
  for (const pr of data.prs) {
    items.push({ kind: 'pr', key: `pr:${pr.number}`, ts: pr.updatedAt, pr });
  }
  for (const entry of entries) {
    items.push({
      kind: 'notification',
      key: `notification:${entry.id}`,
      ts: entry.ts,
      entry,
    });
  }
  return items;
}

export function filterInboxItems(
  items: readonly InboxItem[],
  filter: InboxFilter
): InboxItem[] {
  if (filter === 'all') return [...items];
  if (filter === 'needs-you') {
    return items.filter(
      (item) => item.kind !== 'notification' && teammateOf(item) === undefined
    );
  }
  if (filter === 'teammates') {
    return items.filter((item) => teammateOf(item) !== undefined);
  }
  return items.filter((item) => item.kind === 'notification');
}

/** An item is read once its key has been seen (`readIds`, persisted per project by the
 * view); a notification is also read when its own record says so (mark-all, or opened
 * from another surface). */
export function isInboxItemRead(
  item: InboxItem,
  readIds: ReadonlySet<string>
): boolean {
  if (item.kind === 'notification' && item.entry.read) return true;
  return readIds.has(item.key);
}

export function unreadInboxCount(
  items: readonly InboxItem[],
  readIds: ReadonlySet<string>
): number {
  return items.reduce(
    (count, item) => (isInboxItemRead(item, readIds) ? count : count + 1),
    0
  );
}

/** `readIds` with every live item's key added; the notification half is marked read through
 * `NotificationInbox.markAllRead`. Returns the same set when nothing changes. */
export function markAllItemsRead(
  items: readonly InboxItem[],
  readIds: ReadonlySet<string>
): ReadonlySet<string> {
  const next = new Set(readIds);
  for (const item of items) {
    if (item.kind !== 'notification') next.add(item.key);
  }
  return next.size === readIds.size ? readIds : next;
}

export interface InboxGroup {
  id: string;
  label: string;
  /** The state the group header's glyph and tint read from; `null` for the record. */
  state: FeedState | null;
  items: InboxItem[];
}

/** The "group by kind" display: one group per ask state (feed order), then Ready to land,
 * Pull requests and Earlier. Empty groups are dropped. */
export function groupInboxItems(items: readonly InboxItem[]): InboxGroup[] {
  const byId = new Map<string, InboxGroup>();
  const ensure = (id: string, label: string, state: FeedState | null) => {
    let group = byId.get(id);
    if (group === undefined) {
      group = { id, label, state, items: [] };
      byId.set(id, group);
    }
    return group;
  };
  for (const item of items) {
    switch (item.kind) {
      case 'ask':
        ensure(
          item.row.state,
          FEED_STATE_LABEL[item.row.state],
          item.row.state
        ).items.push(item);
        break;
      case 'landing':
        ensure('landing', 'Ready to land', 'landing').items.push(item);
        break;
      case 'pr':
        ensure('pr', 'Pull requests', 'review').items.push(item);
        break;
      case 'notification':
        ensure('earlier', 'Earlier', null).items.push(item);
        break;
    }
  }
  return [...byId.values()];
}

/** The tiny action badge on the row's avatar. */
export type InboxBadge =
  | 'check'
  | 'hand'
  | 'merge'
  | 'mention'
  | 'alert'
  | 'pr';

/** What the row's 12px badge and 14px state glyph say about an item: the badge names the
 * action, the state names whose move it is. */
export function inboxItemBadge(item: InboxItem): InboxBadge {
  switch (item.kind) {
    case 'ask':
      switch (item.row.state) {
        case 'answer':
          return 'mention';
        case 'approve':
          return 'hand';
        case 'unblock':
        case 'failed':
          return 'alert';
        default:
          return 'check';
      }
    case 'landing':
      return 'merge';
    case 'pr':
      return 'pr';
    case 'notification':
      return notificationBadge(item.entry);
  }
}

// The persisted record has no state of its own; it is read back off the title
// `notificationEdges.ts` wrote, which is the one field every edge sets.
function notificationBadge(entry: InboxEntry): InboxBadge {
  const title = entry.title.toLowerCase();
  if (title.startsWith('merged')) return 'merge';
  if (title.includes('failed') || title.includes('blocked')) return 'alert';
  if (title.includes('answer')) return 'mention';
  return 'check';
}

export function inboxItemState(item: InboxItem): FeedState {
  switch (item.kind) {
    case 'ask':
      return item.row.state;
    case 'landing':
      return 'landing';
    case 'pr':
      return 'review';
    case 'notification': {
      const title = item.entry.title.toLowerCase();
      if (title.startsWith('merged')) return 'landing';
      if (title.includes('blocked')) return 'unblock';
      if (title.includes('failed')) return 'failed';
      if (title.includes('answer')) return 'answer';
      return 'review';
    }
  }
}

/** Whose avatar sits on the row: the agent for run work, the queue for merge outcomes, the
 * planner for its questions, the PR's author for a PR. */
export function inboxItemActor(item: InboxItem): string {
  switch (item.kind) {
    case 'ask':
    case 'landing':
      return 'Agent';
    case 'pr':
      return item.pr.author;
    case 'notification':
      switch (item.entry.target.kind) {
        case 'queue':
        case 'runs-page':
          return 'Merge queue';
        case 'draft':
        case 'plan':
          return 'Planner';
        case 'run':
          return 'Agent';
        case 'task':
          return 'Dispatch';
      }
  }
}

/** The row's title line and the 12px line under it. */
export function inboxItemText(item: InboxItem): {
  id: string | null;
  title: string;
  subtitle: string;
} {
  switch (item.kind) {
    case 'ask': {
      const reason = item.row.attention?.reason ?? item.row.activity;
      const label = FEED_STATE_LABEL[item.row.state];
      return {
        id: item.row.taskId,
        title: item.row.title,
        subtitle: reason === null ? label : `${label} · ${reason}`,
      };
    }
    case 'landing':
      return {
        id: item.row.taskId,
        title: item.row.title,
        subtitle: item.row.activity ?? 'Reviewed, not landed',
      };
    case 'pr':
      return {
        id: `#${item.pr.number}`,
        title: item.pr.title,
        subtitle: `Pull request by ${item.pr.author}`,
      };
    case 'notification':
      return { id: null, title: item.entry.title, subtitle: item.entry.body };
  }
}

// Read state for live items persists beside the notification record, one key per project.
function readIdsKey(root: string): string {
  return `dispatch:inbox-read:${root}`;
}

export function loadReadIds(
  root: string,
  storage: Pick<Storage, 'getItem'>
): ReadonlySet<string> {
  try {
    const raw = storage.getItem(readIdsKey(root));
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((v): v is string => typeof v === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

/** Keys of live items no longer in the list are dropped on save so the set cannot grow
 * without bound; a row that comes back with the same key is new work anyway. */
export function saveReadIds(
  root: string,
  readIds: ReadonlySet<string>,
  liveKeys: ReadonlySet<string>,
  storage: Pick<Storage, 'setItem'>
): void {
  try {
    const kept = [...readIds].filter((key) => liveKeys.has(key));
    storage.setItem(readIdsKey(root), JSON.stringify(kept));
  } catch (err) {
    console.warn('dispatch: failed to persist inbox read state', err);
  }
}

/** Projects a `TaskDoc` onto the spec shape: description and acceptance criteria come out
 * of the body's `##` sections, blockers resolve to titles through `tasks`. */
export function specForTask(doc: TaskDoc, tasks: readonly TaskDoc[]): TaskSpec {
  const sections = parseTaskSections(doc.body);
  const titleById = new Map(tasks.map((t) => [t.meta.id, t.meta.title]));
  const criteria = (sections.get('Acceptance Criteria') ?? '')
    .split('\n')
    .map((line) =>
      line.replace(/^\s*(?:[-*]|\d+\.)\s*(?:\[[ xX]\]\s*)?/, '').trim()
    )
    .filter((line) => line !== '');
  return {
    title: doc.meta.title,
    status: doc.meta.status,
    priority: doc.meta.priority,
    description: sections.get('Description') ?? '',
    acceptanceCriteria: criteria,
    writes: doc.meta.writes,
    risk: doc.meta.risk,
    blockedBy: doc.meta.blockedBy.map((id) => ({
      key: id,
      title: titleById.get(id) ?? id,
    })),
  };
}
