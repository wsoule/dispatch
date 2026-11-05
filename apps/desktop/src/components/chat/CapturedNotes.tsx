import type { InboxItem } from '@dispatch/client';
import { Button, Chip, cx, Panel, PanelRow, SectionHeader } from '@dispatch/ui';
import { useState } from 'react';

import styles from './posts.module.css';

export interface CapturedNotesProps {
  /** Open captures, already filtered and sorted by `openCaptures`. */
  items: readonly InboxItem[];
  /** The raw handlers: a rejection is shown on the row, so nothing swallows it first. */
  onMakeTask: (ids: string[]) => Promise<unknown>;
  onDismiss: (ids: string[]) => Promise<void>;
}

/** Quick captures and agents' `dispatch_note`s, waiting in Coming in until made a task or dismissed. */
export function CapturedNotes({
  items,
  onMakeTask,
  onDismiss,
}: CapturedNotesProps) {
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Noted"
      data-testid="captured-notes"
      className={styles.stack}
    >
      <SectionHeader as="h2" name="Noted" />
      <Panel as="div" flush>
        {items.map((item) => (
          <CapturedNote
            key={item.id}
            item={item}
            onMakeTask={onMakeTask}
            onDismiss={onDismiss}
          />
        ))}
      </Panel>
    </section>
  );
}

// One capture as a panel row with its two actions; a failed action leaves its
// reason on a line of its own under the row.
function CapturedNote({
  item,
  onMakeTask,
  onDismiss,
}: {
  item: InboxItem;
  onMakeTask: CapturedNotesProps['onMakeTask'];
  onDismiss: CapturedNotesProps['onDismiss'];
}) {
  const [error, setError] = useState<string | null>(null);
  const run = (action: (ids: string[]) => Promise<unknown>) => {
    setError(null);
    action([item.id]).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'That did not go through');
    });
  };
  return (
    <PanelRow className={styles.noteRow}>
      <span className={styles.rowText}>{item.text}</span>
      {item.createdByRunId !== null && <Chip>agent</Chip>}
      <Button
        variant="quiet"
        size="sm"
        className={styles.rowAction}
        onClick={() => run(onMakeTask)}
      >
        Make task
      </Button>
      <Button
        variant="quiet"
        size="sm"
        className={styles.rowAction}
        onClick={() => run(onDismiss)}
      >
        Dismiss
      </Button>
      {error !== null && (
        <p
          role="alert"
          className={cx('toneText', styles.error)}
          data-tone="danger"
        >
          {error}
        </p>
      )}
    </PanelRow>
  );
}
