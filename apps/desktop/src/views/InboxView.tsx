import { GitMerge, Inbox as InboxIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ReviewQueueItem } from '../components/runs/ReviewQueue';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskTab } from '../lib/appNav';
import type { FeedState } from '../lib/feedState';
import { formatRelativeTimeFromIso } from '../lib/format';
import type { InboxData } from '../lib/inboxQueue';
import { latestAttemptFailedRunIds } from '../lib/queueHistory';
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

  // Runs whose latest merge-queue attempt failed. A needs-review row for one of these
  // carries a "verify failed" badge, so this list and the queue history below tell one
  // story instead of two. A run back in the live queue is exempt — its pending attempt,
  // not the old failure, is its story. Cheap to derive inline: history is capped at 20
  // server-side.
  const verifyFailed = latestAttemptFailedRunIds(
    project.mergeQueue?.history ?? []
  );
  const queued = new Set(
    (project.mergeQueue?.entries ?? []).map((e) => e.runId)
  );

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
              <SectionLabel
                rule
                count={review.length}
                trailing={
                  review.some((i) => i.target.kind === 'run') ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void project.handleMergeAllReady()}
                      title="Queue every ready run for the merge queue — each still runs verify before landing"
                    >
                      <GitMerge className="size-3" />
                      Queue all for merge
                    </Button>
                  ) : undefined
                }
              >
                Needs review
              </SectionLabel>
              <div className="mt-1.5 flex flex-col gap-0.5">
                {review.map((item) => (
                  <ReviewRow
                    key={reviewTargetKey(item.target)}
                    item={item}
                    verifyFailed={
                      item.target.kind === 'run' &&
                      item.run !== undefined &&
                      verifyFailed.has(item.run.id) &&
                      !queued.has(item.run.id)
                    }
                    onOpenTask={onOpenTask}
                    onOpenPr={onOpenPr}
                    onQueueMerge={(runId) =>
                      void project.handleEnqueueMerge(runId)
                    }
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
  verifyFailed = false,
  onOpenTask,
  onOpenPr,
  onQueueMerge,
}: {
  item: ReviewQueueItem;
  /** The run's latest merge-queue attempt failed — badge the row so the review list
   * and the queue history below it agree. */
  verifyFailed?: boolean;
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  onOpenPr: (number: number) => void;
  /** Queues one run for the merge queue without opening it first. */
  onQueueMerge?: (runId: string) => void;
}) {
  if (item.target.kind === 'run' && item.run !== undefined) {
    const run = item.run;
    return (
      <Row
        title={item.title}
        state="review"
        updatedAt={item.updatedAt}
        badge={
          verifyFailed ? (
            <span className="bg-state-failed-surface text-state-failed shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none">
              verify failed
            </span>
          ) : undefined
        }
        onClick={() => onOpenTask(run.taskId, 'diff', run.id)}
        action={
          onQueueMerge !== undefined ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => onQueueMerge(run.id)}
              aria-label={`Queue merge: ${item.title}`}
              title="Queue this run for merge"
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <GitMerge className="size-3.5" />
            </Button>
          ) : undefined
        }
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
  action,
  badge,
}: {
  title: string;
  state: FeedState;
  updatedAt: string;
  onClick?: () => void;
  /** A trailing control rendered as the row button's sibling, never nested
   * inside it — nested buttons are invalid markup and swallow clicks. */
  action?: ReactNode;
  /** A small status tag rendered right after the title (e.g. "verify failed"). */
  badge?: ReactNode;
}) {
  const content = (
    <>
      <StateDot state={state} />
      <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      {badge}
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

  const row = (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn(
        'h-auto w-full justify-start gap-2 rounded-md border border-transparent px-2 py-1.5 font-normal text-left',
        'hover:bg-muted/60',
        action !== undefined && 'flex-1'
      )}
    >
      {content}
    </Button>
  );
  if (action === undefined) return row;
  return (
    <div className="flex items-center gap-1">
      {row}
      {action}
    </div>
  );
}
