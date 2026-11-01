import { Button, EmptyState, Spinner } from '@dispatch/ui';
import { OctagonAlert } from 'lucide-react';

import { RawDetails } from '../gr8r/RawText';
import styles from './DaemonUnavailable.module.css';

interface DaemonUnavailableProps {
  /** The daemon is still starting — a lighter, non-error status line, no Retry button (there
   * is nothing to retry yet). */
  starting: boolean;
  errorDetail: unknown;
  onRetry: () => void;
}

/**
 * The background-service-unreachable empty state, extracted from the original `BoardView` (I4 in the
 * phase-8 fix report) so every primary dispatch view shows the *same* starting/error/retry
 * treatment instead of each one growing its own copy (or, worse, silently showing an
 * unrelated "Loading…" state forever when the daemon never came up at all — the bug this was
 * extracted to fix in `TasksListView`).
 */
export function DaemonUnavailable({
  starting,
  errorDetail,
  onRetry,
}: DaemonUnavailableProps) {
  if (starting) {
    return (
      <div className={styles.frame}>
        <EmptyState icon={<Spinner size="lg" label={null} />}>
          Starting Dispatch’s background service…
        </EmptyState>
      </div>
    );
  }

  const detail = describeDaemonError(errorDetail);
  return (
    <div className={styles.frame}>
      <EmptyState
        icon={
          <OctagonAlert className={styles.alert} size={20} strokeWidth={1.8} />
        }
        action={
          <div className={styles.actions}>
            {detail !== null && <RawDetails text={detail} />}
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        }
      >
        Dispatch couldn’t start for this project
      </EmptyState>
    </div>
  );
}

// Tauri `invoke` rejections arrive as plain strings (the Rust command's
// Err(String)), not Error instances — an `instanceof Error` check alone
// silently swallows exactly the diagnostic detail (daemon output tail, log
// path) the sidecar now works to provide. Accept both shapes.
export function describeDaemonError(errorDetail: unknown): string | null {
  if (errorDetail instanceof Error) return errorDetail.message;
  if (typeof errorDetail === 'string' && errorDetail.length > 0) {
    return errorDetail;
  }
  return null;
}
