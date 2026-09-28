// Every label, tint, default and piece of copy the milestone fan-out surfaces
// print — the header pills, the row pills, the dialog defaults, the paused
// toast and the live-rail readout all read from here so board and milestone
// headers cannot drift apart. Pure and relative-import only (the `@/ui`
// import is type-only) so it stays bun-test-able without a DOM.

import type {
  EpicChildPhase,
  EpicPauseReason,
  EpicProgressChild,
  EpicSpend,
  EpicWave,
  ServerEvent,
} from '@dispatch/client';

import type { TaskTab } from './appNav';
import type { Step } from '@/ui/chrome/StepStrip';

/** What the fan-out dialog hands `handleWorkEpic`/`handleResumeEpic`. `null`
 * lifts a ceiling; `undefined` leaves the server default (start) or the
 * session's current value (resume) in place. */
export interface WorkEpicOptions {
  concurrency: number;
  maxSpendUsd?: number | null;
  maxRuns?: number | null;
}

/** The `epic.paused` frame, by itself. */
export type EpicPausedEvent = Extract<ServerEvent, { type: 'epic.paused' }>;

export const PHASE_LABEL: Record<EpicChildPhase, string> = {
  draft: 'Draft',
  waiting: 'Waiting',
  queued: 'Queued',
  held: 'Held',
  working: 'Working',
  reviewing: 'Reviewing',
  fixing: 'Fixing',
  'needs-review': 'Needs review',
  capped: 'Capped',
  failed: 'Failed',
  blocked: 'Blocked',
  landing: 'Landing',
  landed: 'Landed',
  dropped: 'Dropped',
};

/** The colour a phase pill or chip carries, as a CSS token; `null` for the
 * phases the status glyph already says everything about. */
export function phaseTint(phase: EpicChildPhase): string | null {
  switch (phase) {
    case 'working':
    case 'reviewing':
    case 'fixing':
      return 'var(--state-working-fg)';
    case 'capped':
    case 'held':
    case 'waiting':
      return 'var(--state-waiting-fg)';
    case 'failed':
    case 'blocked':
      return 'var(--state-failed-fg)';
    case 'needs-review':
      return 'var(--state-review-fg)';
    case 'landing':
      return 'var(--state-landing-fg)';
    default:
      return null;
  }
}

/** The phases an active session's header counts, left to right. A zero
 * count renders nothing, so the order is only ever a subset of this. */
export const PHASE_CHIP_ORDER: readonly EpicChildPhase[] = [
  'working',
  'reviewing',
  'fixing',
  'queued',
  'blocked',
  'capped',
  'failed',
];

/** How many children stand in each phase — every phase present, zeros
 * included, so callers index without a guard. */
export function phaseCounts(
  children: readonly EpicProgressChild[]
): Record<EpicChildPhase, number> {
  const counts: Record<EpicChildPhase, number> = {
    draft: 0,
    waiting: 0,
    queued: 0,
    held: 0,
    working: 0,
    reviewing: 0,
    fixing: 0,
    'needs-review': 0,
    capped: 0,
    failed: 0,
    blocked: 0,
    landing: 0,
    landed: 0,
    dropped: 0,
  };
  for (const child of children) counts[child.phase] += 1;
  return counts;
}

const PILL_PHASES: ReadonlySet<EpicChildPhase> = new Set<EpicChildPhase>([
  'working',
  'reviewing',
  'fixing',
  'capped',
  'failed',
  'blocked',
  'held',
  'waiting',
]);

/** Whether a row shows a phase pill: only when the phase says more than the
 * task's status glyph already does. */
export function showsPhasePill(phase: EpicChildPhase): boolean {
  return PILL_PHASES.has(phase);
}

// Cents-rounded so a float sum like 41.199999 still prints as $41.20.
function toCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** `$41.20`, `$1,300` — whole dollars drop the cents. */
export function formatUsd(n: number): string {
  const rounded = toCents(n);
  const digits = Number.isInteger(rounded) ? 0 : 2;
  return `$${rounded.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

// The two-decimal form the ledger-style copy uses (`~$30.00 in flight`).
function formatUsdFixed(n: number): string {
  return `$${toCents(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The spend pill: `$41.20 / $60`, or just `$41.20` with no ceiling. */
export function spendPillLabel(spend: EpicSpend): string {
  const settled = formatUsd(spend.settledUsd);
  return spend.maxSpendUsd === null
    ? settled
    : `${settled} / ${formatUsd(spend.maxSpendUsd)}`;
}

/** `warning` from 80 % of the ceiling, measured the way the gate measures
 * it — settled plus the in-flight estimate — so the pill turns amber before
 * the session pauses, not after. Decided here: the pill prints settled only
 * (`spendPillLabel`), so the tone can flip while the printed number still
 * looks low; every pill that carries this tone renders `spendTitle` as its
 * hover text, which is where the in-flight half is spelled out. */
export function spendTone(spend: EpicSpend): 'working' | 'warning' {
  if (spend.maxSpendUsd === null) return 'working';
  const committed = spend.settledUsd + spend.estimatedLiveUsd;
  return committed >= spend.maxSpendUsd * 0.8 ? 'warning' : 'working';
}

/** The spend pill's hover text: `+~$30.00 in flight · 7/20 runs`. The
 * in-flight half is omitted with nothing live; the `/N` with no run ceiling. */
export function spendTitle(spend: EpicSpend): string {
  const parts: string[] = [];
  if (spend.liveCount > 0) {
    parts.push(`+~${formatUsdFixed(spend.estimatedLiveUsd)} in flight`);
  }
  parts.push(
    spend.maxRuns === null
      ? `${spend.runsStarted} run${spend.runsStarted === 1 ? '' : 's'}`
      : `${spend.runsStarted}/${spend.maxRuns} runs`
  );
  return parts.join(' · ');
}

/** The paused pill's text, by why the session stopped filling. */
export function pausedReasonLabel(reason: EpicPauseReason): string {
  switch (reason) {
    case 'budget':
      return 'Paused — budget ceiling';
    case 'runs':
      return 'Paused — run ceiling';
    case 'human':
      return 'Paused — by you';
    case 'fill-failed':
      return 'Paused — auto-dispatch failed';
  }
}

/** Children whose fix loop ran out of rounds and now wait on a ruling. */
export function rulingsWaiting(children: readonly EpicProgressChild[]): number {
  return children.filter((c) => c.phase === 'capped').length;
}

/** The dialog's starting spend ceiling: the run estimate times the task
 * count, kept between $10 and $200 and rounded up to the next $10. */
export function defaultSpendCeiling(
  taskCount: number,
  estimateUsd: number
): number {
  const clamped = Math.max(10, Math.min(taskCount * estimateUsd, 200));
  return Math.ceil(clamped / 10) * 10;
}

/** The dialog's starting run ceiling: one run per task. */
export function defaultMaxRuns(taskCount: number): number {
  return taskCount;
}

export interface EpicPausedNotice {
  title: string;
  body: string;
}

/** Toast and inbox wording for an `epic.paused` event, in
 * `fixLoopCappedNotice`'s shape. The row is durable, so the body carries the
 * numbers the event had rather than anything a later fetch might change. */
export function epicPausedNotice(
  epicTitle: string,
  event: EpicPausedEvent
): EpicPausedNotice {
  const resume = 'Resume or raise the ceiling to continue.';
  switch (event.reason) {
    case 'budget': {
      const inFlight =
        event.estimatedLiveUsd > 0
          ? ` + ~${formatUsdFixed(event.estimatedLiveUsd)} in flight`
          : '';
      const ceiling =
        event.maxSpendUsd === null
          ? ''
          : ` of ${formatUsdFixed(event.maxSpendUsd)}`;
      return {
        title: `${epicTitle} paused — spend ceiling`,
        body: `${formatUsdFixed(event.settledUsd)} settled${inFlight}${ceiling}. ${resume}`,
      };
    }
    case 'runs': {
      const runs =
        event.maxRuns === null
          ? `${event.runsStarted} runs started`
          : `${event.runsStarted}/${event.maxRuns} runs started`;
      return {
        title: `${epicTitle} paused — run ceiling`,
        body: `${runs}. ${resume}`,
      };
    }
    case 'fill-failed': {
      const detail = event.detail?.trim() ?? '';
      return {
        title: `${epicTitle} paused — auto-dispatch failed`,
        body:
          detail === ''
            ? 'Auto-dispatch kept failing. Resume to try again.'
            : `${detail}. Resume to try again.`,
      };
    }
    case 'human':
      return {
        title: `${epicTitle} paused`,
        body: 'Paused by you. Resume to keep dispatching.',
      };
  }
}

// A child that has cleared review — nothing in the wave is still being
// worked, checked or fixed for it.
const PAST_REVIEWING: ReadonlySet<EpicChildPhase> = new Set<EpicChildPhase>([
  'needs-review',
  'landing',
  'landed',
  'dropped',
]);

function waveCount(wave: EpicWave, phases: Iterable<EpicChildPhase>): number {
  let n = 0;
  for (const phase of phases) n += wave.byPhase[phase] ?? 0;
  return n;
}

/** One `StepStrip` segment per wave. A failure outranks activity — a wave
 * that is both still running and already broken needs a person first. */
export function waveSteps(waves: readonly EpicWave[]): Step[] {
  return waves.map((wave) => {
    const name = `Wave ${wave.index}`;
    if (waveCount(wave, ['blocked', 'failed']) > 0) {
      return { name, status: 'failed' };
    }
    if (waveCount(wave, ['working', 'reviewing', 'fixing']) > 0) {
      return { name, status: 'active' };
    }
    if (wave.total > 0 && waveCount(wave, PAST_REVIEWING) === wave.total) {
      return { name, status: 'passed' };
    }
    return { name, status: 'pending' };
  });
}

/** Where clicking a row's phase pill lands: a failed run's transcript,
 * otherwise the task page on whatever its state calls for. */
export function drillTargetFor(child: EpicProgressChild): {
  tab: TaskTab;
  runId?: string;
} {
  if (child.phase === 'failed') {
    return child.runId === undefined
      ? { tab: 'run' }
      : { tab: 'run', runId: child.runId };
  }
  return { tab: 'auto' };
}
