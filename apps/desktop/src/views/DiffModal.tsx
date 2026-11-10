import { Dialog, Skeleton, SkeletonText, type UiTone } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, FileX, Info } from 'lucide-react';

import { getFileDiffForSessionFile } from '../lib/tauri';
import type { FileDiff } from '../lib/types';
import styles from './DiffModal.module.css';

type DiffTag = FileDiff['lines'][number]['tag'];

interface DiffModalProps {
  sessionId: string;
  /** Human-readable session identity for the description line, e.g. "Claude · a1b2c3d4". */
  sessionLabel: string;
  /** The file to show, or `null` when no diff is being viewed (dialog closed). */
  filePath: string | null;
  onClose: () => void;
}

const TAG_PREFIX: Record<DiffTag, string> = {
  insert: '+',
  delete: '-',
  equal: ' ',
};

// Added and removed rows take the success and danger tones' soft tint (the module paints
// `--tone-soft` behind the line and `--tone-ink` on the +/- glyph); unchanged rows carry no
// tone. The glyph stays, so colour is never the only cue that a line was added or removed.
const TAG_TONE: Record<DiffTag, UiTone | undefined> = {
  insert: 'success',
  delete: 'danger',
  equal: undefined,
};

/**
 * Shows one cumulative before/after diff for everything this session did to `filePath` —
 * before-text from its earliest edit, after-text from its most recent — rather than one diff
 * per tool call, computed by the backend from the raw old/new text captured at ingest time.
 * Distinct from `openInEditor` (`SessionDetailModal`'s "Open" button) — that opens the file's
 * *current* on-disk state, which may have changed since; this shows exactly what this
 * session's edits did.
 *
 * A size-lg `@dispatch/ui` Dialog rendered inside `SessionDetailModal`'s modal slide-over, so
 * it stacks over the panel as the top layer: its Escape closes the dialog alone, and focus
 * returns to the "View diff" button that opened it.
 */
export function DiffModal({
  sessionId,
  sessionLabel,
  filePath,
  onClose,
}: DiffModalProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['file-diff', sessionId, filePath],
    queryFn: () => getFileDiffForSessionFile(sessionId, filePath),
    enabled: filePath !== null,
  });

  return (
    <Dialog
      size="lg"
      open={filePath !== null}
      onClose={onClose}
      // The file is a path, a machine-read string: Geist Mono, one line, full path in the title.
      title={
        <span className={styles.path} title={filePath ?? undefined}>
          {filePath}
        </span>
      }
      description={sessionLabel}
    >
      <div className={styles.body}>
        {/* One labelled skeleton announces the load; the block shape is decorative. */}
        {isLoading && (
          <>
            <SkeletonText lines={1} label="Loading diff" />
            <Skeleton height={160} className={styles.skeletonBlock} />
          </>
        )}
        {isError && (
          <div className={styles.state}>
            <span className="toneText" data-tone="danger">
              <AlertCircle size={20} strokeWidth={1.8} aria-hidden />
            </span>
            <p className={styles.stateText}>Couldn&rsquo;t load this diff.</p>
          </div>
        )}
        {!isLoading && !isError && data === null && (
          <div className={styles.state}>
            <span className={styles.stateIcon}>
              <FileX size={20} strokeWidth={1.8} aria-hidden />
            </span>
            <p className={styles.stateText}>
              This file change no longer exists.
            </p>
          </div>
        )}
        {!isLoading && !isError && data && (
          <>
            <p className={styles.meta}>
              {data.edit_count} edit
              {data.edit_count === 1 ? '' : 's'} ·{' '}
              {new Date(data.occurred_at * 1000).toLocaleString()}
            </p>

            {data.lines.length === 0 ? (
              <p className={styles.stateText}>
                No diff content captured for this change — it was recorded
                before Dispatch started storing before/after text.
              </p>
            ) : (
              <div className={styles.diff}>
                <div className={styles.lines}>
                  {data.lines.map((line, i) => (
                    <div
                      key={i}
                      className={styles.line}
                      data-tone={TAG_TONE[line.tag]}
                      data-tag={line.tag}
                    >
                      <span className={styles.prefix}>
                        {TAG_PREFIX[line.tag]}
                      </span>
                      <span className={styles.content}>{line.content}</span>
                    </div>
                  ))}
                </div>
                {data.truncated && (
                  <p className={styles.truncated}>
                    <Info size={14} strokeWidth={1.8} aria-hidden />
                    Diff truncated — this change is too large to show in full.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
