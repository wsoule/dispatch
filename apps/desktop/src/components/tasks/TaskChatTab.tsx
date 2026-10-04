import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { MessageSquare } from 'lucide-react';
import { useMemo } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { RunQuestion } from '../../lib/gates';
import type { PendingApproval } from '../../lib/pendingApprovals';
import {
  askRunIdsForChat,
  newestScopeRequestOf,
  questionsOfRuns,
} from '../../lib/taskAsks';
import { RunLogView } from '../runs/RunLogView';
import { useShellActions } from '../shell/ShellActionsContext';
import { TabSkeleton } from './TabSkeleton';
import { EmptyState } from '@/ui/chrome';

// Shared empty arrays so a run with nothing open keeps the same prop identity
// across renders.
const NO_QUESTIONS: RunQuestion[] = [];
const NO_APPROVALS: PendingApproval[] = [];

export interface TaskChatTabProps {
  data: DispatchProjectData;
  doc: TaskDoc;
  selectedRun: RunMeta | undefined;
  onDispatch: () => void;
}

/** The task view's Chat tab: the selected run's transcript and composer, the surface the
 * retired Runs page hosted as its Session tab. It shows an empty state before any run exists
 * and a skeleton while the selected run's detail is still loading. */
export function TaskChatTab({
  data,
  doc,
  selectedRun,
  onDispatch,
}: TaskChatTabProps) {
  const { openThread } = useShellActions();
  // The selected run's open asks plus those of the task's ended execute runs,
  // which stay open for the task whatever run is shown.
  const askRunIds = useMemo(
    () =>
      selectedRun === undefined ? [] : askRunIdsForChat(data.runs, selectedRun),
    [data.runs, selectedRun]
  );
  const questions = useMemo(() => {
    const asked = questionsOfRuns(data.openQuestions, askRunIds);
    return asked.length === 0 ? NO_QUESTIONS : asked;
  }, [data.openQuestions, askRunIds]);
  const scopeRequest = newestScopeRequestOf(
    data.pendingScopeRequests,
    askRunIds
  );

  if (selectedRun === undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EmptyState
          icon={MessageSquare}
          heading="No session yet"
          description="No agent has worked this task yet. Dispatch it to open a session here."
          className="h-full justify-center"
          // `d` dispatches from anywhere on the task page (TaskPage's key handler).
          primary={
            data.readyIds.has(doc.meta.id)
              ? { label: 'Dispatch', onClick: onDispatch, hint: 'D' }
              : undefined
          }
        />
      </div>
    );
  }

  if (
    data.runDetail === undefined ||
    data.runDetail.meta.id !== selectedRun.id
  ) {
    return <TabSkeleton />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RunLogView
        meta={data.runDetail.meta}
        entries={data.runDetail.entries}
        pendingApprovals={
          data.pendingApprovals.get(selectedRun.id) ?? NO_APPROVALS
        }
        onApprove={(requestId, allow, opts) =>
          data.handleApprove(selectedRun.id, requestId, allow, opts)
        }
        onLoadApprovalInput={(requestId) =>
          data.fetchApprovalInput(selectedRun.id, requestId)
        }
        onSendMessage={(text) => data.handleSendMessage(selectedRun.id, text)}
        openQuestions={questions}
        onAnswerQuestion={(questionId, answer) =>
          data.handleAnswerQuestion(
            questions.find((q) => q.id === questionId)?.runId ?? selectedRun.id,
            questionId,
            answer
          )
        }
        pendingScopeRequest={scopeRequest}
        onDecideScopeRequest={(granted) =>
          // Null means it closed since this render: nothing to send.
          scopeRequest === null
            ? Promise.resolve()
            : data.handleDecideScopeRequest(
                scopeRequest.runId,
                scopeRequest.id,
                granted
              )
        }
        scopeDecide={data.scopeDecide}
        onRestartDaemon={data.handleRestartDaemon}
        onRequestChanges={(text) =>
          data.handleRequestChanges(selectedRun.id, text)
        }
        onOpenMessage={data.messageAccess.canMessage ? openThread : null}
        me={data.me}
        readsAllThreads={data.messageAccess.canDecide}
      />
    </div>
  );
}
