import { CircleAlert, Hand } from 'lucide-react';
import type { ReactNode } from 'react';

import type { FeedRowModel } from '@/lib/controlRoom';
import type { FeedState } from '@/lib/feedState';
import { FEED_STATE_LABEL, isUrgentState } from '@/lib/feedState';
import { formatRelativeTimeFromIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { ProgressTrack } from '@/ui/chrome/ProgressTrack';
import { StateDot } from '@/ui/chrome/StateDot';

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
    <Button
      type="button"
      variant="ghost"
      size="xs"
      // Every action sits inside a clickable row, so each one has to stop the click from also
      // opening the row behind it. Approving should not navigate away.
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'shadow-hairline ease-out-expo rounded-chip h-auto px-2 py-1 text-[12px] font-normal whitespace-nowrap transition-colors duration-100',
        // Ghost's own hover bg/text are neutralized so only the row's own tones move.
        'hover:bg-surface-hover-strong dark:hover:bg-surface-hover-strong',
        tone === 'urgent-waiting' &&
          'text-state-waiting hover:text-state-waiting',
        tone === 'urgent-failed' && 'text-state-failed hover:text-state-failed',
        tone === undefined && 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </Button>
  );
}

export interface FeedRowActions {
  onOpen: (row: FeedRowModel) => void;
  onApprove: (row: FeedRowModel, allow: boolean) => void;
  onRetry: (row: FeedRowModel) => void;
  onReview: (row: FeedRowModel) => void;
  onCancelLanding: (row: FeedRowModel) => void;
  /** Caps the task's fix loop where it stands — offered while it is actively
   * implementing or reviewing. */
  onStopFixLoop: (row: FeedRowModel) => void;
}

/** Whether the row's loop is actually running rounds — the only time a Stop
 * button has anything to stop. */
function fixLoopActive(row: FeedRowModel): boolean {
  return (
    row.fixLoop !== null &&
    (row.fixLoop.state === 'implementing' || row.fixLoop.state === 'reviewing')
  );
}

/** The activity cell's loop phrasing: "Fix round 2/5 · reviewing" beats the
 * generic turn count whenever a loop owns the task. */
function fixLoopActivity(row: FeedRowModel): string | null {
  if (row.fixLoop === null) return null;
  if (!fixLoopActive(row)) return null;
  return `Fix round ${row.fixLoop.round}/${row.fixLoop.cap} · ${row.fixLoop.state}`;
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
        'group/row ease-out-expo rounded-control cursor-pointer overflow-hidden transition-colors duration-100',
        urgent ? URGENT_ROW[row.state] : 'hover:bg-surface-hover',
        urgent && 'shadow-hairline'
      )}
    >
      <div className="grid grid-cols-[130px_minmax(140px,1fr)_140px_150px_56px_auto] items-center gap-3 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <StateDot state={row.state} size="md" />
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
        <span className="dense-meta truncate">
          {fixLoopActivity(row) ?? row.activity ?? ''}
        </span>
        <span className="dense-meta text-right">
          {formatRelativeTimeFromIso(row.since)}
        </span>

        <span className="flex justify-end gap-1.5">
          {/* A question's answer is free text, so it can only be given on the Session tab. */}
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
          {fixLoopActive(row) && (
            <RowButton onClick={() => actions.onStopFixLoop(row)}>
              Stop loop
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
            <span className="dense-meta bg-surface-inset rounded-chip px-1.5 py-0.5 font-mono">
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
