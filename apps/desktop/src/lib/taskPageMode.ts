import type { RunMeta } from '@dispatch/client';
import type { StatusType } from '@dispatch/core/browser';

import { deriveRunDisposition, isTerminalRunState } from './runState';

/**
 * What the task page's main pane shows:
 * - `spec`: what the task is and whether it can go (description, criteria, dispatch).
 * - `run`: an agent's transcript, live or finished, with the steer box.
 * - `review`: a finished run's diff beside the acceptance criteria.
 * - `summary`: what landed, and how it got there.
 * - `plan`: a container's children and how they fan out.
 */
export type TaskPageMode = 'spec' | 'run' | 'review' | 'summary' | 'plan';

/** A task's runs of every kind, newest first: what Run mode's picker lists. */
export function runsNewestFirst(runs: readonly RunMeta[]): RunMeta[] {
  return [...runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function isExecuteRun(run: RunMeta): boolean {
  return (run.kind ?? 'execute') === 'execute';
}

/** Runs an agent did the task's work in; review and verify runs ride alongside them. */
export function executeRuns(runs: readonly RunMeta[]): RunMeta[] {
  return runsNewestFirst(runs.filter(isExecuteRun));
}

/**
 * The run Review mode judges: the picked run when it did the work; for a picked review or
 * verify run, the work it checked (the run whose branch it started from), else the newest.
 */
export function reviewedRun(
  selected: RunMeta | undefined,
  runs: readonly RunMeta[]
): RunMeta | undefined {
  if (selected === undefined || isExecuteRun(selected)) return selected;
  return runs.find((r) => r.branch === selected.baseBranch) ?? runs[0];
}

export interface TaskStateInput {
  statusType: StatusType;
  isContainer: boolean;
  /** The task's newest execute run. */
  latestRun: RunMeta | undefined;
}

/**
 * The mode a task opens in, following its state: done work shows its summary, a container
 * its plan, a task not yet started (or reopened) its spec, a live run its transcript, a
 * finished run its review. A failed run opens on its transcript, which says why.
 */
export function defaultTaskPageMode({
  statusType,
  isContainer,
  latestRun,
}: TaskStateInput): TaskPageMode {
  if (statusType === 'completed' || statusType === 'canceled') return 'summary';
  if (isContainer) return 'plan';
  // Triage, backlog or unstarted: old runs are history; only a live one outranks the spec.
  if (statusType !== 'started') {
    return latestRun !== undefined && !isTerminalRunState(latestRun.state)
      ? 'run'
      : 'spec';
  }
  if (latestRun === undefined) return 'spec';
  switch (deriveRunDisposition(latestRun)) {
    case 'live':
    case 'stopped-short':
    case 'dead':
      return 'run';
    case 'needs-review':
    case 'in-review-elsewhere':
      return 'review';
    case 'closed':
      // Merged work waiting on its status to catch up reads as landed; a discarded run
      // sends the task back to its spec.
      return latestRun.reviewAction === 'discard' ? 'spec' : 'summary';
  }
}

/** The modes a task offers, in lifecycle order. */
export function taskPageModes(isContainer: boolean): TaskPageMode[] {
  return isContainer
    ? ['spec', 'plan', 'summary']
    : ['spec', 'run', 'review', 'summary'];
}

/** How far the task has got through one stage of its lifecycle; `skipped` is a stage the
 * task moved past without using (landed with no agent run, say). */
export type StageProgress =
  | 'done'
  | 'current'
  | 'failed'
  | 'pending'
  | 'skipped';

export interface LifecycleStage {
  mode: TaskPageMode;
  label: string;
  /** A few words on what the stage holds (`3 criteria`, `2 runs · $1.20`). */
  caption: string;
  progress: StageProgress;
  /** Set while a run is live: the ISO time its clock counts from. */
  liveSince?: string;
}

export interface StageInput extends TaskStateInput {
  /** Execute runs, newest first. */
  runs: readonly RunMeta[];
  criteriaCount: number | null;
  writesCount: number;
  unmetBlockers: number;
  /** The status's display label, for the summary caption. */
  statusLabel: string;
  /** A container's children: how many there are, done and running. */
  children: { total: number; done: number; running: number };
}

const MODE_LABEL: Record<TaskPageMode, string> = {
  spec: 'Spec',
  run: 'Run',
  review: 'Review',
  summary: 'Summary',
  plan: 'Plan',
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function totalCost(runs: readonly RunMeta[]): number {
  let sum = 0;
  for (const run of runs) sum += run.costUsd ?? 0;
  return sum;
}

function specCaption(input: StageInput): string {
  if (input.unmetBlockers > 0) {
    return `Waits on ${plural(input.unmetBlockers, 'task')}`;
  }
  const parts: string[] = [];
  const n = input.criteriaCount;
  if (n !== null) {
    parts.push(
      n === 0 ? 'No criteria' : n === 1 ? '1 criterion' : `${n} criteria`
    );
  }
  if (input.writesCount > 0) parts.push(plural(input.writesCount, 'write'));
  return parts.join(' · ');
}

function runCaption(input: StageInput): string {
  const latest = input.runs[0];
  if (latest === undefined) return 'Not dispatched';
  if (!isTerminalRunState(latest.state)) {
    return latest.state === 'awaiting-approval' ? 'Needs approval' : 'Working';
  }
  const cost = totalCost(input.runs);
  const count = plural(input.runs.length, 'run');
  return cost > 0 ? `${count} · ${usd(cost)}` : count;
}

function reviewCaption(input: StageInput): string {
  const latest = input.runs[0];
  if (latest === undefined || !isTerminalRunState(latest.state)) return '—';
  switch (deriveRunDisposition(latest)) {
    case 'needs-review':
      return 'Waiting on you';
    case 'in-review-elsewhere':
      return 'PR open';
    case 'closed':
      return latest.reviewAction === 'discard' ? 'Discarded' : 'Merged';
    default:
      return latest.state === 'cancelled' ? 'Cancelled' : 'Failed';
  }
}

function summaryCaption(input: StageInput): string {
  if (input.statusType === 'completed' || input.statusType === 'canceled') {
    return input.statusLabel;
  }
  return '—';
}

function planCaption(input: StageInput): string {
  const { total, done, running } = input.children;
  if (total === 0) return 'No sub-issues';
  const parts = [`${done}/${total} done`];
  if (running > 0) parts.push(`${running} running`);
  return parts.join(' · ');
}

// A stage behind the current one was done if the task actually went through it.
function passedProgress(
  mode: TaskPageMode,
  latest: RunMeta | undefined
): StageProgress {
  if (mode === 'run') return latest === undefined ? 'skipped' : 'done';
  if (mode === 'review') {
    return latest?.reviewedAt !== undefined || latest?.prUrl !== undefined
      ? 'done'
      : 'skipped';
  }
  return 'done';
}

/**
 * The lifecycle track's stages: each mode the task offers, captioned, and marked done,
 * current, failed or pending from the task's state and its runs. The current stage is the
 * one `defaultTaskPageMode` picks, so the track always says where the task really is,
 * whichever mode the page is showing.
 */
export function lifecycleStages(input: StageInput): LifecycleStage[] {
  const modes = taskPageModes(input.isContainer);
  const current = defaultTaskPageMode(input);
  const currentIndex = modes.indexOf(current);
  const latest = input.runs[0];
  const failed =
    latest !== undefined &&
    isTerminalRunState(latest.state) &&
    latest.state !== 'finished' &&
    latest.reviewedAt === undefined;
  return modes.map((mode, index) => {
    const caption =
      mode === 'spec'
        ? specCaption(input)
        : mode === 'run'
          ? runCaption(input)
          : mode === 'review'
            ? reviewCaption(input)
            : mode === 'plan'
              ? planCaption(input)
              : summaryCaption(input);
    const progress: StageProgress =
      index < currentIndex
        ? passedProgress(mode, latest)
        : index > currentIndex
          ? 'pending'
          : mode === 'run' && failed
            ? 'failed'
            : 'current';
    const liveSince =
      mode === 'run' &&
      latest !== undefined &&
      !isTerminalRunState(latest.state)
        ? latest.createdAt
        : undefined;
    return {
      mode,
      label: MODE_LABEL[mode],
      caption,
      progress,
      ...(liveSince === undefined ? {} : { liveSince }),
    };
  });
}
