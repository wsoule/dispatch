import type {
  FixLoopState,
  MergeQueueSnapshot,
  RunKind,
  RunMeta,
} from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';

import type { FeedState } from './feedState';
import { deriveFeedState, FEED_STATE_ORDER } from './feedState';
import { deriveRunDisposition } from './runState';

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
  /** What a `waiting` row wants: an approval (answerable from the row) or a question
   * (answerable only in the run). `null` on every other state. */
  waitingOn: 'approval' | 'question' | null;
  /** The task's fix loop, when one exists — the row shows its round/phase and
   * offers Stop while it is actively implementing or reviewing. */
  fixLoop: FixLoopState | null;
}

interface FeedGroupModel {
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
  /** Run id -> the questions its agent is blocked on, oldest first. */
  openQuestions: ReadonlyMap<string, readonly { question: string }[]>;
  /** Task id -> its fix-loop state, for the per-row loop annotations. */
  fixLoops: ReadonlyMap<string, FixLoopState>;
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

/** Absent `kind` predates the field and always meant an execute run. */
function runKindOf(run: RunMeta): RunKind {
  return run.kind ?? 'execute';
}

/**
 * What the review/verify agents working on one execute run add up to.
 *
 * They get their own `RunMeta`, but they are not separate work — a review run
 * exists only to say something about the run it was branched from. As rows of
 * their own they doubled every reviewed task: once under "Working" (the agent)
 * and once under "Needs review" (the run it was reviewing).
 */
interface AuxStatus {
  /** The kind of aux agent currently running, if one is. */
  running: RunKind | null;
  /** The kind of the most recent aux agent that stopped without finishing. */
  failed: RunKind | null;
}

/**
 * Indexes aux runs against the execute run each is about, keyed on the aux
 * run's `baseBranch` — exactly the execute run's `branch`. Task id would pair
 * them too, until a task is dispatched twice and only the branch says which
 * execute run a given review was about.
 */
function auxByExecuteBranch(runs: RunMeta[]): Map<string, AuxStatus> {
  const byBranch = new Map<string, AuxStatus>();
  for (const run of runs) {
    const kind = runKindOf(run);
    if (kind === 'execute') continue;
    const status = byBranch.get(run.baseBranch) ?? {
      running: null,
      failed: null,
    };
    const disposition = deriveRunDisposition(run);
    if (disposition === 'live') {
      status.running = kind;
    } else if (disposition === 'stopped-short' || disposition === 'dead') {
      status.failed = kind;
    }
    byBranch.set(run.baseBranch, status);
  }
  return byBranch;
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
    const asked = openQuestions.get(run.id) ?? [];
    if (asked.length > 0) {
      return {
        reason:
          asked.length === 1
            ? 'Asked you a question'
            : `Asked you ${asked.length} questions`,
        detail: asked[0].question,
      };
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
    fixLoops,
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

  const auxByBranch = auxByExecuteBranch(runs);
  // An aux run is only folded away when the execute run it is about is actually
  // in the feed to fold it into. One whose execute run has been reviewed and
  // closed out (or never existed) still gets a row of its own — silently
  // dropping a live agent because its subject is gone is how a wedged review
  // agent becomes invisible.
  const foldedInto = new Set(
    runs
      .filter((r) => runKindOf(r) === 'execute' && auxByBranch.has(r.branch))
      .map((r) => r.branch)
  );

  // Every run that still has a place in the feed, with its state resolved once. `createdAt`
  // and the kind travel alongside for the superseded-run pass below.
  const entries: {
    row: FeedRowModel;
    createdAt: string;
    isExecute: boolean;
  }[] = [];
  for (const run of runs) {
    if (runKindOf(run) !== 'execute' && foldedInto.has(run.baseBranch))
      continue;
    const derived = deriveFeedState(run, queueByRunId.get(run.id));
    if (derived === null) continue;
    // A run blocked on a question still reads as 'running' in its own metadata, so without
    // this it would sit in the calm part of the feed looking busy.
    const asked = openQuestions.get(run.id) ?? [];
    const withQuestions =
      derived === 'working' && asked.length > 0 ? 'waiting' : derived;

    // Only 'review' is reinterpreted by an aux agent: that is the state an
    // execute run sits in for exactly as long as review and verify agents have
    // something to say about it. A run that is waiting on approval, failed, or
    // in the merge queue is being described by something more urgent already.
    const aux = auxByBranch.get(run.branch);
    const auxRunning =
      withQuestions === 'review' ? (aux?.running ?? null) : null;
    const auxFailed = withQuestions === 'review' ? (aux?.failed ?? null) : null;
    // While an AI agent is mid-flight the row belongs with the things that are
    // moving, not with the things asking for a human — its findings are not in
    // yet, so there is nothing to review.
    const state: FeedState = auxRunning !== null ? 'working' : withQuestions;

    const task = taskById.get(run.taskId);
    const parentId = task?.meta.parent ?? null;
    const activity =
      auxRunning !== null
        ? `AI ${auxRunning} running`
        : state === 'review'
          ? reviewActivity(run)
          : state === 'landing'
            ? (queuePhaseByRunId.get(run.id) ?? null)
            : null;

    entries.push({
      createdAt: run.createdAt,
      isExecute: runKindOf(run) === 'execute',
      row: {
        runId: run.id,
        taskId: run.taskId,
        title: run.taskTitle,
        state,
        epicTitle:
          parentId === null ? null : (epicTitleById.get(parentId) ?? null),
        since: run.updatedAt,
        activity,
        // A dead review agent leaves its execute run looking like an ordinary
        // "needs review" forever, with nothing anywhere saying the findings the
        // user is waiting on are never coming.
        attention:
          auxFailed !== null
            ? { reason: `The AI ${auxFailed} agent failed`, detail: null }
            : attentionFor(state, run, pendingApprovals, openQuestions),
        waitingOn:
          state !== 'waiting'
            ? null
            : asked.length > 0
              ? 'question'
              : 'approval',
        fixLoop: fixLoops.get(run.taskId) ?? null,
      },
    });
  }

  // A task the fix loop (or a manual re-dispatch) has run several times leaves a run per
  // round — execute rounds still reading 'review', and unfoldable review/verify agents
  // (their execute run merged away or healed as a zombie) each reading 'review' or 'failed'
  // on their own — stacking near-identical rows for one task. Among a task's settled rows
  // (review/failed, any run kind) only the newest speaks for it: the latest event is the
  // task's current state, the rest are history, not work waiting on anyone. Live rows
  // (working/waiting) and queue-backed rows (landing) always survive.
  const settled = (entry: (typeof entries)[number]): boolean =>
    entry.row.state === 'review' || entry.row.state === 'failed';
  const latestSettledByTask = new Map<string, string>();
  for (const entry of entries) {
    if (!settled(entry)) continue;
    const seen = latestSettledByTask.get(entry.row.taskId);
    if (seen === undefined || entry.createdAt > seen) {
      latestSettledByTask.set(entry.row.taskId, entry.createdAt);
    }
  }
  const rows: FeedRowModel[] = entries
    .filter(
      (entry) =>
        !settled(entry) ||
        entry.createdAt === latestSettledByTask.get(entry.row.taskId)
    )
    .map((entry) => entry.row);

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
