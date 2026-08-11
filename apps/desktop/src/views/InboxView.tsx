import type { ApiClient } from '@dispatch/client';
import { Inbox as InboxIcon } from 'lucide-react';

import type { ReviewQueueItem } from '../components/runs/ReviewQueue';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { TaskTab } from '../lib/appNav';
import type { FeedState } from '../lib/feedState';
import { formatRelativeTimeFromIso } from '../lib/format';
import type { InboxData } from '../lib/inboxQueue';
import { reviewTargetKey } from '../lib/reviewTarget';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome/SectionLabel';
import { StateDot } from '@/ui/chrome/StateDot';
import { Skeleton } from '@/ui/skeleton';

interface InboxViewProps {
  /** The two lists this view renders — see `buildInbox`. */
  data: InboxData;
  portLoading: boolean;
  portError: boolean;
  portErrorDetail: unknown;
  client: ApiClient | null;
  onRetry: () => void;
  /** Opens the full task view on a given tab, pinned to one run —
   * `openTaskView` from App.tsx. */
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
}

/**
 * A slim, list-only page of what's waiting on a human: runs stalled on an
 * approval or a question, and everything the Review page's queue already
 * flags as needing a look. Composed entirely from `buildInbox` — this view
 * never re-derives which runs belong here.
 */
export function InboxView({
  data,
  portLoading,
  portError,
  portErrorDetail,
  client,
  onRetry,
  onOpenTask,
}: InboxViewProps) {
  if (portLoading) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="view-topbar-title">Inbox</h1>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
    );
  }

  if (portError || client === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="view-topbar-title">Inbox</h1>
        <DaemonUnavailable
          starting={false}
          errorDetail={portErrorDetail}
          onRetry={onRetry}
        />
      </div>
    );
  }

  const { review, waiting } = data;
  const empty = review.length === 0 && waiting.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <div className="flex items-baseline gap-2">
        <h1 className="view-topbar-title">Inbox</h1>
        <span className="text-muted-foreground text-[12px]">
          Everything waiting on a human, in one list.
        </span>
      </div>

      {empty ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <InboxIcon className="text-muted-foreground size-5" />
          <p className="text-muted-foreground max-w-sm text-[13px]">
            Nothing waiting on you.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {waiting.length > 0 && (
            <section>
              <SectionLabel rule count={waiting.length}>
                Waiting on you
              </SectionLabel>
              <div className="mt-1.5 flex flex-col gap-0.5">
                {waiting.map((run) => (
                  <Row
                    key={run.id}
                    title={run.taskTitle}
                    state="waiting"
                    updatedAt={run.updatedAt}
                    onClick={() => onOpenTask(run.taskId, 'chat', run.id)}
                  />
                ))}
              </div>
            </section>
          )}
          {review.length > 0 && (
            <section>
              <SectionLabel rule count={review.length}>
                Needs review
              </SectionLabel>
              <div className="mt-1.5 flex flex-col gap-0.5">
                {review.map((item) => (
                  <ReviewRow
                    key={reviewTargetKey(item.target)}
                    item={item}
                    onOpenTask={onOpenTask}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One `review` entry. A run-backed entry (a finished run, or a PR dispatch
 * itself opened) routes to that task's diff. A standalone repo PR has no
 * local task to open — the Review page's PR mode is the only surface that
 * can show it today, and nav state for opening it there lives only inside
 * `ReviewView` (Task 6 moves it here), so the row is a title-only affordance
 * rather than a dead click.
 */
function ReviewRow({
  item,
  onOpenTask,
}: {
  item: ReviewQueueItem;
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
}) {
  if (item.target.kind === 'run' && item.run !== undefined) {
    const run = item.run;
    return (
      <Row
        title={item.title}
        state="review"
        updatedAt={item.updatedAt}
        onClick={() => onOpenTask(run.taskId, 'diff', run.id)}
      />
    );
  }

  return (
    <Row
      title={item.title}
      state="review"
      updatedAt={item.updatedAt}
      disabledTitle="Open from the Review page for now"
    />
  );
}

function Row({
  title,
  state,
  updatedAt,
  onClick,
  disabledTitle,
}: {
  title: string;
  state: FeedState;
  updatedAt: string;
  onClick?: () => void;
  disabledTitle?: string;
}) {
  const content = (
    <>
      <StateDot state={state} />
      <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      <span className="dense-meta shrink-0">
        {formatRelativeTimeFromIso(updatedAt)}
      </span>
    </>
  );

  if (onClick === undefined) {
    return (
      <div
        title={disabledTitle}
        className="text-muted-foreground/70 flex items-center gap-2 rounded-md px-2 py-1.5"
      >
        {content}
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn(
        'h-auto w-full justify-start gap-2 rounded-md border border-transparent px-2 py-1.5 font-normal text-left',
        'hover:bg-muted/60'
      )}
    >
      {content}
    </Button>
  );
}
