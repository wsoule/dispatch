import { CircleAlert, Hand } from 'lucide-react';
import type { ReactNode } from 'react';

import { ProgressTrack } from '@/components/ui/ProgressTrack';
import { StateDot } from '@/components/ui/StateDot';
import type { FeedRowModel } from '@/lib/controlRoom';
import type { FeedState } from '@/lib/feedState';
import { FEED_STATE_LABEL, isUrgentState } from '@/lib/feedState';
import { formatRelativeTimeFromIso } from '@/lib/format';
import { cn } from '@/lib/utils';

// The urgent skins, spelled out for Tailwind's static extraction.
const URGENT_ROW: Partial<Record<FeedState, string>> = {
  waiting: 'bg-state-waiting-surface',
  failed: 'bg-state-failed-surface',
};
const URGENT_TEXT: Partial<Record<FeedState, string>> = {
  waiting: 'text-state-waiting',
  failed: 'text-state-failed',
};

/** A row action. Rendered small and quiet — the row itself is the primary target. */
function RowButton({
  children,
  onClick,
  tone,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: 'urgent-waiting' | 'urgent-failed';
}) {
  return (
    <button
      type="button"
      // Every action sits inside a clickable row, so each one has to stop the click from also
      // opening the row behind it. Approving should not navigate away.
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'shadow-hairline rounded-md px-2 py-1 text-[12px] whitespace-nowrap transition-colors duration-150',
        'hover:bg-muted/60',
        tone === 'urgent-waiting' && 'text-state-waiting',
        tone === 'urgent-failed' && 'text-state-failed',
        tone === undefined && 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

export interface FeedRowActions {
  onOpen: (row: FeedRowModel) => void;
  onApprove: (row: FeedRowModel, allow: boolean) => void;
  onRetry: (row: FeedRowModel) => void;
  onReview: (row: FeedRowModel) => void;
  onCancelLanding: (row: FeedRowModel) => void;
}

interface FeedRowProps {
  row: FeedRowModel;
  actions: FeedRowActions;
}

/**
 * One row of the Control room feed.
 *
 * Urgent rows differ in three ways — a tinted ground, a slightly heavier title, and a second
 * line naming what is actually in the way. That second line is the point of the whole screen:
 * approving or retrying from here means never opening the run at all.
 */
export function FeedRow({ row, actions }: FeedRowProps) {
  const urgent = isUrgentState(row.state);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => actions.onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          actions.onOpen(row);
        }
      }}
      className={cn(
        'group cursor-pointer overflow-hidden rounded-lg transition-colors duration-150',
        urgent ? URGENT_ROW[row.state] : 'hover:bg-muted/40',
        urgent && 'shadow-hairline'
      )}
    >
      <div className="grid grid-cols-[130px_minmax(140px,1fr)_140px_150px_56px_auto] items-center gap-3 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <StateDot state={row.state} />
          <span
            className={cn(
              'truncate text-[11px]',
              urgent
                ? cn(URGENT_TEXT[row.state], 'font-medium')
                : 'text-muted-foreground'
            )}
          >
            {FEED_STATE_LABEL[row.state]}
          </span>
        </span>

        <span
          className={cn(
            'truncate text-[13.5px]',
            urgent ? 'text-foreground font-medium' : 'text-foreground'
          )}
        >
          {row.title}
        </span>

        <span className="dense-meta truncate">{row.epicTitle ?? ''}</span>
        <span className="dense-meta truncate">{row.activity ?? ''}</span>
        <span className="dense-meta text-right">
          {formatRelativeTimeFromIso(row.since)}
        </span>

        <span className="flex justify-end gap-1.5">
          {/* A question has no yes/no to answer from here — the answer is free text, and the
              form for it lives on the run's own Session tab. */}
          {row.waitingOn === 'question' && (
            <RowButton
              tone="urgent-waiting"
              onClick={() => actions.onOpen(row)}
            >
              Answer
            </RowButton>
          )}
          {row.waitingOn === 'approval' && (
            <>
              <RowButton onClick={() => actions.onApprove(row, false)}>
                Deny
              </RowButton>
              <RowButton
                tone="urgent-waiting"
                onClick={() => actions.onApprove(row, true)}
              >
                Approve
              </RowButton>
            </>
          )}
          {row.state === 'failed' && (
            <>
              <RowButton onClick={() => actions.onOpen(row)}>
                Read the error
              </RowButton>
              <RowButton
                tone="urgent-failed"
                onClick={() => actions.onRetry(row)}
              >
                Retry
              </RowButton>
            </>
          )}
          {row.state === 'review' && (
            <RowButton onClick={() => actions.onReview(row)}>Review</RowButton>
          )}
          {row.state === 'landing' && (
            <RowButton onClick={() => actions.onCancelLanding(row)}>
              Cancel
            </RowButton>
          )}
        </span>
      </div>

      {row.attention !== null && (
        <div className="flex items-center gap-2 px-3 pb-2 pl-[142px]">
          {row.state === 'waiting' ? (
            <Hand className="text-state-waiting size-3.5 shrink-0" />
          ) : (
            <CircleAlert className="text-state-failed size-3.5 shrink-0" />
          )}
          <span
            className={cn('truncate text-[12.5px]', URGENT_TEXT[row.state])}
          >
            {row.attention.reason}
          </span>
          {row.attention.detail !== null && (
            <span className="dense-meta bg-muted rounded px-1.5 py-0.5">
              {row.attention.detail}
            </span>
          )}
        </div>
      )}

      {/* A working run has no honest completion fraction — the orchestrator does not know how
          far through a task an agent is — so this is deliberately indeterminate rather than a
          number derived from turn count, which would look like measurement. */}
      {row.state === 'working' && (
        <ProgressTrack value={null} label={`${row.title} in progress`} />
      )}
    </div>
  );
}
