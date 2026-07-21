import { RunStatePill } from '../components/runs/RunStatePill';
import type { AllAgentsData } from '../hooks/useAllAgents';
import { colorForProject } from '../lib/projectColor';
import './AllAgentsView.css';

interface AllAgentsViewProps {
  data: AllAgentsData;
  onJumpToRun: (projectId: string, runId: string) => void;
}

/**
 * Global view: every live (non-terminal) run across every dispatch-enabled project at once —
 * "what are my agents doing right now", independent of which project happens to be active in
 * the primary nav. Clicking a row jumps straight to that project's Runs view with the run
 * already selected, the same destination the sidebar's per-project Runs item leads to.
 */
export function AllAgentsView({ data, onJumpToRun }: AllAgentsViewProps) {
  return (
    <div className="all-agents-view">
      <h1 className="view-topbar-title">All Agents</h1>

      {data.loading ? (
        <p className="all-agents-view-status">Checking every project…</p>
      ) : data.liveRuns.length === 0 ? (
        <p className="all-agents-view-status">
          No agents are running right now — dispatch a task from any
          project&rsquo;s Board to start one.
        </p>
      ) : (
        <div className="all-agents-view-list">
          {data.liveRuns.map(({ run, project }) => (
            <button
              key={run.id}
              type="button"
              className="all-agents-view-row"
              onClick={() => onJumpToRun(project.id, run.id)}
            >
              <span
                className="all-agents-view-row-dot"
                style={{ background: colorForProject(project.id) }}
              />
              <span className="all-agents-view-row-project">
                {project.name}
              </span>
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
