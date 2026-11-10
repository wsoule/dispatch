import type { ReactNode } from 'react';

import { cx } from '../tasks/class-names';
import styles from './save-status.module.css';

// The two pieces every edit control prints around itself: a polite live
// region that says "Saving Assignee" while a save runs, and the inline
// error line a rejected save leaves behind. Not a client module.

/** Screen-reader announcement of a running save. Always rendered (empty
    when idle), so assistive tech is already listening when it fills. */
export function SavingAnnouncement({
  pending,
  text,
}: {
  pending: boolean;
  text: string;
}): ReactNode {
  return (
    <span className="srOnly" role="status">
      {pending ? text : ''}
    </span>
  );
}

/** The quiet "Saving" note shown beside a value while its save runs. The
    live region above speaks it, so this one is hidden from assistive
    tech. */
export function PendingNote({ text }: { text: string }): ReactNode {
  return (
    <span className={styles.pending} aria-hidden="true" data-edit-pending="">
      {text}
    </span>
  );
}

/** The inline error of a rejected save: a red lead-in ("Not saved")
    and the message, announced as an alert when it appears. */
export function SaveErrorLine({
  label,
  message,
  id,
  className,
}: {
  label: string;
  message: string;
  id?: string;
  className?: string;
}): ReactNode {
  return (
    <span
      id={id}
      className={cx(styles.error, className)}
      role="alert"
      data-edit-error=""
    >
      <span className={styles.key}>{label}</span>
      <span className={styles.message} dir="auto">
        {message}
      </span>
    </span>
  );
}
