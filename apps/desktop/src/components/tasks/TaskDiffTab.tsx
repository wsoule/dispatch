import type { RunMeta } from '@dispatch/client';
import { FileX } from 'lucide-react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { isTerminalRunState } from '../../lib/runState';
import { RunDiffView } from '../runs/RunDiffView';
import { RunReviewView } from '../runs/RunReviewView';
import { EmptyState } from '@/ui/chrome';
import { Skeleton } from '@/ui/skeleton';

export interface TaskDiffTabProps {
  data: DispatchProjectData;
  selectedRun: RunMeta | undefined;
  /** Jumps to the Pull requests tab — see `RunsView`'s identical prop. */
  onViewPr: (runId: string) => void;
}

// A muted centered placeholder for the Diff tab when there's nothing to review yet — mirrors
// RunsView's local DiffEmptyState.
function DiffEmptyState({ message }: { message: string }) {
  return (
    <EmptyState
      icon={FileX}
      message={message}
      className="h-full justify-center p-0 [&_[data-slot=empty-description]]:text-[13px]"
    />
  );
}

/** The task view's Diff tab: the selected run's diff/review surface, wired exactly like
 * RunsView's Diff tab, with an empty state before any run exists and a skeleton while the
 * selected run's detail is still loading. */
export function TaskDiffTab({ data, selectedRun, onViewPr }: TaskDiffTabProps) {
  if (selectedRun === undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DiffEmptyState message="No session yet — dispatch the task to get a diff." />
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
        />
      )}
    </div>
  );
}
