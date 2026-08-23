import type {
  FixLoopState,
  MergeQueueSnapshot,
  RepoPr,
  RunMeta,
  RunQuestion,
} from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';

import type { FeedRowModel } from './controlRoom';
import { buildFeed, FEED_GROUPS } from './controlRoom';
import type { FeedState } from './feedState';
import { isUrgentState } from './feedState';

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
  pendingApprovals: ReadonlyMap<string, { toolName: string }>;
  openQuestions: ReadonlyMap<string, RunQuestion[]>;
  fixLoops: ReadonlyMap<string, FixLoopState>;
}

export interface InboxSection {
  state: FeedState;
  rows: FeedRowModel[];
}

export interface InboxData {
  /** One section per urgent move (answer/approve/review/ruling/unblock/failed), in the
   * feed's own priority order, empty sections dropped. One row per task, never per run. */
  sections: InboxSection[];
  /** Open repo PRs no local run claims — reviewable, but only on GitHub. */
  prs: RepoPr[];
  /** Rows across sections plus unclaimed PRs — the sidebar badge. */
  total: number;
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
    fixLoops: input.fixLoops,
    query: '',
    activeStates: new Set(),
    collapsed: new Set(),
    // No caps: an inbox that silently truncates its list isn't an inbox.
    expanded: new Set(FEED_GROUPS),
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

  return {
    sections,
    prs,
    total:
      sections.reduce((count, section) => count + section.rows.length, 0) +
      prs.length,
  };
}
