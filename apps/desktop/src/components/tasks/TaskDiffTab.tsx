import type { Finding, RunMeta } from '@dispatch/client';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useTaskFindings } from '../../hooks/useOrchestration';
import { isTerminalRunState, liveReviewAgentFor } from '../../lib/runState';
import { DiffEmptyState } from '../runs/DiffEmptyState';
import { RunDiffView } from '../runs/RunDiffView';
import { RunReviewView } from '../runs/RunReviewView';
import { Skeleton } from '@/ui/skeleton';

export interface TaskDiffTabProps {
  data: DispatchProjectData;
  selectedRun: RunMeta | undefined;
  /** Jumps to the Pull requests tab — see `RunsView`'s identical prop. */
  onViewPr: (runId: string) => void;
}

/** The task view's Diff tab: the selected run's diff/review surface, wired exactly like
 * RunsView's Diff tab, with an empty state before any run exists and a skeleton while the
 * selected run's detail is still loading. */
export function TaskDiffTab({ data, selectedRun, onViewPr }: TaskDiffTabProps) {
  // Called unconditionally, ahead of the early returns below, even though its result is only
  // used once a run is selected and terminal — `enabled` inside the hook itself already no-ops
  // when there's no task id yet.
  const { findings } = useTaskFindings(
    data.client,
    data.port,
    selectedRun?.taskId
  );

  if (selectedRun === undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DiffEmptyState message="No session yet. Dispatch the task to get a diff." />
      </div>
    );
  }

  if (
    data.runDetail === undefined ||
    data.runDetail.meta.id !== selectedRun.id
  ) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-col gap-3 p-1">
          <Skeleton className="h-6 w-48 rounded-md" />
          <Skeleton className="h-32 rounded-md" />
          <Skeleton className="h-32 rounded-md" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!isTerminalRunState(selectedRun.state) ? (
        <RunDiffView
          diff={data.diff}
          diffLoading={data.diffLoading}
          diffError={data.diffError}
        />
      ) : data.diffError !== null ? (
        <DiffEmptyState message="This run has no changes to review." />
      ) : (
        <RunReviewView
          client={data.client}
          meta={data.runDetail.meta}
          diff={data.diff}
          diffLoading={data.diffLoading}
          diffError={data.diffError}
          prCapability={data.health?.pr ?? false}
          mergeQueue={data.mergeQueue}
          tasks={data.tasksIncludingArchived}
          latestRunByTaskId={data.latestRunByTaskId}
          onMerge={() => data.handleReview(selectedRun.id, 'merge')}
          onDiscard={() => data.handleReview(selectedRun.id, 'discard')}
          onRequestChanges={(text) =>
            data.handleRequestChanges(selectedRun.id, text)
          }
          onOpenPr={() => data.handleOpenPr(selectedRun.id)}
          onViewPr={() => onViewPr(selectedRun.id)}
          onQueueMerge={() => data.handleEnqueueMerge(selectedRun.id)}
          onQueueStack={() => data.handleEnqueueMergeStack(selectedRun.taskId)}
          reviewComments={data.reviewComments}
          onAddComment={data.handleAddReviewComment}
          onResolveComment={data.handleResolveReviewComment}
          onReplyComment={data.handleReplyReviewComment}
          onApplySuggestion={data.handleApplySuggestion}
          onSubmitReview={data.handleSubmitReview}
          onStartAiReview={async () => {
            if (data.client === null) {
              throw new Error('The task daemon is not ready yet.');
            }
            await data.client.startReview(selectedRun.taskId, {
              base: selectedRun.baseBranch,
              head: selectedRun.branch,
              runId: selectedRun.id,
            });
          }}
          reviewAgentLive={
            liveReviewAgentFor(data.runs, selectedRun.branch) !== undefined
          }
          casePanel={{
            evidence: data.runDetail.evidence,
            mutations: data.runDetail.mutations,
            findings,
            // The ledger-entry filter ReviewView uses (taskLedgerEntries/useEpicLedger) depends
            // on epic plumbing this tab doesn't have wired yet — decisions stay empty here.
            decisions: [],
            onFixFindings:
              isTerminalRunState(selectedRun.state) &&
              selectedRun.reviewedAt === undefined
                ? (selected) =>
                    composeFixFindingsRequest(selected, (text) =>
                      data.handleRequestChanges(selectedRun.id, text)
                    )
                : undefined,
          }}
        />
      )}
    </div>
  );
}

// Resumes the run's own agent on its branch with the checked findings as the change
// request — the exact composition ReviewView's own handler used, before the case panel
// moved here.
async function composeFixFindingsRequest(
  selected: Finding[],
  requestChanges: (text: string) => Promise<void>
): Promise<void> {
  const lines = selected.map((f) => {
    const loc =
      f.file === null
        ? ''
        : ` (${f.file}${f.line === null ? '' : `:${f.line}`})`;
    return `- ${f.title}${loc}\n  ${f.detail}`;
  });
  await requestChanges(
    `Fix these review findings, then re-run the checks you'd normally run:\n\n${lines.join('\n')}`
  );
}
