import { cx } from '@dispatch/ui';
import { File } from 'lucide-react';

import type { ChangedFile } from '../../lib/changedFiles';
import styles from './ChangedFilesCard.module.css';

/**
 * T3 Code's changed-files card at the end of a turn: a soft secondary card listing each
 * file the run edited, with its +/- line counts in the diff tones. Counts come from the
 * edit payloads (`changedFilesFromLog`), so it is a summary, not the review diff.
 */
export function ChangedFilesCard({ files }: { files: readonly ChangedFile[] }) {
  if (files.length === 0) return null;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <section
      aria-label="Changed files"
      data-slot="changed-files"
      className={styles.card}
    >
      <header className={styles.head}>
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </span>
        <DiffStat added={added} removed={removed} />
      </header>
      <ul className={styles.list}>
        {files.map((file) => (
          <li key={file.path} className={styles.file}>
            <File
              className={styles.icon}
              size={14}
              strokeWidth={1.8}
              aria-hidden
            />
            <span className={cx(styles.path, 'mono')} title={file.path}>
              {file.path}
            </span>
            <DiffStat added={file.added} removed={file.removed} />
          </li>
        ))}
      </ul>
    </section>
  );
}

// Nothing to count (an edit logged without its strings) draws nothing, never "+0 −0".
// The signs carry the meaning; the success and danger tones only reinforce them.
function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className={cx(styles.stat, 'mono', 'num')}>
      <span className="toneText" data-tone="success">
        +{added}
      </span>
      <span className="toneText" data-tone="danger">
        −{removed}
      </span>
    </span>
  );
}
