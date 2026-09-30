import { SquareTerminal } from 'lucide-react';
import { useMemo } from 'react';

import { useRunDetail } from '../../../hooks/useRunData';
import type { RunQuestion } from '../../../lib/gates';
import type { PendingApproval } from '../../../lib/pendingApprovals';
import { deriveStopControl, isTerminalRunState } from '../../../lib/runState';
import {
  askRunIdsForChat,
  newestScopeRequestOf,
  questionsOfRuns,
} from '../../../lib/taskAsks';
import { RunLogView } from '../../runs/RunLogView';
import { useShellActions } from '../../shell/ShellActionsContext';
import { TabSkeleton } from '../TabSkeleton';
import type { TaskPageModel } from './pageModel';
import { FilesTouched, RunStrip } from './RunStrip';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';

// Shared so a run with nothing open keeps one prop identity across renders.
const NO_QUESTIONS: RunQuestion[] = [];
const NO_APPROVALS: PendingApproval[] = [];

/**
 * Run mode — an agent at work: the run's vitals (state, model, a ticking clock, spend,
 * turns) with Stop and Cancel while it is live, the files it has touched, then its
 * transcript streaming in with approvals, questions and scope requests inline (an ended
 * run's stay answerable), message links to their threads, and the message box at the
 * foot to steer it (or, once it has finished, to request changes).
 */
export function RunMode({ page }: { page: TaskPageModel }) {
  const { project } = page;
  const run = page.selectedRun;
  const runId = run?.id ?? null;
  const detail = useRunDetail(project.client, project.port, runId);
  const { openThread } = useShellActions();
  // The run's open asks plus those of the task's ended execute runs, which stay
  // open for the task whatever run is shown.
  const askRunIds = useMemo(
    () => (run === undefined ? [] : askRunIdsForChat(project.runs, run)),
    [project.runs, run]
  );
  const questions = useMemo(() => {
    const asked = questionsOfRuns(project.openQuestions, askRunIds);
    return asked.length === 0 ? NO_QUESTIONS : asked;
  }, [project.openQuestions, askRunIds]);
  const scopeRequest = newestScopeRequestOf(
    project.pendingScopeRequests,
    askRunIds
  );

  if (run === undefined) {
    return (
      <EmptyState
        icon={SquareTerminal}
        heading="No agent has worked this yet"
        description="Dispatch it from the spec, and its run streams in here."
        className="h-full justify-center"
        primary={{ label: 'Open spec', onClick: () => page.selectMode('spec') }}
      />
    );
  }

  // The detail carries the freshest meta once loaded; the run list's is instant.
  const meta = detail?.meta.id === run.id ? detail.meta : run;
  const terminal = isTerminalRunState(meta.state);
  const stop = deriveStopControl(meta);

  return (
    <div data-slot="run-mode" className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 flex-col gap-1.5">
        <RunStrip
          run={meta}
          runs={page.allRuns}
          onSelectRun={page.selectRun}
          actions={
            stop.showButtons ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={stop.stopDisabled}
                  onClick={() => void project.handleStopRun(meta.id)}
                >
                  {stop.stopLabel}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="hover:text-state-failed"
                  onClick={() => void project.handleCancelRun(meta.id)}
                >
                  Cancel
                </Button>
              </>
            ) : terminal && meta.state === 'finished' ? (
              <Button size="sm" onClick={() => page.selectMode('review')}>
                Review
              </Button>
            ) : undefined
          }
        />
        <FilesTouched files={meta.claims ?? []} />
      </div>
      {detail === undefined || detail.meta.id !== run.id ? (
        <TabSkeleton />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <RunLogView
            meta={detail.meta}
            entries={detail.entries}
            pendingApprovals={
              project.pendingApprovals.get(run.id) ?? NO_APPROVALS
            }
            onApprove={(requestId, allow, opts) =>
              project.handleApprove(run.id, requestId, allow, opts)
            }
            onLoadApprovalInput={(requestId) =>
              project.fetchApprovalInput(run.id, requestId)
            }
            onSendMessage={(text) => project.handleSendMessage(run.id, text)}
            openQuestions={questions}
            onAnswerQuestion={(questionId, answer) =>
              project.handleAnswerQuestion(
                questions.find((q) => q.id === questionId)?.runId ?? run.id,
                questionId,
                answer
              )
            }
            pendingScopeRequest={scopeRequest}
            onDecideScopeRequest={(granted) =>
              // Null means it closed since this render: nothing to send.
              scopeRequest === null
                ? Promise.resolve()
                : project.handleDecideScopeRequest(
                    scopeRequest.runId,
                    scopeRequest.id,
                    granted
                  )
            }
            scopeDecide={project.scopeDecide}
            onRestartDaemon={project.handleRestartDaemon}
            onRequestChanges={(text) =>
              project.handleRequestChanges(run.id, text)
            }
            onOpenMessage={project.messageAccess.canMessage ? openThread : null}
            me={project.me}
            readsAllThreads={project.messageAccess.canDecide}
          />
        </div>
      )}
    </div>
  );
}
