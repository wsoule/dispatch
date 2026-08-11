import type { RepoPr, RunKind, RunMeta, RunQuestion } from '@dispatch/client';

import { buildInbox } from './inboxQueue';
import { isTerminalRunState } from './runState';

/** How a live run's kind reads on the rail — 'agent' rather than 'execute',
 * since that's what the row is actually doing from a glance. */
type LiveRailKindLabel = 'agent' | 'review' | 'verify';

interface LiveRailRow {
  run: RunMeta;
  kindLabel: LiveRailKindLabel;
}

export interface LiveRailData {
  /** Same count the Inbox page's badge would show — everything waiting on a human. */
  attentionCount: number;
  /** Every non-terminal run, in `runs`' own order, one row each. */
  live: LiveRailRow[];
}

const KIND_LABEL: Record<RunKind, LiveRailKindLabel> = {
  execute: 'agent',
  review: 'review',
  verify: 'verify',
};

/**
 * Derives the persistent rail's contents: the attention strip's count (via
 * `buildInbox`, the same source the Inbox page reads) and one row per
 * currently-running agent, regardless of what needs a human. Unlike the old
 * `MiniOverview`, this never goes empty while an agent is live — only the
 * attention strip appears and disappears.
 */
export function buildLiveRail(
  runs: RunMeta[],
  repoPrs: RepoPr[],
  openQuestions: ReadonlyMap<string, RunQuestion[]>
): LiveRailData {
  const inbox = buildInbox(runs, repoPrs, openQuestions);
  const live = runs
    .filter((run) => !isTerminalRunState(run.state))
    .map((run) => ({ run, kindLabel: KIND_LABEL[run.kind ?? 'execute'] }));
  return {
    attentionCount: inbox.review.length + inbox.waiting.length,
    live,
  };
}
