import type { EpicProgress, RunKind, RunMeta } from '@dispatch/client';

import { isTerminalRunState } from './runState';

/** How a run's kind reads in a list — 'agent' rather than 'execute', since that's what the
 * row is actually doing from a glance. */
export type RunKindLabel = 'agent' | 'review' | 'verify';

interface LiveRailRow {
  run: RunMeta;
  kindLabel: RunKindLabel;
}

/** The live rows under one milestone with a fan-out session, in `runs`' own order. */
interface LiveRailGroup {
  progress: EpicProgress;
  rows: LiveRailRow[];
}

export interface LiveRailModel {
  /** One per session that has at least one live row, in `sessions`' order. */
  groups: LiveRailGroup[];
  /** The live rows outside every session — the flat tail under the groups. */
  rows: LiveRailRow[];
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
 * A run on a child of a milestone with a session joins that milestone's group; every other
 * live run stays in the flat `rows` tail. A session with nothing live is left out entirely
 * — the rail shows agents at work, not idle milestones. The attention count that used to be
 * derived here comes from App's own `buildInbox` result now — one derivation for the rail
 * strip, the Inbox page, and the sidebar badge.
 */
export function buildLiveRail(
  runs: RunMeta[],
  sessions: EpicProgress[] = []
): LiveRailModel {
  const live = runs
    .filter((run) => !isTerminalRunState(run.state))
    .map((run) => ({ run, kindLabel: runKindLabel(run) }));

  // First session to claim a task wins — a task belongs to one epic, so the
  // only overlap possible is two progress entries for the same epic.
  const groupByTaskId = new Map<string, LiveRailGroup>();
  const groups: LiveRailGroup[] = [];
  for (const progress of sessions) {
    const group: LiveRailGroup = { progress, rows: [] };
    groups.push(group);
    for (const child of progress.children) {
      if (!groupByTaskId.has(child.id)) groupByTaskId.set(child.id, group);
    }
  }

  const rows: LiveRailRow[] = [];
  for (const row of live) {
    const group = groupByTaskId.get(row.run.taskId);
    if (group === undefined) rows.push(row);
    else group.rows.push(row);
  }

  return { groups: groups.filter((group) => group.rows.length > 0), rows };
}
