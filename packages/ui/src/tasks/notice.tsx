import { CircleDashed, Inbox } from 'lucide-react';

import type { UiTone } from '../types';
import { cx } from './class-names';
import styles from './notice.module.css';
import type { EmptyStateProps, NoticeProps } from './types';

/* The tones whose lead-in takes the tone's text colour (a status tone, or
   muted's quiet grey); default and accent keep theirs. */
const TONED_KEY: ReadonlySet<UiTone> = new Set<UiTone>([
  'danger',
  'warning',
  'success',
  'info',
  'muted',
]);

/* Gr8r's alert (.notice) with a semibold lead-in: blocked states, errors,
   the demo-mode banner. default / muted is a bordered neutral box (muted
   with a grey lead-in); every other tone fills it with its soft tint and
   prints the lead-in in the tone's text colour (accent = Gr8r's info
   alert, the default; danger for errors and failures, warning for blocked
   or a missing input, success, info), the sentence staying --text. role is
   opt-in: "status" for something that just changed, "alert" for an error;
   static copy needs neither. */
export function Notice({
  label,
  children,
  tone = 'accent',
  role,
  action,
}: NoticeProps) {
  return (
    <div
      className={cx(
        'notice',
        tone === 'default' || tone === 'muted' ? styles.quiet : undefined
      )}
      role={role}
      data-tone={tone}
    >
      {label !== undefined && label !== '' ? (
        <span
          className={cx(
            'key',
            styles.key,
            TONED_KEY.has(tone) ? styles.toneKey : undefined
          )}
        >
          {label}
        </span>
      ) : null}
      <div className={styles.body}>{children}</div>
      {action !== undefined ? (
        <div className={styles.action}>{action}</div>
      ) : null}
    </div>
  );
}

/* Gr8r's empty state: a centred column of a 22px icon in --text-4 (no
   tile behind it), the title, the sentence and the action, inside the
   soft .empty box; a dashed edge (.hatched) when the emptiness is a
   missing input. The icon defaults to an empty tray (a dashed circle when
   hatched); pass `icon={null}` for none. The title is styled by the
   module alone: the global .label has the same specificity and would make
   it 12px grey wherever primitives.css loads after this module. */
export function EmptyState({
  children,
  label,
  action,
  hatched = false,
  icon,
}: EmptyStateProps) {
  const glyph =
    icon === undefined ? (
      hatched ? (
        <CircleDashed size={22} strokeWidth={1.8} />
      ) : (
        <Inbox size={22} strokeWidth={1.8} />
      )
    ) : (
      icon
    );
  return (
    <div className={cx('empty', hatched ? 'hatched' : undefined, styles.empty)}>
      {glyph !== null && glyph !== false ? (
        <span className={styles.emptyIcon} aria-hidden="true">
          {glyph}
        </span>
      ) : null}
      {label !== undefined && label !== '' ? (
        <p className={styles.emptyKey}>{label}</p>
      ) : null}
      <p className={styles.emptyText}>{children}</p>
      {action !== undefined ? (
        <div className={styles.emptyAction}>{action}</div>
      ) : null}
    </div>
  );
}
