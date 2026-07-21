import { Button } from '../ui/Button';
import './DaemonUnavailable.css';

interface DaemonUnavailableProps {
  /** The daemon is still starting — a lighter, non-error status line, no Retry button (there
   * is nothing to retry yet). */
  starting: boolean;
  errorDetail: unknown;
  onRetry: () => void;
}

/**
 * The dispatchd-unreachable empty state, extracted from the original `BoardView` (I4 in the
 * phase-8 fix report) so every primary dispatch view shows the *same* starting/error/retry
 * treatment instead of each one growing its own copy (or, worse, silently showing an
 * unrelated "Loading…" state forever when the daemon never came up at all — the bug this was
 * extracted to fix in `TasksListView`/`RunsView`/`PlansView`).
 */
export function DaemonUnavailable({
  starting,
  errorDetail,
  onRetry,
}: DaemonUnavailableProps) {
  if (starting) {
    return <p className="daemon-unavailable">Starting the task daemon…</p>;
  }

  return (
    <div className="daemon-unavailable">
      <p>
        Couldn&rsquo;t start dispatchd for this project
        {errorDetail instanceof Error ? `: ${errorDetail.message}` : '.'}
      </p>
      <Button variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
