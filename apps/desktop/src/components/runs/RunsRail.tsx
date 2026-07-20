import type { RunMeta } from '@dispatch/client';

import { RunStatePill } from './RunStatePill';
import './RunsRail.css';

interface RunsRailProps {
  runs: RunMeta[];
  onSelect: (runId: string) => void;
}

/** Horizontal strip of every run dispatchd knows about for this project (live + recent,
 * newest first — the same order `GET /api/runs` returns), each showing its task, state, and
 * cost once known. Sits above the Tasks board so a dispatched run stays visible without
 * leaving the tab. Empty per the plan's "no runs yet" empty state. */
export function RunsRail({ runs, onSelect }: RunsRailProps) {
  return (
    <div className="runs-rail">
      <div className="runs-rail-title">Runs</div>
      {runs.length === 0 ? (
        <p className="runs-rail-empty">
          No runs yet — dispatch a ready task to start one.
        </p>
      ) : (
        <div className="runs-rail-list">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className="runs-rail-item"
              onClick={() => onSelect(run.id)}
            >
              <span className="runs-rail-item-title">{run.taskTitle}</span>
              <div className="runs-rail-item-meta">
                <RunStatePill state={run.state} />
                {run.costUsd !== undefined && (
                  <span className="runs-rail-item-cost">
                    ${run.costUsd.toFixed(2)}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
