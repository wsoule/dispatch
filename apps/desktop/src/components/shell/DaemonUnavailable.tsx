import { Loader2, OctagonAlert } from 'lucide-react';

import { Button } from '@/ui/button';

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
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
        <p className="text-muted-foreground text-[13px]">
          Starting the task daemon…
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <OctagonAlert className="text-destructive size-5" />
      <p className="text-muted-foreground max-w-sm text-[13px]">
        Couldn&rsquo;t start dispatchd for this project
        {errorDetail instanceof Error ? `: ${errorDetail.message}` : '.'}
      </p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
