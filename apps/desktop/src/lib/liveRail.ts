import type { RepoPr, RunKind, RunMeta, RunQuestion } from '@dispatch/client';

import { buildInbox } from './inboxQueue';
import { isTerminalRunState } from './runState';

/** How a run's kind reads in a list — 'agent' rather than 'execute', since that's what the
 * row is actually doing from a glance. */
export type RunKindLabel = 'agent' | 'review' | 'verify';

interface LiveRailRow {
  run: RunMeta;
  kindLabel: RunKindLabel;
}

export interface LiveRailData {
  /** Same count the Inbox page's badge would show — everything waiting on a human. */
  attentionCount: number;
  /** Every non-terminal run, in `runs`' own order, one row each. */
  live: LiveRailRow[];
}

const KIND_LABEL: Record<RunKind, RunKindLabel> = {
  execute: 'agent',
  review: 'review',
  verify: 'verify',
};

/**
 * One run's kind, as a word for a list row. `kind` is absent on every run recorded before it
 * existed, which is why the fallback is `execute` rather than a question mark — those runs
 * were all plain agent dispatches. Shared with All agents so the rail and the history cannot
 * name the same run's kind two different ways.
 */
export function runKindLabel(run: RunMeta): RunKindLabel {
  return KIND_LABEL[run.kind ?? 'execute'];
}

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
    .map((run) => ({ run, kindLabel: runKindLabel(run) }));
  return {
    attentionCount: inbox.review.length + inbox.waiting.length,
    live,
  };
}
