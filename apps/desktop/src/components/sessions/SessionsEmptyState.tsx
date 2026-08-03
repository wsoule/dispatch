import type { ReactNode } from 'react';

import { Button } from '@/ui/button';

interface SessionsEmptyStateProps {
  icon: ReactNode;
  message: ReactNode;
  /** `destructive` tints the icon for error states; `muted` (default) is the plain "nothing
   * here yet" tone. */
  tone?: 'muted' | 'destructive';
  /** Shown as a "Retry" button when set — omitted for a plain empty state (nothing to retry),
   * present for a load failure. */
  onRetry?: () => void;
}

/**
 * The centered icon + message (+ optional Retry) treatment every Sessions-hub tab uses for its
 * "nothing here yet" and "couldn't load" states — Dashboard, Projects, Sessions, Timeline, and
 * Reports each rendered their own near-identical copy of this block before this pass. Mirrors
 * `DaemonUnavailable`'s layout (icon, muted message, retry button) without that component's
 * dispatchd-specific copy, since these queries hit the app's own local data, not the task daemon.
 */
export function SessionsEmptyState({
  icon,
  message,
  tone = 'muted',
  onRetry,
}: SessionsEmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 pt-24 text-center">
      <span
        className={
          tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
        }
      >
        {icon}
      </span>
      <p className="text-muted-foreground max-w-sm text-[13px]">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
