import { useQuery } from '@tanstack/react-query';

import { Modal } from '../components/ui/Modal';
import { getFileDiffForSessionFile } from '../lib/tauri';
import './DiffModal.css';

interface DiffModalProps {
  sessionId: string;
  /** Human-readable session identity for the meta line, e.g. "claude-opus-4-8 · a1b2c3d4". */
  sessionLabel: string;
  /** The file to show, or `null` when no diff is being viewed (modal closed). */
  filePath: string | null;
  onClose: () => void;
}

const TAG_PREFIX: Record<string, string> = {
  insert: '+',
  delete: '-',
  equal: ' ',
};

/**
 * Shows one cumulative before/after diff for everything this session did to `filePath` —
 * before-text from its earliest edit, after-text from its most recent — rather than one diff
 * per tool call, computed by the backend from the raw old/new text captured at ingest time.
 * Distinct from `openInEditor` (`SessionDetailModal`'s "Open" button) — that opens the file's
 * *current* on-disk state, which may have changed since; this shows exactly what this
 * session's edits did.
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

  if (filePath === null) {
    return null;
  }

  return (
    <Modal isOpen={filePath !== null} onClose={onClose} title={filePath} wide>
      {isLoading && <p className="diff-modal-status">Loading diff…</p>}
      {isError && <p className="diff-modal-status">Couldn't load this diff.</p>}
      {!isLoading && !isError && data === null && (
        <p className="diff-modal-status">This file change no longer exists.</p>
      )}
      {!isLoading && !isError && data && (
        <>
          <p className="diff-modal-meta">
            {sessionLabel} · {data.edit_count} edit
            {data.edit_count === 1 ? '' : 's'} ·{' '}
            {new Date(data.occurred_at * 1000).toLocaleString()}
          </p>

          {data.lines.length === 0 ? (
            <p className="diff-modal-status">
              No diff content captured for this change — it was recorded before
              Relay started storing before/after text.
            </p>
          ) : (
            <div className="diff-modal-body">
              <div className="diff-modal-lines">
                {data.lines.map((line, i) => (
                  <div
                    key={i}
                    className={`diff-modal-line diff-modal-line-${line.tag}`}
                  >
                    <span className="diff-modal-line-prefix">
                      {TAG_PREFIX[line.tag]}
                    </span>
                    <span className="diff-modal-line-content">
                      {line.content}
                    </span>
                  </div>
                ))}
              </div>
              {data.truncated && (
                <p className="diff-modal-status diff-modal-truncated">
                  Diff truncated — this change is too large to show in full.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
