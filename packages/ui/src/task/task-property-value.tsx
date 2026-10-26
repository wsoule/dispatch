import type { ReactNode } from 'react';

import { cx } from '../tasks/class-names';
import type { UiTone } from '../types';
import styles from './task-property-value.module.css';
import type { TaskPropertyValueProps } from './types';

// The class for a value or note tone: muted has its own grey; every other
// tone but default reads --tone-ink from data-tone.
function toneClass(tone: UiTone): string | undefined {
  if (tone === 'default') return undefined;
  return tone === 'muted' ? styles.muted : styles.toned;
}

/* A property value with an optional sentence under it, for the facts the
   tracker does not show: "Ana Moreno" over "Given by the planner: she
   leads Beacon search", "Todo" over "for 9 days". Drop it into a
   PropertyListItem's value; editors (Dispatch's pickers) can be its
   children just as well as text. A tone colours the value or the note
   with the tone's TEXT colour (data-tone: warning "Unassigned", danger an
   overdue date, accent something new), the toned look of §8.2 (no fill);
   muted puts it in the quiet text step. `mono` is tabular figures. */
export function TaskPropertyValue({
  children,
  note,
  tone = 'default',
  noteTone = 'muted',
  mono = false,
}: TaskPropertyValueProps): ReactNode {
  return (
    <span className={styles.stack}>
      <span
        className={cx(
          styles.value,
          mono ? styles.mono : undefined,
          toneClass(tone)
        )}
        data-tone={tone}
      >
        {children}
      </span>
      {note !== undefined && note !== null && note !== '' ? (
        <span
          className={cx(
            styles.note,
            noteTone === 'default' ? styles.noteDefault : toneClass(noteTone)
          )}
          data-tone={noteTone}
          dir="auto"
        >
          {note}
        </span>
      ) : null}
    </span>
  );
}
