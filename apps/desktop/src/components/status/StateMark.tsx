import { cx } from '@dispatch/ui';
import {
  Ban,
  CirclePlay,
  CircleX,
  Eye,
  Gavel,
  LoaderCircle,
  MessageCircleQuestion,
  PlaneLanding,
  ScanSearch,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from 'lucide-react';

import {
  type FeedState,
  feedStateTone,
  isInFlightState,
} from '../../lib/feedState';
import styles from './StateMark.module.css';

/** A feed state, or one of the two closed-out marks. A closed-out run has no feed state
 * (`deriveFeedState` returns null, it is nobody's move) and its row still needs a mark:
 * `done` for work that landed (merged, or handed on as a PR), `closed` for work closed
 * without landing (discarded, or closed with no recorded action). */
type StateMarkState = FeedState | 'done' | 'closed';

/** The two closed-out marks, drawn as a filled neutral disc rather than a lucide glyph. */
type ClosedOutState = 'done' | 'closed';

function isClosedOut(state: StateMarkState): state is ClosedOutState {
  return state === 'done' || state === 'closed';
}

// One lucide glyph per state — the glyph names the specific move, literal where a literal
// exists (a gavel for a ruling, a plane landing, a wrench for a fix round), so two states
// of one tier stay tellable apart without their shared hue.
const MARK_ICON: Record<FeedState, typeof Ban> = {
  answer: MessageCircleQuestion,
  approve: ShieldCheck,
  review: Eye,
  ruling: Gavel,
  unblock: TriangleAlert,
  failed: CircleX,
  working: LoaderCircle,
  fixing: Wrench,
  checking: ScanSearch,
  landing: PlaneLanding,
  ready: CirclePlay,
  blocked: Ban,
};

// What is cut out of a closed-out disc, on a 24-unit grid: a check for landed work, a bar
// for work closed without landing (so a discarded run never reads as completed).
const DISC_CUT: Record<ClosedOutState, string> = {
  done: 'm8.5 12.2 2.4 2.4 4.6-4.8',
  closed: 'M8 12h8',
};

interface StateMarkProps {
  state: StateMarkState;
  /** `icon` is the glyph (which move, in the tier's tone); `dot` keeps only the tone, as a
   * small disc for dense rails. */
  variant?: 'icon' | 'dot';
  /** In-flight (machine-tier) states pulse when asked, and only under no-preference
   * motion; every other state ignores it. */
  pulse?: boolean;
  /** md is the 14px glyph (9px dot), sm the 12px glyph (8px dot). */
  size?: 'sm' | 'md';
  /** The state in words. When given the mark is an image with this name; without it the
   * mark is decorative, because the row says the state in text beside it. */
  label?: string;
}

/**
 * What tells a row's state apart: one glyph per move (`variant="icon"`) coloured through
 * `data-tone` (`feedStateTone`: by whose move it is, except review green and blocked amber
 * as the status table fixes them), or the tone alone as a disc (`variant="dot"`). `done`
 * and `closed` are a filled neutral disc with no tone and no outer stroke (so no ring shows
 * on a tinted row), a check or a bar cut out of it: finished work never reads green beside
 * a red failure. The pulse is exposed as `data-pulse` and animated only by the stylesheet's
 * no-preference motion query.
 */
export function StateMark({
  state,
  variant = 'icon',
  pulse = false,
  size = 'md',
  label,
}: StateMarkProps) {
  const closedOut = isClosedOut(state);
  const tone = closedOut ? undefined : feedStateTone(state);
  const pulsing = pulse && !closedOut && isInFlightState(state);
  const a11y =
    label === undefined
      ? { 'aria-hidden': true as const }
      : { role: 'img', 'aria-label': label };
  const shared = {
    ...a11y,
    'data-slot': variant === 'dot' ? 'state-dot' : 'state-mark',
    'data-state': state,
    'data-tone': tone,
    'data-pulse': pulsing ? 'true' : undefined,
  };
  if (variant === 'dot') {
    return (
      <span
        {...shared}
        className={cx(
          styles.dot,
          size === 'sm' ? styles.dotSm : undefined,
          closedOut ? styles.dotDone : undefined
        )}
      />
    );
  }
  const px = size === 'sm' ? 12 : 14;
  if (closedOut) {
    return (
      <svg
        {...shared}
        width={px}
        height={px}
        viewBox="0 0 24 24"
        fill="none"
        className={styles.mark}
      >
        {/* r 11: the outer edge lucide's stroked r-10 circle reaches, so the disc is the
            glyphs' size. */}
        <circle cx="12" cy="12" r="11" className={styles.discFill} />
        <path
          d={DISC_CUT[state]}
          className={styles.discCut}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  const Icon = MARK_ICON[state];
  return (
    <Icon {...shared} size={px} strokeWidth={1.8} className={styles.mark} />
  );
}
