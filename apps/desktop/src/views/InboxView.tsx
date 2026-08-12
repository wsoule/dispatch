import type { RunMeta, RunQuestion } from '@dispatch/client';
import { GitMerge, Inbox as InboxIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { QuestionCard } from '../components/runs/QuestionCard';
import type { ReviewQueueItem } from '../components/runs/ReviewQueue';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
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
  /** The whole project: the daemon-availability states this view renders
   * before either list, and the merge-queue actions on the review rows. */
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
 * runs belong here. Queueing a merge is offered inline, so approving never
 * costs a navigation.
 *
 * Deliberately only the two lists: what is landing, and what already landed,
 * is the Landing table's job — one destination for it rather than a second,
 * partial copy of the queue under this one.
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
              <div className="mt-1.5 flex flex-col gap-2">
                {waiting.map((run) => (
                  <WaitingRow
                    key={run.id}
                    run={run}
                    question={firstOpenQuestion(
                      project.openQuestions?.get(run.id)
                    )}
                    onOpenTask={onOpenTask}
                    onAnswerQuestion={(questionId, answer) =>
                      project.handleAnswerQuestion(run.id, questionId, answer)
                    }
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
    </div>
  );
}

// The question a `WaitingRow` should surface as an `ApprovalCard`-backed
// `QuestionCard`: the oldest still-unanswered one, or — if every question the
// map holds already carries an answer (a stale render between the answer
// landing and the run leaving `waiting`) — the first of those, so the row
// never silently drops back to the plain state mid-transition.
function firstOpenQuestion(
  questions: RunQuestion[] | undefined
): RunQuestion | undefined {
  if (questions === undefined || questions.length === 0) return undefined;
  return questions.find((q) => q.answer === null) ?? questions[0];
}

/**
 * One `waiting` run. A run blocked on an agent's question renders the actual
 * question — `QuestionCard` (built on the `ApprovalCard` primitive) — right
 * in the list, so answering never costs a navigation; a run only waiting on
 * an approval gate (no question data available in bulk here — see
 * `RunLogView`'s own `ApprovalCard`/`ScopeRequestCard` for that, which need a
 * live per-run fetch this list doesn't do) falls back to the plain dense row.
 */
function WaitingRow({
  run,
  question,
  onOpenTask,
  onAnswerQuestion,
}: {
  run: RunMeta;
  question: RunQuestion | undefined;
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  onAnswerQuestion: (questionId: string, answer: string) => Promise<void>;
}) {
  if (question === undefined) {
    return (
      <Row
        title={run.taskTitle}
        state="waiting"
        updatedAt={run.updatedAt}
        onClick={() => onOpenTask(run.taskId, 'chat', run.id)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => onOpenTask(run.taskId, 'chat', run.id)}
        className="ease-out-expo text-muted-foreground hover:text-foreground flex items-center gap-2 self-start px-0.5 text-left text-[12px] transition-colors duration-100"
      >
        <span className="max-w-xs truncate">{run.taskTitle}</span>
        <span className="dense-meta">
          {formatRelativeTimeFromIso(run.updatedAt)}
        </span>
      </button>
      <QuestionCard
        question={question.question}
        options={question.options}
        askedAt={question.askedAt}
        onAnswer={(answer) => onAnswerQuestion(question.id, answer)}
      />
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
  onQueueMerge,
}: {
  item: ReviewQueueItem;
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
}: {
  title: string;
  state: FeedState;
  updatedAt: string;
  onClick?: () => void;
  /** A trailing control rendered as the row button's sibling, never nested
   * inside it — nested buttons are invalid markup and swallow clicks. */
  action?: ReactNode;
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
      <div className="text-muted-foreground/70 rounded-control flex items-center gap-2.5 px-3 py-2">
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
        'ease-out-expo h-auto w-full justify-start gap-2.5 rounded-control border border-transparent px-3 py-2 font-normal text-left transition-colors duration-100',
        'hover:bg-surface-hover',
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
