import type { ApiClient, RunMeta } from '@dispatch/client';

import { RunStatePill } from '../components/runs/RunStatePill';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import './AllAgentsView.css';

interface AllAgentsViewProps {
  /** Every non-terminal run for this project, newest-first — see `App.tsx`'s `liveRuns`
   * memo, computed once from `useDispatchProject`'s own run list rather than a separate
   * cross-project fan-out (the old `useAllAgents`, which `ensure_dispatchd`'d a sidecar per
   * dispatch-enabled project it could find). There's only one project now, so this is just
   * that project's live runs. */
  liveRuns: RunMeta[];
  portLoading: boolean;
  portError: boolean;
  portErrorDetail: unknown;
  client: ApiClient | null;
  onRetry: () => void;
  onJumpToRun: (runId: string) => void;
}

/**
 * "What is this project's agent doing right now" — every live (non-terminal) run for the
 * active project, independent of which primary nav view (Board/Tasks/Runs/Plans) happens to
 * be showing. Clicking a row jumps straight to the Runs view with that run already selected.
 */
export function AllAgentsView({
  liveRuns,
  portLoading,
  portError,
  portErrorDetail,
  client,
  onRetry,
  onJumpToRun,
}: AllAgentsViewProps) {
  if (portLoading || portError || client === null) {
    return (
      <div className="all-agents-view">
        <h1 className="view-topbar-title">All Agents</h1>
        <DaemonUnavailable
          starting={portLoading}
          errorDetail={portErrorDetail}
          onRetry={onRetry}
        />
      </div>
    );
  }

  return (
    <div className="all-agents-view">
      <h1 className="view-topbar-title">All Agents</h1>

      {liveRuns.length === 0 ? (
        <p className="all-agents-view-status">
          No agents are running right now — dispatch a task from the Board to
          start one.
        </p>
      ) : (
        <div className="all-agents-view-list">
          {liveRuns.map((run) => (
            <button
              key={run.id}
              type="button"
              className="all-agents-view-row"
              onClick={() => onJumpToRun(run.id)}
            >
              <span className="all-agents-view-row-task">{run.taskTitle}</span>
              <RunStatePill state={run.state} />
              {run.costUsd !== undefined && (
                <span className="all-agents-view-row-cost">
                  ${run.costUsd.toFixed(2)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
