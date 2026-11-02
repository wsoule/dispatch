import type { MemoryEntryView } from '@dispatch/client';

import { entryProvenance } from '../../lib/memory';
import styles from './MemoryList.module.css';

/** One tab's entries: title, handle and where each came from. The open one
 *  is marked `aria-current` and drawn in the selection tint. */
export function MemoryList({
  entries,
  selected,
  onSelect,
}: {
  entries: readonly MemoryEntryView[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (entries.length === 0)
    return <p className={styles.empty}>Nothing here yet.</p>;
  return (
    <ul aria-label="Memory entries" className={styles.list}>
      {entries.map((e) => (
        <li key={e.id}>
          <button
            type="button"
            aria-current={e.id === selected ? 'true' : undefined}
            onClick={() => onSelect(e.id)}
            className={styles.row}
          >
            {/* Titles are agent- or teammate-written: plain text only. */}
            <span className={styles.title}>{e.title}</span>
            <span className={styles.meta}>
              <span className={styles.handle}>{e.handle}</span>
              {` · ${entryProvenance(e)}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
