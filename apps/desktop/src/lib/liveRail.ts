import type { RunKind, RunMeta } from '@dispatch/client';

import { isTerminalRunState } from './runState';

/** How a run's kind reads in a list — 'agent' rather than 'execute', since that's what the
 * row is actually doing from a glance. */
export type RunKindLabel = 'agent' | 'review' | 'verify';

export interface LiveRailRow {
  run: RunMeta;
  kindLabel: RunKindLabel;
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
 * The persistent rail's live rows: one per currently-running agent, in `runs`' own order.
 * The attention count that used to be derived here comes from App's own `buildInbox` result
 * now — one derivation for the rail strip, the Inbox page, and the sidebar badge.
 */
export function buildLiveRail(runs: RunMeta[]): LiveRailRow[] {
  return runs
    .filter((run) => !isTerminalRunState(run.state))
    .map((run) => ({ run, kindLabel: runKindLabel(run) }));
}
