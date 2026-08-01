import type { MergeQueueSnapshot, RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';

import type { FeedState } from './feedState';
import { deriveFeedState, FEED_STATE_ORDER } from './feedState';

/**
 * The Control room's read model, derived here rather than in JSX so the grouping, capping and
 * filtering rules are testable without mounting React — the same "dumb view, smart derivation"
 * split lib/appNav.ts uses for routing.
 */

/** The five run-backed groups the feed renders, in priority order. Ready and blocked are
 * counted in the ribbon but deliberately not fed: a task nobody has dispatched is not an event,
 * and mixing 40 ready tasks into a feed of live agents buries the six rows that matter. */
export const FEED_GROUPS: readonly FeedState[] = [
  'waiting',
  'failed',
  'working',
  'review',
  'landing',
];

/** How many rows a group shows before collapsing the rest behind a "show the other N" row.
 * Working gets more room because it is the group that legitimately runs long. */
const GROUP_CAP: Partial<Record<FeedState, number>> = { working: 7 };
const DEFAULT_CAP = 5;

export function groupCap(state: FeedState): number {
  return GROUP_CAP[state] ?? DEFAULT_CAP;
}

export interface FeedRowModel {
  runId: string;
  taskId: string;
  title: string;
  state: FeedState;
  /** The owning epic's title, when the task has one. */
  epicTitle: string | null;
  /** ISO timestamp the elapsed column counts from. */
  since: string;
  /**
   * The one-line summary in the activity column. What it says depends on the state — what the
   * agent is doing, a review's diff totals, which queue phase is running.
   */
  activity: string | null;
  /**
   * The second line urgent rows carry: the actual thing standing in the way. `null` on calm
   * rows. `detail` is the tool or command involved, when we know it.
   */
  attention: { reason: string; detail: string | null } | null;
  /**
   * What a `waiting` row is waiting on, since the two need different actions: an approval can
   * be answered from the row itself, a question has to be answered in the run. `null` on every
   * other state.
   */
  waitingOn: 'approval' | 'question' | null;
}

export interface FeedGroupModel {
  state: FeedState;
  /** Rows matching the current filter, before the cap. */
  total: number;
  /** The rows actually rendered. */
  rows: FeedRowModel[];
  /** How many the cap is holding back — 0 when everything is shown. */
  hidden: number;
  collapsed: boolean;
}

export interface FeedModel {
  groups: FeedGroupModel[];
  /** Rows rendered right now, across every group. */
  shown: number;
  /** Rows in the feed before any filtering — the denominator in "12 of 48 shown". */
  total: number;
  /** Per-state totals for the ribbon and the filter chips. Unfiltered, always. */
  counts: Record<FeedState, number>;
}

export interface BuildFeedInput {
  runs: RunMeta[];
  tasks: TaskDoc[];
  epics: TaskDoc[];
  readyIds: ReadonlySet<string>;
  blockedIds: ReadonlySet<string>;
  mergeQueue: MergeQueueSnapshot | null;
  /** Run id -> the tool name a run is paused on, when this window saw the request. */
  pendingApprovals: ReadonlyMap<string, { toolName: string }>;
  /** Run id -> the question its agent is blocked on, for runs waiting on an answer. */
  openQuestions: ReadonlyMap<string, { question: string }>;
  query: string;
  /** Empty means "no chip selected", which shows everything rather than nothing. */
  activeStates: ReadonlySet<FeedState>;
  collapsed: ReadonlySet<FeedState>;
  /** Groups the user asked to show in full, overriding the cap. */
  expanded: ReadonlySet<FeedState>;
}

/** Diff-style summary for a run awaiting review — what a reviewer wants before opening it. */
function reviewActivity(run: RunMeta): string | null {
  const turns = run.turns;
  if (turns === undefined) return null;
  return `${turns} ${turns === 1 ? 'turn' : 'turns'}`;
}

/**
 * Why a row needs a human, in the row itself.
 *
 * The point of this line is acting without opening anything, so it has to be specific. Where we
 * genuinely don't know the specifics we say less rather than inventing them: an approval's
 * actual command lives in the run's log, which the feed doesn't load, so a waiting row names
 * the tool and stops. A fabricated `$ command` would read as fact.
 */
function attentionFor(
  state: FeedState,
  run: RunMeta,
  pendingApprovals: BuildFeedInput['pendingApprovals'],
  openQuestions: BuildFeedInput['openQuestions']
): FeedRowModel['attention'] {
  if (state === 'waiting') {
    const asked = openQuestions.get(run.id);
    if (asked !== undefined) {
      return { reason: 'Asked you a question', detail: asked.question };
    }
    const pending = pendingApprovals.get(run.id);
    return {
      reason: pending
        ? `Wants to run ${pending.toolName}`
        : 'Waiting for your approval',
      detail: null,
    };
  }
  if (state === 'failed') {
    return { reason: run.error ?? 'Stopped without finishing', detail: null };
  }
  return null;
}

export function buildFeed(input: BuildFeedInput): FeedModel {
  const {
    runs,
    tasks,
    epics,
    readyIds,
    blockedIds,
    mergeQueue,
    pendingApprovals,
    openQuestions,
    query,
    activeStates,
    collapsed,
    expanded,
  } = input;

  const epicTitleById = new Map(epics.map((e) => [e.meta.id, e.meta.title]));
  const taskById = new Map(tasks.map((t) => [t.meta.id, t]));
  const queueByRunId = new Map(
    (mergeQueue?.entries ?? []).map((e) => [e.runId, e])
  );
  const queuePhaseByRunId = new Map(
    (mergeQueue?.entries ?? []).map((e) => [e.runId, e.state])
  );

  // Every run that still has a place in the feed, with its state resolved once.
  const rows: FeedRowModel[] = [];
  for (const run of runs) {
    const derived = deriveFeedState(run, queueByRunId.get(run.id));
    if (derived === null) continue;
    // A run blocked on an unanswered question is still 'running' as far as its own metadata
    // goes, so it would otherwise sit in the calm part of the feed looking busy. Same
    // reasoning as an approval gate: nothing moves until a human acts.
    const state =
      derived === 'working' && openQuestions.has(run.id) ? 'waiting' : derived;

    const task = taskById.get(run.taskId);
    const parentId = task?.meta.parent ?? null;
    const activity =
      state === 'review'
        ? reviewActivity(run)
        : state === 'landing'
          ? (queuePhaseByRunId.get(run.id) ?? null)
          : null;

    rows.push({
      runId: run.id,
      taskId: run.taskId,
      title: run.taskTitle,
      state,
      epicTitle:
        parentId === null ? null : (epicTitleById.get(parentId) ?? null),
      since: run.updatedAt,
      activity,
      attention: attentionFor(state, run, pendingApprovals, openQuestions),
      waitingOn:
        state !== 'waiting'
          ? null
          : openQuestions.has(run.id)
            ? 'question'
            : 'approval',
    });
  }

  // Ribbon counts are over everything, never the filtered set — a chip that hid rows and then
  // reported a smaller count than the chip beside it would be unreadable.
  const counts = Object.fromEntries(
    FEED_STATE_ORDER.map((s) => [s, 0])
  ) as Record<FeedState, number>;
  for (const row of rows) counts[row.state] += 1;
  counts.ready = readyIds.size;
  counts.blocked = blockedIds.size;

  const needle = query.trim().toLowerCase();
  const matches = (row: FeedRowModel): boolean => {
    if (activeStates.size > 0 && !activeStates.has(row.state)) return false;
    if (needle === '') return true;
    // One field, three haystacks: "worktree", "t-9f2a41" and "Runtime" should all work without
    // the user picking a search mode first.
    return `${row.title} ${row.taskId} ${row.epicTitle ?? ''}`
      .toLowerCase()
      .includes(needle);
  };

  const groups: FeedGroupModel[] = [];
  let shown = 0;
  for (const state of FEED_GROUPS) {
    const groupRows = rows.filter((r) => r.state === state && matches(r));
    if (groupRows.length === 0) continue;

    const isCollapsed = collapsed.has(state);
    const cap = expanded.has(state) ? groupRows.length : groupCap(state);
    const visible = isCollapsed ? [] : groupRows.slice(0, cap);
    shown += visible.length;
    groups.push({
      state,
      total: groupRows.length,
      rows: visible,
      hidden: isCollapsed ? 0 : groupRows.length - visible.length,
      collapsed: isCollapsed,
    });
  }

  return { groups, shown, total: rows.length, counts };
}
