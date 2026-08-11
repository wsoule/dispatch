import { Inbox as InboxIcon } from 'lucide-react';

import type { ReviewQueueItem } from '../components/runs/ReviewQueue';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskTab } from '../lib/appNav';
import type { FeedState } from '../lib/feedState';
import { formatRelativeTimeFromIso } from '../lib/format';
import type { InboxData } from '../lib/inboxQueue';
import { reviewTargetKey } from '../lib/reviewTarget';
import { LandingView } from './LandingView';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome/SectionLabel';
import { StateDot } from '@/ui/chrome/StateDot';
import { Skeleton } from '@/ui/skeleton';

interface InboxViewProps {
  /** The two lists this view renders — see `buildInbox`. */
  data: InboxData;
  /** The whole project, for the merge queue below the lists. */
  project: DispatchProjectData;
  /** Opens the full task view on a given tab, pinned to one run —
   * `openTaskView` from App.tsx. */
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  /** Opens the full-window review page for one repo pull request. */
  onOpenPr: (number: number) => void;
}

/**
 * A slim, list-only page of what's waiting on a human: runs stalled on an
 * approval or a question, and everything `buildReviewQueue` flags as needing a
 * look. Composed entirely from `buildInbox` — this view never re-derives which
 * runs belong here.
 *
 * The merge queue sits underneath, because approving from here is what puts
 * things in it — as its own destination it split one flow across two screens
 * you had to remember to check.
 */
export function InboxView({
  data,
  project,
  onOpenTask,
  onOpenPr,
}: InboxViewProps) {
  const {
    portLoading,
    portError,
    portErrorDetail,
    client,
    retryEnsureDispatchd: onRetry,
  } = project;

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
                    onOpenPr={onOpenPr}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* `shrink-0`: LandingView now sizes to its own content, but this container's flex
          items can otherwise still be squeezed by the flex algorithm — pin it so the queue
          scrolls with the two lists above instead of getting compressed. */}
      <div className="shrink-0">
        <LandingView
          data={project}
          onOpenRun={(runId) => {
            const run = project.runs.find((r) => r.id === runId);
            if (run !== undefined) onOpenTask(run.taskId, 'diff', run.id);
          }}
        />
      </div>
    </div>
  );
}

/**
 * One `review` entry. A run-backed entry (a finished run, or a PR dispatch
 * itself opened) routes to that task's diff; a standalone repo PR, which has
 * no local task, opens the full-window PR review page.
 */
function ReviewRow({
  item,
  onOpenTask,
  onOpenPr,
}: {
  item: ReviewQueueItem;
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  onOpenPr: (number: number) => void;
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

  const target = item.target;
  return (
    <Row
      title={item.title}
      state="review"
      updatedAt={item.updatedAt}
      onClick={target.kind === 'pr' ? () => onOpenPr(target.number) : undefined}
    />
  );
}

function Row({
  title,
  state,
  updatedAt,
  onClick,
}: {
  title: string;
  state: FeedState;
  updatedAt: string;
  onClick?: () => void;
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

  // A review entry whose run has since gone away still belongs on the list,
  // but there is nothing left to open.
  if (onClick === undefined) {
    return (
      <div className="text-muted-foreground/70 flex items-center gap-2 rounded-md px-2 py-1.5">
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
