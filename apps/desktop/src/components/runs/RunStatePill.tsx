import type { RunMeta, RunState } from '@dispatch/client';
import { Chip, cx } from '@dispatch/ui';

import {
  deriveRunDisposition,
  runDispositionLabel,
  runStateLabel,
} from '../../lib/runState';
import { StateMark } from '../status/StateMark';
import styles from './RunStatePill.module.css';
import type { FeedState } from '@/lib/feedState';

/**
 * Which feed state each `RunState` is drawn as, so this pill and the dense surfaces that group
 * by state can never disagree about what "waiting on you" looks like. StateMark turns it into
 * a glyph and a `data-tone` (`feedStateTone`).
 *
 * One row differs from `deriveFeedState` on purpose: `cancelled` is neutral here, not a
 * failure. The two answer different questions. The Control room asks "does a human owe this
 * something", and a cancelled run does — so it groups with failures there. This pill only
 * reports where the process ended, and a run the user deliberately stopped is not an error;
 * painting it red would claim something broke.
 */
const RUN_STATE_TONE: Record<RunState, FeedState> = {
  provisioning: 'working',
  running: 'working',
  'awaiting-approval': 'approve',
  finished: 'review',
  failed: 'failed',
  cancelled: 'blocked',
  'interrupted-dirty': 'failed',
};

interface RunStatePillProps {
  meta: RunMeta;
  /** The 14px mark alone, for a list row or card where the label would crowd the title;
   * the state and disposition become its accessible name. */
  compact?: boolean;
  className?: string;
}

/** The run-state chip shared by the Tasks board card, the Runs rail, and the run detail
 * header — one place owns the RunState -> label/tone mapping so every surface agrees. A
 * library `Chip` led by the 14px `StateMark` glyph (its hue through `data-tone`), with the
 * words from `runStateLabel`, so the colour is never the only cue.
 *
 * Takes the whole `RunMeta` rather than just `state` because `RunState` alone cannot say what
 * a run needs from a human: two runs on `finished` differ on whether anyone reviewed them, and
 * two on `failed` differ on whether a session remains to continue from. The disposition chip
 * beside the state answers that (see `deriveRunDisposition`), and deriving it here rather than
 * at each call site is what keeps every surface agreeing — a run reading "Needs review" in
 * the Runs rail but bare "Finished" on a board card is exactly the inconsistency this exists
 * to remove. */
export function RunStatePill({
  meta,
  compact = false,
  className,
}: RunStatePillProps) {
  const state = meta.state;
  const label = runStateLabel(state);
  const badge = runDispositionLabel(
    deriveRunDisposition(meta),
    meta.reviewAction
  );
  const tone = RUN_STATE_TONE[state];

  if (compact) {
    const name = badge === null ? label : `${label} · ${badge}`;
    return (
      <span
        role="img"
        aria-label={name}
        title={name}
        data-slot="run-state-mark"
        data-run-state={state}
        className={cx(styles.mark, className)}
      >
        <StateMark state={tone} variant="dot" pulse />
      </span>
    );
  }

  return (
    <span
      data-slot="run-state-pill"
      data-run-state={state}
      className={cx(styles.pill, className)}
    >
      <Chip>
        <span className={styles.chipBody}>
          <StateMark state={tone} pulse />
          {label}
        </span>
      </Chip>
      {badge !== null && <Chip tone="muted">{badge}</Chip>}
    </span>
  );
}
