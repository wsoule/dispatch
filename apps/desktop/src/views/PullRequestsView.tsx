import { ChevronLeft, ExternalLink, GitPullRequest } from 'lucide-react';

import { PrReviewPanel } from '../components/runs/PrReviewPanel';
import { RunDiffView } from '../components/runs/RunDiffView';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
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

/**
 * Top-level Pull requests destination — a run's GitHub PR is reviewed here, not buried inside
 * the Runs split view. Deliberately flat: a full-width list of the project's open PRs, and when
 * you pick one, a single full-width detail (a back link, the diff, then the review panel)
 * stacked vertically — no second sidebar, no nested tabs. The diff is the shared RunDiffView
 * (@pierre), the review the shared PrReviewPanel; this view only owns the list + the framing.
 */
export function PullRequestsView({
  data,
  selectedRunId,
  onSelectRun,
  onCloseRun,
}: PullRequestsViewProps) {
  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  // Every run that has opened a PR, newest first. A run keeps its `prUrl` after the PR merges
  // (it gains `reviewedAt` too), so merged PRs stay listed rather than vanishing.
  const prRuns = data.runs
    .filter((r) => r.prUrl !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const selected =
    selectedRunId !== null
      ? prRuns.find((r) => r.id === selectedRunId)
      : undefined;

  if (selected !== undefined) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCloseRun}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[13px]"
          >
            <ChevronLeft className="size-4" />
            Pull requests
          </button>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-foreground min-w-0 truncate text-[13px] font-medium">
            {selected.taskTitle}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
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
      {prRuns.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <GitPullRequest className="size-6" />
          <p className="text-[13px]">
            No open pull requests. Open one from a finished run&rsquo;s Diff
            tab.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {prRuns.map((run) => {
            const merged = run.reviewedAt !== undefined;
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
      )}
    </div>
  );
}
