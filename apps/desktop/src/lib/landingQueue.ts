import type { StatusModel } from '@dispatch-foo/core/browser';
import { isDoneStatus } from '@dispatch-foo/core/browser';
import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  MergeQueueSnapshot,
} from '@dispatch/client';

import type { Step } from '../components/status/StepStrip';
import type { FeedState } from './feedState';

// The Landing page's read model over the merge queue snapshot: which stage each run is in,
// what it is waiting on, and why it failed, in one line. Zero React so it unit-tests as data.

/** Where a run is on its way to main. Held entries (blockers, GitHub, a dirty checkout)
 * are still `queued`: nothing has been done to them yet; `hold` says why they wait. */
export type LandingStage =
  | 'queued'
  | 'rebasing'
  | 'verifying'
  | 'merging'
  | 'landed'
  | 'failed';

const STAGE_OF: Record<MergeQueueEntryState, LandingStage> = {
  queued: 'queued',
  'waiting-blockers': 'queued',
  'blocked-environment': 'queued',
  'waiting-github': 'queued',
  rebasing: 'rebasing',
  verifying: 'verifying',
  merging: 'merging',
  merged: 'landed',
  failed: 'failed',
};

export function landingStage(state: MergeQueueEntryState): LandingStage {
  return STAGE_OF[state];
}

export const STAGE_LABELS: Record<LandingStage, string> = {
  queued: 'Queued',
  rebasing: 'Rebasing',
  verifying: 'Verifying',
  merging: 'Merging',
  landed: 'Landed',
  failed: 'Failed',
};

// The pipeline in order, for the stage track. `failed` is not a step: it marks one.
const PIPELINE = ['queued', 'rebasing', 'verifying', 'merging'] as const;
type PipelineStage = (typeof PIPELINE)[number];

/** Why a queued entry is not moving yet. */
interface LandingHold {
  kind: 'blockers' | 'environment' | 'github';
  detail: string;
}

/** A task this run's task is blocked by that has not finished — and where its run is. */
interface LandingBlocker {
  taskId: string;
  title: string;
  /** The blocker's run in the queue, or null when it is not queued at all. */
  runId: string | null;
  stage: LandingStage | null;
  /** 1-based, among the live entries; null when not queued. */
  position: number | null;
}

type FailureKind =
  | 'rebase-conflict'
  | 'verify-timeout'
  | 'verify-failed'
  | 'unknown-task'
  | 'fetch-failed'
  | 'merge-failed'
  | 'worktree-gone'
  | 'worktree-dirty'
  | 'base-discarded'
  | 'run-gone'
  | 'unknown';

/** A failed entry's reason, read into the one line a row shows. */
export interface LandingFailure {
  kind: FailureKind;
  /** The stage it stopped in. */
  stage: PipelineStage;
  /** The verify step that failed, when one did. */
  step?: string;
  /** A rebase conflict's files. */
  files?: string[];
  exitCode?: number;
  summary: string;
}

export interface LandingItem {
  entry: MergeQueueEntry;
  stage: LandingStage;
  /** 1-based queue position; null once the entry has left the queue. */
  position: number | null;
  /** When the current stage began — or when it landed or failed. */
  since: string;
  hold: LandingHold | null;
  failure: LandingFailure | null;
  /** Unfinished blockers; non-empty only while the entry waits on them. */
  waitingOn: LandingBlocker[];
  /** The stage track: one segment per pipeline stage. */
  steps: Step[];
}

export interface LandingBoard {
  inProgress: LandingItem[];
  failed: LandingItem[];
  landedToday: LandingItem[];
}

/** The slice of a task the page reads: its title for blockers, `blockedBy` for the gate. */
export interface LandingTask {
  meta: { id: string; title: string; status: string; blockedBy: string[] };
}

// SGR colour codes, which verify output from moon and Vite is full of.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function firstLine(text: string): string {
  return (
    text
      .replace(ANSI, '')
      .split(/\r?\n|\r/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

function clip(text: string, max = 140): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `a.ts`, `a.ts, b.ts`, `a.ts, b.ts +3 more` — conflicts usually sit in one or two files. */
export function formatFiles(files: readonly string[]): string {
  const shown = files.slice(0, 2).join(', ');
  const more = files.length - 2;
  return more > 0 ? `${shown} +${more} more` : shown;
}

// Paths git names in `CONFLICT (…): Merge conflict in <path>` — present only when an older
// daemon's reason happened to carry stdout; `entry.conflicts` is the real source.
function conflictPathsInText(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/Merge conflict in (\S+)/g)) {
    if (match[1] !== undefined && !out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

function lastExitCode(text: string): number | undefined {
  const codes = [...text.matchAll(/exit code:? (\d+)/gi)];
  const last = codes[codes.length - 1]?.[1];
  return last === undefined ? undefined : Number(last);
}

function rebaseFailure(entry: MergeQueueEntry, reason: string): LandingFailure {
  const files =
    entry.conflicts !== undefined && entry.conflicts.length > 0
      ? entry.conflicts
      : conflictPathsInText(reason);
  if (files.length > 0) {
    return {
      kind: 'rebase-conflict',
      stage: 'rebasing',
      files,
      summary: `Rebase conflict in ${formatFiles(files)}`,
    };
  }
  const commit = /could not apply ([0-9a-f]{7,})\.\.\.\s*(.*)/i.exec(reason);
  return {
    kind: 'rebase-conflict',
    stage: 'rebasing',
    summary:
      commit === null
        ? 'Rebase conflict'
        : clip(`Rebase conflict applying ${commit[1]} ${commit[2]}`.trim()),
  };
}

// `<step> failed: <output>` — the verify step's own tail, which says what broke.
function stepFailure(step: string, body: string): LandingFailure {
  const unknown = /Unknown task (\S+) for project (\S+?)\.?\s/.exec(`${body} `);
  if (unknown !== null) {
    const target = `${unknown[2]}:${unknown[1]}`;
    return {
      kind: 'unknown-task',
      stage: 'verifying',
      step,
      summary: `${step}: unknown moon task ${target}`,
    };
  }
  const exitCode = lastExitCode(body);
  const target = /Task (\S+:\S+) failed to run/.exec(body)?.[1];
  const parts = [`${step} failed`];
  // `lint-deadcode` running `root:lint-deadcode` says the same thing twice; `build` failing
  // in `desktop:build` names the project that broke, which is worth keeping.
  if (target !== undefined && target !== `root:${step}`) parts.push(target);
  if (exitCode !== undefined) parts.push(`exit ${exitCode}`);
  return {
    kind: 'verify-failed',
    stage: 'verifying',
    step,
    exitCode,
    summary: parts.join(' · '),
  };
}

/**
 * Reads a failed entry's `reason` into one line and the stage it stopped in. The reasons
 * come from MergeQueue's own throws in packages/server/src/orchestrator/mergeQueue.ts, so
 * each prefix below names one of them; anything else falls back to its first line.
 */
export function describeFailure(entry: MergeQueueEntry): LandingFailure {
  const reason = (entry.reason ?? '').replace(ANSI, '');
  const head = firstLine(reason);
  const failedStep = entry.steps?.find((s) => s.status === 'failed')?.name;

  if (head.startsWith('git rebase failed')) return rebaseFailure(entry, reason);
  if (head.startsWith('git fetch failed')) {
    return {
      kind: 'fetch-failed',
      stage: 'rebasing',
      summary: clip(head.replace(/^git fetch failed:\s*/, 'Fetch failed: ')),
    };
  }
  if (head.startsWith('git push failed') || head.startsWith('gh pr merge')) {
    return { kind: 'merge-failed', stage: 'merging', summary: clip(head) };
  }
  if (head.startsWith('worktree is gone')) {
    return {
      kind: 'worktree-gone',
      stage: 'rebasing',
      summary: 'Worktree is gone — re-dispatch the task or discard the run',
    };
  }
  if (head.includes('worktree has uncommitted changes')) {
    return {
      kind: 'worktree-dirty',
      stage: 'rebasing',
      summary: 'Worktree has uncommitted changes',
    };
  }
  if (head.includes('was stacked on was discarded')) {
    return {
      kind: 'base-discarded',
      stage: 'queued',
      summary: 'Its base run was discarded — rebase onto a valid base',
    };
  }
  if (
    head.startsWith('run no longer exists') ||
    head.startsWith('run was already reviewed')
  ) {
    return { kind: 'run-gone', stage: 'queued', summary: clip(head) };
  }

  const timeout = /^(\S+) timed out after (\d+)s/.exec(head);
  if (timeout?.[1] !== undefined) {
    return {
      kind: 'verify-timeout',
      stage: 'verifying',
      step: timeout[1],
      summary: `${timeout[1]} timed out after ${timeout[2]}s`,
    };
  }
  const step = /^(\S+) failed: ?/.exec(head);
  if (step?.[1] !== undefined) {
    return stepFailure(step[1], reason.slice(step[0].length));
  }

  return {
    kind: 'unknown',
    stage: failedStep !== undefined ? 'verifying' : 'queued',
    step: failedStep,
    summary: head === '' ? 'Failed — no reason recorded' : clip(head),
  };
}

// One segment per pipeline stage: those behind the current one passed, the current one is
// active (or failed), the rest pending. A landed entry is every segment passed.
function stageSteps(stage: LandingStage, failedAt?: PipelineStage): Step[] {
  const at =
    stage === 'landed'
      ? PIPELINE.length
      : PIPELINE.indexOf(failedAt ?? (stage as PipelineStage));
  return PIPELINE.map((name, i) => ({
    name: STAGE_LABELS[name],
    status:
      i < at
        ? 'passed'
        : i > at
          ? 'pending'
          : stage === 'failed'
            ? 'failed'
            : 'active',
  }));
}

// `Landing-mode config (#1 · verifying)`, or `(not queued)` when its run has not reached
// the queue — the case where nothing will move until someone queues it.
function blockerLabel(blocker: LandingBlocker): string {
  if (blocker.position === null || blocker.stage === null)
    return `${blocker.title} (not queued)`;
  return `${blocker.title} (#${blocker.position} · ${STAGE_LABELS[blocker.stage].toLowerCase()})`;
}

function holdOf(
  entry: MergeQueueEntry,
  waitingOn: readonly LandingBlocker[]
): LandingHold | null {
  switch (entry.state) {
    case 'waiting-blockers':
      return {
        kind: 'blockers',
        detail:
          waitingOn.length === 0
            ? 'Waiting on its blockers'
            : `Waiting on ${waitingOn.map(blockerLabel).join(', ')}`,
      };
    case 'blocked-environment':
      return {
        kind: 'environment',
        detail: firstLine(entry.reason ?? '') || 'Main checkout is not clean',
      };
    case 'waiting-github':
      return {
        kind: 'github',
        detail: `GitHub: ${firstLine(entry.reason ?? '') || 'waiting'}`,
      };
    default:
      return null;
  }
}

function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Groups the queue into the page's three sections, one row per task.
 *
 * `entries` are all in progress. `history` is newest first, so the first terminal entry
 * seen for a task is its latest word: a task whose run is back in the queue, or that
 * landed after an earlier failure, no longer counts as failed. Only failures and today's
 * landings are kept; older landings drop out. `tasks` should include archived ones, the
 * same set the server's blocker gate reads, so an archived blocker still counts.
 */
export function buildLandingBoard(
  snapshot: MergeQueueSnapshot | null,
  tasks: readonly LandingTask[],
  statuses: StatusModel,
  now: number
): LandingBoard {
  const board: LandingBoard = { inProgress: [], failed: [], landedToday: [] };
  if (snapshot === null) return board;

  const taskById = new Map(tasks.map((t) => [t.meta.id, t]));
  const liveByTask = new Map<string, { entry: MergeQueueEntry; at: number }>();
  snapshot.entries.forEach((entry, i) => {
    if (!liveByTask.has(entry.taskId))
      liveByTask.set(entry.taskId, { entry, at: i + 1 });
  });

  const blockersOf = (entry: MergeQueueEntry): LandingBlocker[] => {
    if (entry.state !== 'waiting-blockers') return [];
    const ids = taskById.get(entry.taskId)?.meta.blockedBy ?? [];
    const out: LandingBlocker[] = [];
    for (const id of ids) {
      const blocker = taskById.get(id);
      if (blocker === undefined || isDoneStatus(blocker.meta.status, statuses))
        continue;
      const live = liveByTask.get(id);
      out.push({
        taskId: id,
        title: blocker.meta.title,
        runId: live?.entry.runId ?? null,
        stage: live === undefined ? null : landingStage(live.entry.state),
        position: live?.at ?? null,
      });
    }
    return out;
  };

  const seenTasks = new Set<string>();
  snapshot.entries.forEach((entry, i) => {
    seenTasks.add(entry.taskId);
    const stage = landingStage(entry.state);
    const waitingOn = blockersOf(entry);
    board.inProgress.push({
      entry,
      stage,
      position: i + 1,
      since: entry.stateSince ?? entry.enqueuedAt,
      hold: holdOf(entry, waitingOn),
      failure: null,
      waitingOn,
      steps: stageSteps(stage),
    });
  });

  const today = startOfLocalDay(now);
  for (const entry of snapshot.history) {
    if (seenTasks.has(entry.taskId)) continue;
    seenTasks.add(entry.taskId);
    const since = entry.finishedAt ?? entry.stateSince ?? entry.enqueuedAt;
    const stage = landingStage(entry.state);
    if (stage === 'failed') {
      const failure = describeFailure(entry);
      board.failed.push({
        entry,
        stage,
        position: null,
        since,
        hold: null,
        failure,
        waitingOn: [],
        steps: stageSteps(stage, failure.stage),
      });
    } else if (stage === 'landed' && Date.parse(since) >= today) {
      board.landedToday.push({
        entry,
        stage,
        position: null,
        since,
        hold: null,
        failure: null,
        waitingOn: [],
        steps: stageSteps(stage),
      });
    }
  }
  return board;
}

export type LandingFilter = 'all' | 'in-progress' | 'failed' | 'landed-today';

export interface LandingSection {
  id: Exclude<LandingFilter, 'all'>;
  label: string;
  items: LandingItem[];
}

const SECTION_LABELS: Record<LandingSection['id'], string> = {
  'in-progress': 'In progress',
  failed: 'Failed — needs action',
  'landed-today': 'Landed today',
};

/** The sections a filter shows, in page order — failures first, since they need you. An
 * empty section stays out of `all` but is kept when it is the one asked for, so the page
 * can say "nothing here" rather than showing nothing. */
export function landingSections(
  board: LandingBoard,
  filter: LandingFilter
): LandingSection[] {
  const all: LandingSection[] = [
    { id: 'failed', label: SECTION_LABELS.failed, items: board.failed },
    {
      id: 'in-progress',
      label: SECTION_LABELS['in-progress'],
      items: board.inProgress,
    },
    {
      id: 'landed-today',
      label: SECTION_LABELS['landed-today'],
      items: board.landedToday,
    },
  ];
  if (filter === 'all') return all.filter((s) => s.items.length > 0);
  return all.filter((s) => s.id === filter);
}

/** `12s`, `4m`, `1h 5m`, `2d` — how long an entry has sat where it is. */
export function formatStageElapsed(since: string, now: number): string {
  const then = Date.parse(since);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/** What a row says about where it is, beside the stage: the hold, the blocker or the step. */
export function stageDetail(item: LandingItem): string | null {
  if (item.failure !== null) return item.failure.summary;
  if (item.hold !== null) return item.hold.detail;
  if (item.stage === 'verifying') {
    const steps = item.entry.steps ?? [];
    const running = steps.find((s) => s.status === 'running');
    const passed = steps.filter((s) => s.status === 'passed').length;
    if (steps.length === 0) return null;
    return running === undefined
      ? `${passed}/${steps.length}`
      : `${running.name} · ${passed}/${steps.length}`;
  }
  if (item.stage === 'landed') {
    switch (item.entry.landedOn) {
      case 'origin':
        return 'on origin';
      case 'pr':
        return 'via PR';
      case 'local':
        return 'into the local checkout';
      default:
        return null;
    }
  }
  return null;
}

/** The top bar's landing counts: runs on their way, and failures waiting on you. */
export function landingCounts(board: LandingBoard): {
  active: number;
  failed: number;
} {
  return { active: board.inProgress.length, failed: board.failed.length };
}

/** Whether the queue would accept "pull from queue" for this row: the server refuses to
 * remove the entry it is actively rebasing, verifying or merging. */
export function canPullFromQueue(item: LandingItem): boolean {
  return item.position !== null && item.stage === 'queued';
}

/** The row's state glyph: amber for a hold only you can clear (a dirty checkout), red for a
 * failure, blue while the machine works, and the plane for queued and landed runs. */
export function landingMark(item: LandingItem): FeedState {
  if (item.stage === 'failed') return 'failed';
  switch (item.hold?.kind) {
    case 'environment':
      return 'unblock';
    case 'blockers':
      return 'blocked';
    case 'github':
      return 'checking';
    default:
      break;
  }
  return item.stage === 'queued' || item.stage === 'landed'
    ? 'landing'
    : 'working';
}
