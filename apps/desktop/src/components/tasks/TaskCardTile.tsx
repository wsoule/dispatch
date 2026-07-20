import type { RunState } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';

import { priorityTone } from '../../lib/taskDisplay';
import { RunStatePill } from '../runs/RunStatePill';
import { Pill } from '../ui/Pill';
import './TaskCardTile.css';

interface TaskCardTileProps {
  doc: TaskDoc;
  ready: boolean;
  blocked: boolean;
  /** State of this task's live (non-terminal) run, if it has one — the "live-run indicator on
   * cards" the plan asks for. `undefined` when there's no live run. */
  liveRunState: RunState | undefined;
  onClick: () => void;
}

/** A single Tasks-board card: id (mono, dim), priority pill, title, and badges for anything
 * that changes how someone should treat the task — ready to start, blocked, or belonging to
 * an epic. Mirrors packages/web/src/components/TaskCard.tsx's information density, restyled
 * to Relay's tokens.css rather than web's theme.css (per the plan's "restyled native"
 * requirement). */
export function TaskCardTile({
  doc,
  ready,
  blocked,
  liveRunState,
  onClick,
}: TaskCardTileProps) {
  const tone = priorityTone(doc.meta.priority);

  return (
    <button
      type="button"
      className="task-card-tile"
      data-ready={ready}
      onClick={onClick}
    >
      <div className="task-card-tile-top">
        <span className="task-card-tile-id">{doc.meta.id}</span>
        {liveRunState !== undefined && <RunStatePill state={liveRunState} />}
        {tone !== null && (
          <Pill variant="tag" tone={tone}>
            {doc.meta.priority}
          </Pill>
        )}
      </div>
      <div className="task-card-tile-title">{doc.meta.title}</div>
      {(blocked || doc.meta.parent !== null) && (
        <div className="task-card-tile-meta">
          {blocked && (
            <Pill variant="tag" tone="red">
              blocked
            </Pill>
          )}
          {doc.meta.parent !== null && (
            <Pill variant="tag" tone="gray">
              {doc.meta.parent}
            </Pill>
          )}
        </div>
      )}
    </button>
  );
}
