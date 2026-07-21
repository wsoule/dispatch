import { RunLogView } from '../components/runs/RunLogView';
import { RunReviewView } from '../components/runs/RunReviewView';
import { RunStatePill } from '../components/runs/RunStatePill';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { isTerminalRunState } from '../lib/runState';
import './RunsView.css';

interface RunsViewProps {
  data: DispatchProjectData;
}

/**
 * Split layout per the redesign brief: every run for this project down the left (newest
 * first, state dot + task + ticking cost), the selected run's full surface on the right —
 * `RunLogView`'s chat-style log/approval-banner/follow-up-composer while live, or
 * `RunReviewView`'s Pierre diff + file tree + merge/discard/request-changes/PR once it's
 * finished — swapped in place on `meta.state`, exactly like the old `RunModal` did, just
 * inline in a page instead of inside a dialog.
 */
export function RunsView({ data }: RunsViewProps) {
  if (data.portLoading || data.tasksLoading) {
    return <p className="runs-view-status">Loading runs…</p>;
  }

  const selected = data.runs.find((r) => r.id === data.selectedRunId);

  return (
    <div className="runs-view">
      <h1 className="view-topbar-title">Runs</h1>
      <div className="runs-view-body">
        <div className="runs-view-list">
          {data.runs.length === 0 ? (
            <p className="runs-view-empty">
              No runs yet — dispatch a ready task from the Board to start one.
            </p>
          ) : (
            data.runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className={`runs-view-list-item${
                  run.id === data.selectedRunId ? ' active' : ''
                }`}
                onClick={() => data.setSelectedRunId(run.id)}
              >
                <RunStatePill state={run.state} />
                <span className="runs-view-list-item-title">
                  {run.taskTitle}
                </span>
                {run.costUsd !== undefined && (
                  <span className="runs-view-list-item-cost">
                    ${run.costUsd.toFixed(2)}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="runs-view-detail">
          {selected === undefined ? (
            <p className="runs-view-empty">
              Select a run on the left to see its log or review its result.
            </p>
          ) : data.runDetail === undefined ? (
            <p className="runs-view-empty">Loading run…</p>
          ) : isTerminalRunState(selected.state) ? (
            <RunReviewView
              meta={data.runDetail.meta}
              diff={data.diff}
              diffLoading={data.diffLoading}
              diffError={data.diffError}
              prCapability={data.health?.pr ?? false}
              onMerge={() => data.handleReview(selected.id, 'merge')}
              onDiscard={() => data.handleReview(selected.id, 'discard')}
              onRequestChanges={(text) =>
                data.handleRequestChanges(selected.id, text)
              }
              onOpenPr={() => data.handleOpenPr(selected.id)}
            />
          ) : (
            <RunLogView
              meta={data.runDetail.meta}
              entries={data.runDetail.entries}
              pendingApproval={data.pendingApprovals.get(selected.id) ?? null}
              onApprove={(requestId, allow) =>
                data.handleApprove(selected.id, requestId, allow)
              }
              onSendMessage={(text) =>
                data.handleSendMessage(selected.id, text)
              }
              onCancel={() => data.handleCancelRun(selected.id)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
