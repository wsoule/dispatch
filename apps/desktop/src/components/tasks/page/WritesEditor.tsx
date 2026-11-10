import { Chip } from '@dispatch/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';

import styles from './pageBlocks.module.css';

/**
 * The declared write set as mono chips, each removable, with a field that adds a path or
 * glob on Enter (or on leaving it). The fan-out schedules around these, so they are worth
 * keeping exact.
 */
export function WritesEditor({
  writes,
  onChange,
}: {
  writes: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const glob = draft.trim();
    setDraft('');
    if (glob === '' || writes.includes(glob)) return;
    onChange([...writes, glob]);
  }
  return (
    <div data-slot="writes-editor" className={styles.chipRow}>
      {writes.map((glob) => (
        <Chip
          key={glob}
          onRemove={() => onChange(writes.filter((w) => w !== glob))}
          removeLabel={`Remove ${glob}`}
        >
          <span className="mono">{glob}</span>
        </Chip>
      ))}
      <label className={styles.writeAdd}>
        <Plus aria-hidden size={14} strokeWidth={1.8} />
        <input
          aria-label="Add a write path"
          placeholder={writes.length === 0 ? 'Add a path or glob…' : 'Add…'}
          className={styles.writeInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
      </label>
    </div>
  );
}
