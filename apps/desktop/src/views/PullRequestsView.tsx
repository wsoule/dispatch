import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  MergeQueueSnapshot,
  RepoPr,
  RunMeta,
} from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';
import {
  ChevronLeft,
  ExternalLink,
  GitPullRequest,
  Loader2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PrReviewPanel } from '../components/runs/PrReviewPanel';
import { QueueMergeControl } from '../components/runs/QueueMergeControl';
import { RunDiffView } from '../components/runs/RunDiffView';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { StackBadge, StackRail } from '../components/tasks/StackRail';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import { cn } from '@/lib/utils';

interface PullRequestsViewProps {
  data: DispatchProjectData;
  /** The run whose PR is open, or `null` to show the list. Shared with Runs via nav's
   * `activeRunId` — a PR is just a run that has an open PR. */
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onCloseRun: () => void;
}

const QUEUE_STATE_LABEL: Record<MergeQueueEntryState, string> = {
  queued: 'Queued',
  'waiting-blockers': 'Waiting on blockers',
  rebasing: 'Rebasing',
  verifying: 'Verifying',
  merging: 'Merging',
  merged: 'Merged',
  failed: 'Failed',
};

// Color mapping the brief spells out exactly: queued=secondary, waiting-blockers=muted,
// rebasing/verifying/merging=primary (+ spinner), merged=emerald, failed=destructive.
const QUEUE_STATE_TONE: Record<MergeQueueEntryState, string> = {
  queued: 'border-border bg-secondary text-secondary-foreground',
  'waiting-blockers': 'border-border bg-muted/60 text-muted-foreground',
  rebasing: 'border-primary/30 bg-primary/10 text-primary',
  verifying: 'border-primary/30 bg-primary/10 text-primary',
  merging: 'border-primary/30 bg-primary/10 text-primary',
  merged:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
};

const ACTIVE_QUEUE_STATES = new Set<MergeQueueEntryState>([
  'rebasing',
  'verifying',
  'merging',
]);

/** A small state pill shared by the queue panel and each PR row's queue badge — one place owns
 * the state -> color/spinner mapping so both surfaces always agree. */
function MergeQueueStatePill({ state }: { state: MergeQueueEntryState }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        QUEUE_STATE_TONE[state]
      )}
    >
      {ACTIVE_QUEUE_STATES.has(state) && (
        <Loader2 className="size-3 animate-spin" />
      )}
      {QUEUE_STATE_LABEL[state]}
    </span>
  );
}

/**
 * The merge queue panel shown atop the PR list: ordered pending/active entries (position, task
 * title, state pill, a dequeue ✕ for anything not yet actively processing — mirrors the
 * server's own 409 on removing the active entry), then a short capped history underneath.
 * Renders nothing when the queue has never had an entry, so an unused merge queue doesn't add
 * permanent chrome to the page.
 *
 * `error`, when set, renders inline below the header — surfaces a dequeue that the server
 * rejected (e.g. a 409 because the entry became active between refetch and click) instead of
 * letting it fail silently. The caller clears it once a dequeue succeeds or the queue refetches.
 */
function MergeQueuePanel({
  mergeQueue,
  error,
  onDequeue,
}: {
  mergeQueue: MergeQueueSnapshot;
  error: string | null;
  onDequeue: (runId: string) => void;
}) {
  if (mergeQueue.entries.length === 0 && mergeQueue.history.length === 0) {
    return null;
  }

  return (
    <div className="border-border bg-muted/20 flex flex-col gap-2 rounded-md border p-3">
      <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        Merge queue
      </span>

      {error !== null && (
        <p className="text-destructive text-[11px]">{error}</p>
      )}

      {mergeQueue.entries.length === 0 ? (
        <p className="text-muted-foreground text-[12px]">Nothing queued.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {mergeQueue.entries.map((entry, i) => {
            const dequeueable =
              entry.state === 'queued' || entry.state === 'waiting-blockers';
            return (
              <div
                key={entry.runId}
                className="flex items-center gap-2 rounded-md px-1 py-1"
              >
                <span className="text-muted-foreground w-5 shrink-0 text-right font-mono text-[11px]">
                  {i + 1}
                </span>
                <span className="text-foreground min-w-0 flex-1 truncate text-[12px]">
                  {entry.taskTitle}
                </span>
                <MergeQueueStatePill state={entry.state} />
                {dequeueable && (
                  <button
                    type="button"
                    onClick={() => onDequeue(entry.runId)}
                    title="Remove from merge queue"
                    className="text-muted-foreground hover:text-destructive shrink-0"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {mergeQueue.history.length > 0 && (
        <div className="border-border/60 flex flex-col gap-1 border-t pt-2">
          <span className="text-muted-foreground/70 text-[10px] font-medium tracking-wide uppercase">
            History
          </span>
          {mergeQueue.history.slice(0, 5).map((entry) => (
            <div
              key={`${entry.runId}-${entry.finishedAt ?? entry.enqueuedAt}`}
              className="flex items-center gap-2 px-1 text-[11px]"
            >
              <span className="text-muted-foreground min-w-0 flex-1 truncate">
                {entry.taskTitle}
              </span>
              {entry.state === 'failed' && entry.reason !== undefined && (
                <span
                  className="text-destructive max-w-48 shrink truncate"
                  title={entry.reason}
                >
                  {entry.reason}
                </span>
              )}
              <MergeQueueStatePill state={entry.state} />
              {entry.finishedAt !== undefined && (
                <span className="text-muted-foreground/60 shrink-0">
                  {formatRelativeTimeFromIso(entry.finishedAt)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// A group of PR rows under one epic-grouping header — same shape/ordering rules as
// TasksListView's `EpicGroup`: known epics first (project order), then dangling parent ids,
// then a catch-all "No epic" bucket last.
interface PrEpicGroup {
  epicId: string | null;
  title: string;
  runs: RunMeta[];
}

/**
 * One row in the "Other open PRs" section — a repo PR dispatch never opened itself (no run's
 * `prUrl` matches it), so there's no run/stack/queue context to show, just what `gh pr list`
 * reports. v1 has no in-app detail for these (follow-up: fetch a `PrDetail` for an arbitrary
 * PR url, not just a run's own); the whole row is instead a plain external link out to GitHub.
 */
function OtherOpenPrRow({ pr }: { pr: RepoPr }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'group flex w-full items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left transition-colors duration-150',
        'hover:border-border hover:bg-muted/50'
      )}
    >
      <GitPullRequest className="size-4 shrink-0 text-emerald-500" />
      <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
        #{pr.number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-foreground truncate text-[13px] font-medium">
          {pr.title}
        </span>
        <span className="text-muted-foreground truncate font-mono text-[11px]">
          {pr.author} · {pr.headRefName}
        </span>
      </div>
      {pr.isDraft && (
        <span className="border-border bg-muted/60 text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium">
          Draft
        </span>
      )}
      <span className="text-muted-foreground/70 w-16 shrink-0 text-right text-[11px]">
        {formatRelativeTimeFromIso(pr.updatedAt)}
      </span>
      <ExternalLink className="text-muted-foreground group-hover:text-foreground size-3.5 shrink-0" />
    </a>
  );
}

/**
 * Top-level Pull requests destination — a run's GitHub PR is reviewed here, not buried inside
 * the Runs split view. A full-width list of the project's open PRs (grouped under epic headers,
 * each row carrying its stack position and merge-queue state), a merge-queue panel above it, and
 * — once you pick one — a single full-width detail (a back link, the stack rail, the diff, then
 * the review panel) stacked vertically. The diff is the shared RunDiffView (@pierre), the review
 * the shared PrReviewPanel; this view only owns the list + queue panel + framing.
 *
 * Below the dispatch-run rows, an "Other open PRs" section (item B) lists every open repo PR
 * `gh pr list` reports that no run's own `prUrl` already covers — plain external-link rows with
 * no in-app detail in v1 (see OtherOpenPrRow's own comment for the follow-up).
 */
export function PullRequestsView({
  data,
  selectedRunId,
  onSelectRun,
  onCloseRun,
}: PullRequestsViewProps) {
  // Every run that has opened a PR, newest first. A run keeps its `prUrl` after the PR merges
  // (it gains `reviewedAt` too), so merged PRs stay listed rather than vanishing. Built even
  // when the daemon isn't ready (data.runs is just `[]` then) so hook order below stays fixed
  // across the early daemon-unavailable return.
  const prRuns = useMemo(
    () =>
      data.runs
        .filter((r) => r.prUrl !== undefined)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [data.runs]
  );

  const taskById = useMemo(
    () => new Map(data.tasks.map((t: TaskDoc) => [t.meta.id, t])),
    [data.tasks]
  );

  // Item B: the "Other open PRs" section — every repo PR `gh pr list` reports whose url
  // doesn't match any dispatch run's own `prUrl` (those are already the rich rows above,
  // via `prRuns`/`groups`). `data.repoPrs` is `null` while loading or when this project has
  // no pr capability at all — either way there's nothing to add here.
  const dispatchPrUrls = useMemo(
    () =>
      new Set(
        prRuns.map((r) => r.prUrl).filter((u): u is string => u !== undefined)
      ),
    [prRuns]
  );
  const otherPrs = useMemo(
    () => (data.repoPrs ?? []).filter((pr) => !dispatchPrUrls.has(pr.url)),
    [data.repoPrs, dispatchPrUrls]
  );

  // One entry per run currently pending/active in the queue (never history — a row's pill only
  // ever reflects the queue's *live* state, the same "go refetch" semantics as everywhere else).
  const queueEntryByRunId = useMemo(() => {
    const map = new Map<string, MergeQueueEntry>();
    for (const entry of data.mergeQueue?.entries ?? []) {
      map.set(entry.runId, entry);
    }
    return map;
  }, [data.mergeQueue]);

  // Buckets every PR run under its task's parent epic id in one pass, in the same
  // known-epics-first / dangling-parent / no-epic order TasksListView uses.
  const groups = useMemo<PrEpicGroup[]>(() => {
    const byParent = new Map<string, RunMeta[]>();
    const noEpic: RunMeta[] = [];
    for (const run of prRuns) {
      const parent = taskById.get(run.taskId)?.meta.parent ?? null;
      if (parent === null) {
        noEpic.push(run);
        continue;
      }
      const bucket = byParent.get(parent);
      if (bucket !== undefined) bucket.push(run);
      else byParent.set(parent, [run]);
    }

    const result: PrEpicGroup[] = [];
    const seenParents = new Set<string>();
    for (const epic of data.epics) {
      const bucket = byParent.get(epic.meta.id);
      if (bucket === undefined) continue;
      seenParents.add(epic.meta.id);
      result.push({
        epicId: epic.meta.id,
        title: epic.meta.title,
        runs: bucket,
      });
    }
    for (const [parentId, bucket] of byParent) {
      if (seenParents.has(parentId)) continue;
      result.push({ epicId: parentId, title: parentId, runs: bucket });
    }
    if (noEpic.length > 0) {
      result.push({ epicId: null, title: 'No epic', runs: noEpic });
    }
    return result;
  }, [prRuns, taskById, data.epics]);

  // Dequeue can 409 (the entry became active between the last refetch and the click) — this
  // surfaces that inline in the queue panel instead of leaving it as an unhandled rejection, the
  // same catch-and-display pattern RunReviewView's own `run()` uses for its action row. Cleared
  // on a successful dequeue, and on every subsequent queue refetch (polled, WS-driven, or from
  // this same action) since a stale error stops applying the moment the snapshot moves on.
  const [dequeueError, setDequeueError] = useState<string | null>(null);
  useEffect(() => {
    setDequeueError(null);
  }, [data.mergeQueue]);

  const handleDequeue = useCallback(
    (runId: string) => {
      data
        .handleDequeueMerge(runId)
        .then(() => setDequeueError(null))
        .catch((err) => {
          setDequeueError(err instanceof Error ? err.message : String(err));
        });
    },
    [data]
  );

  // "Queue merge" action for the PR detail header — reuses the shared QueueMergeControl (also
  // used by RunReviewView's action row) rather than a second copy of the run -> queue-state
  // mapping, with the same busy/error handling RunReviewView's `run()` applies to its actions.
  const [queueMergeBusy, setQueueMergeBusy] = useState(false);
  const [queueMergeError, setQueueMergeError] = useState<string | null>(null);
  useEffect(() => {
    setQueueMergeError(null);
  }, [selectedRunId]);

  const handleQueueMerge = useCallback(
    (runId: string) => {
      setQueueMergeBusy(true);
      setQueueMergeError(null);
      data
        .handleEnqueueMerge(runId)
        .catch((err) => {
          setQueueMergeError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setQueueMergeBusy(false));
    },
    [data]
  );

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  const selected =
    selectedRunId !== null
      ? prRuns.find((r) => r.id === selectedRunId)
      : undefined;

  if (selected !== undefined) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={onCloseRun}
              className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-[13px]"
            >
              <ChevronLeft className="size-4" />
              Pull requests
            </button>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-foreground min-w-0 truncate text-[13px] font-medium">
              {selected.taskTitle}
            </span>
          </div>
          <QueueMergeControl
            meta={selected}
            mergeQueue={data.mergeQueue}
            busy={queueMergeBusy}
            onQueueMerge={() => handleQueueMerge(selected.id)}
          />
        </div>

        {queueMergeError !== null && (
          <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-[12px]">
            {queueMergeError}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <StackRail
            tasks={data.tasks}
            taskId={selected.taskId}
            latestRunByTaskId={data.latestRunByTaskId}
          />
          <RunDiffView
            diff={data.diff}
            diffLoading={data.diffLoading}
            diffError={data.diffError}
          />
          <PrReviewPanel
            detail={data.prDetail}
            loading={data.prDetailLoading}
            error={data.prDetailError}
            onReview={(event, body) =>
              data.handlePrReview(selected.id, event, body)
            }
            onComment={(body) => data.handlePrComment(selected.id, body)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <h1 className="view-topbar-title">Pull requests</h1>

      {data.mergeQueue !== null && (
        <MergeQueuePanel
          mergeQueue={data.mergeQueue}
          error={dequeueError}
          onDequeue={handleDequeue}
        />
      )}

      {prRuns.length === 0 && otherPrs.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <GitPullRequest className="size-6" />
          <p className="text-[13px]">
            No open pull requests. Open one from a finished run&rsquo;s Diff
            tab.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {groups.map((group) => (
            <div
              key={group.epicId ?? '__no-epic__'}
              className="flex flex-col gap-1"
            >
              <span className="text-muted-foreground px-1 text-[11px] font-medium tracking-wide uppercase">
                {group.title}
              </span>
              {group.runs.map((run) => {
                const merged = run.reviewedAt !== undefined;
                const queueEntry = queueEntryByRunId.get(run.id);
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => onSelectRun(run.id)}
                    className={cn(
                      'group flex w-full items-center gap-3 rounded-md border border-transparent px-3 py-2.5 text-left transition-colors duration-150',
                      'hover:border-border hover:bg-muted/50'
                    )}
                  >
                    <GitPullRequest
                      className={cn(
                        'size-4 shrink-0',
                        merged ? 'text-primary' : 'text-emerald-500'
                      )}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-foreground truncate text-[13px] font-medium">
                        {run.taskTitle}
                      </span>
                      <span className="text-muted-foreground truncate font-mono text-[11px]">
                        {run.branch}
                      </span>
                    </div>
                    <StackBadge tasks={data.tasks} taskId={run.taskId} />
                    {queueEntry !== undefined && (
                      <MergeQueueStatePill state={queueEntry.state} />
                    )}
                    <span
                      className={cn(
                        'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                        merged
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      )}
                    >
                      {merged ? 'merged' : 'open'}
                    </span>
                    {run.prUrl !== undefined && (
                      <a
                        href={run.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-foreground shrink-0"
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                    <span className="text-muted-foreground/70 w-16 shrink-0 text-right text-[11px]">
                      {formatRelativeTimeFromIso(run.updatedAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {otherPrs.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground px-1 text-[11px] font-medium tracking-wide uppercase">
                Other open PRs
              </span>
              {otherPrs.map((pr) => (
                <OtherOpenPrRow key={pr.url} pr={pr} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
