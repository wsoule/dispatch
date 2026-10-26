import type { ReactNode } from 'react';

import type { UiStatus } from '../types';
import styles from './status-mark.module.css';

/* A milestone's status as a 12px diamond (the milestone symbol of the
   timeline) in the status hues (docs/architecture.md §8.2): overdue =
   solid red, at risk = amber with the bottom half filled, on track = green
   outline, complete = solid neutral (--text) with a tick knocked out (never
   green: done and overdue must differ in lightness, not only in hue),
   missing input = dotted grey outline, open (no status claim of its own) =
   neutral outline. Issue states are circles (StateGlyph), so the two never
   look alike; the shape differs per status, so colour is never the only
   cue, and the label is always available to assistive tech. `muted` draws
   any status as a grey outline diamond (an inactive project's milestone,
   which is never loud). The purple accent is never a status. */
export interface StatusMarkProps {
  status: UiStatus;
  /** Human wording, e.g. "At risk". */
  label: string;
  /** Also render the label beside the mark. */
  showLabel?: boolean;
  /** Greys only, whatever the status (the label still says it). */
  muted?: boolean;
}

export default function StatusMark({
  status,
  label,
  showLabel = false,
  muted = false,
}: StatusMarkProps): ReactNode {
  return (
    <span className={styles.wrap}>
      <span
        className={`${styles.mark} ${muted ? styles.muted : styles[status]}`}
        data-status={status}
        data-muted={muted ? '' : undefined}
        role="img"
        aria-label={label}
      />
      {showLabel ? <span className={styles.text}>{label}</span> : null}
    </span>
  );
}
