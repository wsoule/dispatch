import type { RunMeta, RunQuestion } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { MousePointerClick } from 'lucide-react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useScopeRequest } from '../../hooks/useScopeRequest';
import { isTerminalRunState } from '../../lib/runState';
import { RunLogView } from '../runs/RunLogView';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { Skeleton } from '@/ui/skeleton';

// Shared empty array so a run with no open questions keeps the same prop
// identity across renders — mirrors RunsView's NO_QUESTIONS.
const NO_QUESTIONS: RunQuestion[] = [];

export interface TaskChatTabProps {
  data: DispatchProjectData;
  doc: TaskDoc;
  selectedRun: RunMeta | undefined;
  onDispatch: () => void;
}

/** The task view's Chat tab: the selected run's transcript, wired exactly like RunsView's
 * Session tab, with an empty state before any run exists and a skeleton while the selected
 * run's detail is still loading. */
export function TaskChatTab({
  data,
  doc,
  selectedRun,
  onDispatch,
}: TaskChatTabProps) {
  const selectedId = selectedRun?.id;
  // Read once and reused below for both the fetch and the decide call, so the
  // two can never disagree about which request is pending.
  const scopeRequestId =
    selectedId !== undefined
      ? data.pendingScopeRequests.get(selectedId)?.requestId
      : undefined;
  // The WS event only carries the id — this fetches the paths/reason.
  const { request: pendingScopeRequest } = useScopeRequest(
    data.client,
    data.port,
    selectedId,
    scopeRequestId
  );

  if (selectedRun === undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EmptyState
          icon={MousePointerClick}
          message="No agent has worked this task yet."
          className="h-full justify-center p-0 [&_[data-slot=empty-description]]:text-[13px]"
          action={
            data.readyIds.has(doc.meta.id) ? (
              <Button size="sm" onClick={onDispatch}>
                Dispatch
              </Button>
            ) : undefined
          }
        />
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
      <RunLogView
        meta={data.runDetail.meta}
        entries={data.runDetail.entries}
        pendingApproval={data.pendingApprovals.get(selectedRun.id) ?? null}
        onApprove={(requestId, allow, opts) =>
          data.handleApprove(selectedRun.id, requestId, allow, opts)
        }
        onSendMessage={(text) => data.handleSendMessage(selectedRun.id, text)}
        openQuestions={
          // Terminal check as well as the list: a dropped socket must not
          // leave a dead run still asking for an answer.
          isTerminalRunState(selectedRun.state)
            ? NO_QUESTIONS
            : (data.openQuestions.get(selectedRun.id) ?? NO_QUESTIONS)
        }
        onAnswerQuestion={(questionId, answer) =>
          data.handleAnswerQuestion(selectedRun.id, questionId, answer)
        }
        pendingScopeRequest={
          isTerminalRunState(selectedRun.state) ? null : pendingScopeRequest
        }
        onDecideScopeRequest={(granted) =>
          // Undefined means it raced closed — nothing to send.
          scopeRequestId === undefined
            ? Promise.resolve()
            : data.handleDecideScopeRequest(
                selectedRun.id,
                scopeRequestId,
                granted
              )
        }
        scopeDecide={data.scopeDecide}
        onRestartDaemon={data.handleRestartDaemon}
        onRequestChanges={(text) =>
          data.handleRequestChanges(selectedRun.id, text)
        }
      />
    </div>
  );
}
