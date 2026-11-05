import type { RunMeta, RunState } from '@dispatch/client';
import { Chip, cx } from '@dispatch/ui';

import type { RunDisposition } from '../../lib/runState';
import {
  closedOutMark,
  deriveRunDisposition,
  runDispositionLabel,
  runStateLabel,
} from '../../lib/runState';
import { StateMark } from '../status/StateMark';
import styles from './RunStatePill.module.css';
import type { FeedState } from '@/lib/feedState';

/**
 * Which StateMark each `RunState` is drawn as, so this pill and the dense surfaces that group
 * by state can never disagree about what "waiting on you" looks like. StateMark turns a feed
 * state into a glyph and a `data-tone` (`feedStateTone`): a finished run is `review`, green
 * like any succeeded work that waits on a person (plan Q6.2), never the amber of an ask.
 *
 * One row differs from `deriveFeedState` on purpose: `cancelled` is the neutral `closed` mark
 * here (grey for inactive in the status table), not a failure. The two answer different
 * questions. The Control room asks "does a human owe this something", and a cancelled run
 * does, so it groups with failures there. This pill only reports where the process ended, and
 * a run the user deliberately stopped is not an error; painting it red would claim something
 * broke, and amber would claim it waits on input.
 */
const RUN_STATE_MARK: Record<RunState, FeedState | 'closed'> = {
  provisioning: 'working',
  running: 'working',
  'awaiting-approval': 'approve',
  finished: 'review',
  failed: 'failed',
  cancelled: 'closed',
  'interrupted-dirty': 'failed',
};

/** The mark a run is drawn with. A run a person already closed out (merged, discarded or
 * closed) is past its state's mark: it takes the filled neutral disc `closedOutMark` picks,
 * as the Control room draws it, so a merged run never shows green beside a failed one's red
 * and a discarded one never reads as succeeded. */
function runMark(
  meta: RunMeta,
  disposition: RunDisposition
): FeedState | 'done' | 'closed' {
  return disposition === 'closed'
    ? closedOutMark(meta)
    : RUN_STATE_MARK[meta.state];
}

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
  const disposition = deriveRunDisposition(meta);
  const badge = runDispositionLabel(disposition, meta.reviewAction);
  const mark = runMark(meta, disposition);

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
        <StateMark state={mark} variant="dot" pulse />
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
          <StateMark state={mark} pulse />
          {label}
        </span>
      </Chip>
      {badge !== null && <Chip tone="muted">{badge}</Chip>}
    </span>
  );
}
