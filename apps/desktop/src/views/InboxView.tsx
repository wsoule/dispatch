import type { RepoPr, RunQuestion } from '@dispatch/client';
import { GitMerge, Inbox as InboxIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { QuestionCard } from '../components/runs/QuestionCard';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskTab } from '../lib/appNav';
import type { FeedRowModel } from '../lib/controlRoom';
import type { FeedState } from '../lib/feedState';
import { FEED_STATE_LABEL } from '../lib/feedState';
import { formatRelativeTimeFromIso } from '../lib/format';
import type { InboxData } from '../lib/inboxQueue';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome/SectionLabel';
import { StateMark } from '@/ui/chrome/state-mark';
import { Skeleton } from '@/ui/skeleton';

interface InboxViewProps {
  /** The urgent feed sections plus unclaimed PRs — see `buildInbox`. */
  data: InboxData;
  /** The whole project: daemon-availability states, the question map for
   * inline answering, and the merge-queue actions on review rows. */
  project: DispatchProjectData;
  /** Opens the full task view on a given tab, pinned to one run. */
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  /** Opens the full-window review page for one repo pull request. */
  onOpenPr: (number: number) => void;
}

/** Which task tab a row's click lands on: asks about the diff go to the diff;
 * everything else lands in the conversation. */
function tabFor(state: FeedState): TaskTab {
  return state === 'review' || state === 'ruling' ? 'diff' : 'chat';
}

/**
 * Everything waiting on a human — the Control room's urgent tiers re-surfaced as a to-do
 * list, one section per move. Built entirely from `buildInbox` (which feeds `buildFeed`),
 * so this page and the Control room can never disagree about what needs you: one row per
 * task, superseded review rounds deduped, failed runs and fix-loop rulings included.
 * Answering a question and queueing a merge stay inline, so acting never costs a
 * navigation.
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
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (portError || client === null) {
    return (
      <DaemonUnavailable
        starting={false}
        errorDetail={portErrorDetail}
        onRetry={onRetry}
      />
    );
  }

  if (data.total === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
        <InboxIcon className="text-muted-foreground size-5" />
        <p className="text-muted-foreground max-w-sm text-[13px]">
          Nothing waiting on you.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      {data.sections.map((section) => (
        <section key={section.state}>
          <SectionLabel
            rule
            count={section.rows.length}
            trailing={
              section.state === 'review' && section.rows.length > 1 ? (
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
            {FEED_STATE_LABEL[section.state]}
          </SectionLabel>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {section.rows.map((row) =>
              section.state === 'answer' ? (
                <AnswerRow
                  key={row.taskId}
                  row={row}
                  question={firstOpenQuestion(
                    project.openQuestions?.get(row.runId)
                  )}
                  onOpenTask={onOpenTask}
                  onAnswerQuestion={(questionId, answer) =>
                    project.handleAnswerQuestion(row.runId, questionId, answer)
                  }
                />
              ) : (
                <Row
                  key={row.taskId}
                  row={row}
                  onClick={() =>
                    onOpenTask(row.taskId, tabFor(row.state), row.runId)
                  }
                  action={
                    section.state === 'review' ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() =>
                          void project.handleEnqueueMerge(row.runId)
                        }
                        aria-label={`Queue merge: ${row.title}`}
                        title="Queue this run for merge"
                        className="text-muted-foreground hover:text-foreground shrink-0"
                      >
                        <GitMerge className="size-3.5" />
                      </Button>
                    ) : undefined
                  }
                />
              )
            )}
          </div>
        </section>
      ))}

      {data.prs.length > 0 && (
        <section>
          <SectionLabel rule count={data.prs.length}>
            Pull requests
          </SectionLabel>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {data.prs.map((pr) => (
              <PrRow key={pr.number} pr={pr} onOpenPr={onOpenPr} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// The question an `AnswerRow` surfaces inline: the oldest still-unanswered one, or — if
// every question already carries an answer (a stale render between the answer landing and
// the run leaving the feed) — the first of those, so the row never silently drops back to
// the plain state mid-transition.
function firstOpenQuestion(
  questions: RunQuestion[] | undefined
): RunQuestion | undefined {
  if (questions === undefined || questions.length === 0) return undefined;
  return questions.find((q) => q.answer === null) ?? questions[0];
}

/**
 * One answer-ask. The actual question renders inline — `QuestionCard` (built on the
 * `ApprovalCard` primitive) — so answering never costs a navigation; when the question
 * body hasn't arrived yet the row falls back to the plain dense row.
 */
function AnswerRow({
  row,
  question,
  onOpenTask,
  onAnswerQuestion,
}: {
  row: FeedRowModel;
  question: RunQuestion | undefined;
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  onAnswerQuestion: (questionId: string, answer: string) => Promise<void>;
}) {
  if (question === undefined) {
    return (
      <Row
        row={row}
        onClick={() => onOpenTask(row.taskId, 'chat', row.runId)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => onOpenTask(row.taskId, 'chat', row.runId)}
        className="ease-out-expo text-muted-foreground hover:text-foreground flex items-center gap-2 self-start px-0.5 text-left text-[12px] transition-colors duration-100"
      >
        <span className="max-w-xs truncate">{row.title}</span>
        <span className="dense-meta">
          {formatRelativeTimeFromIso(row.since)}
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

/** A standalone repo PR — no local run, so it opens the PR review page. */
function PrRow({
  pr,
  onOpenPr,
}: {
  pr: RepoPr;
  onOpenPr: (number: number) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onOpenPr(pr.number)}
      className="ease-out-expo hover:bg-surface-hover rounded-control h-auto w-full justify-start gap-2.5 px-3 py-2 text-left font-normal transition-colors duration-100"
    >
      <StateMark state="review" />
      <span className="min-w-0 flex-1 truncate text-[13px]">{pr.title}</span>
      <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
        #{pr.number}
      </span>
      <span className="dense-meta shrink-0">
        {formatRelativeTimeFromIso(pr.updatedAt)}
      </span>
    </Button>
  );
}

/**
 * One urgent feed row: the whose-move mark, the task, why it needs you (the feed's own
 * attention/activity line — "Wants to run Bash", "3 turns", the failure error), and when.
 */
function Row({
  row,
  onClick,
  action,
}: {
  row: FeedRowModel;
  onClick: () => void;
  /** A trailing control rendered as the row button's sibling, never nested
   * inside it — nested buttons are invalid markup and swallow clicks. */
  action?: ReactNode;
}) {
  const reason = row.attention?.reason ?? row.activity;
  const rowButton = (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn(
        'ease-out-expo h-auto w-full justify-start gap-2.5 rounded-control px-3 py-2 text-left font-normal transition-colors duration-100',
        'hover:bg-surface-hover',
        action !== undefined && 'flex-1'
      )}
    >
      <StateMark state={row.state} />
      <span className="min-w-0 truncate text-[13px]">{row.title}</span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12px]">
        {reason}
      </span>
      <span className="dense-meta shrink-0">
        {formatRelativeTimeFromIso(row.since)}
      </span>
    </Button>
  );
  if (action === undefined) return rowButton;
  return (
    <div className="flex items-center gap-1">
      {rowButton}
      {action}
    </div>
  );
}
