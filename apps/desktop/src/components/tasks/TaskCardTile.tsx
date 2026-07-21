import type { RunState } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';
import { useEffect, useRef, useState } from 'react';

import { resolveCardKeyAction } from '../../lib/keyboard';
import { priorityTone } from '../../lib/taskDisplay';
import { RunStatePill } from '../runs/RunStatePill';
import { Pill } from '../ui/Pill';
import './TaskCardTile.css';

interface TaskCardTileProps {
  doc: TaskDoc;
  ready: boolean;
  blocked: boolean;
  /** State of this task's live (non-terminal) run, if it has one. */
  liveRunState: RunState | undefined;
  onClick: () => void;
  /** Dispatches this task directly from the card without opening the peek panel first — the
   * redesign brief's "ready-lane... inline Dispatch action". Omitted (no button rendered)
   * for cards that aren't ready to start. */
  onDispatch?: () => Promise<void>;
  /** True when the Board's own j/k roving-focus cursor (see `BoardView`) is on this card —
   * moves real DOM focus onto the card so `:focus-visible` and screen readers agree with
   * what j/k just did, rather than a CSS-only highlight that looks focused but isn't. */
  focused?: boolean;
  /** Called whenever real DOM focus lands on this card (click, Tab, or the `focused` effect
   * above) — lets `BoardView` sync its `focusedTaskId` cursor to wherever focus actually is,
   * so it can never diverge from what Enter would open. */
  onFocus?: () => void;
}

/** A single Board card: id (mono), a live-run pulse when an agent is actively on it,
 * priority pill, title, and badges for labels/epic-membership/blocked-status. Ready-to-start
 * cards get the accent left-border-and-tint treatment plus an inline Dispatch button so
 * starting the next unit of work never requires opening the peek panel first. */
export function TaskCardTile({
  doc,
  ready,
  blocked,
  liveRunState,
  onClick,
  onDispatch,
  focused = false,
  onFocus,
}: TaskCardTileProps) {
  const [dispatching, setDispatching] = useState(false);
  const tone = priorityTone(doc.meta.priority);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) cardRef.current?.focus();
  }, [focused]);

  async function dispatchNow(e: React.MouseEvent) {
    e.stopPropagation();
    if (onDispatch === undefined) return;
    setDispatching(true);
    try {
      await onDispatch();
    } finally {
      setDispatching(false);
    }
  }

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      className="task-card-tile"
      data-ready={ready}
      onClick={onClick}
      onFocus={onFocus}
      onKeyDown={(e) => {
        const isDirectTarget = e.target === e.currentTarget;
        if (resolveCardKeyAction(e.key, isDirectTarget) === 'activate') {
          // Space's native behavior on a focusable div is to scroll the page — this is a
          // button-role element, so Space should activate it, not scroll past it.
          e.preventDefault();
          onClick();
          return;
        }
        if (!isDirectTarget) {
          // This keydown originated on a nested interactive child — the inline Dispatch
          // button below — which owns its own Enter/Space activation. Stop it here so it
          // never reaches the Board's roving-focus track above, which would otherwise treat
          // it as board-level j/k/Enter navigation.
          e.stopPropagation();
        }
      }}
    >
      <div className="task-card-tile-top">
        <span className="task-card-tile-id">{doc.meta.id}</span>
        {liveRunState !== undefined && (
          <span className="task-card-tile-live">
            <span className="task-card-tile-live-pulse" />
            <RunStatePill state={liveRunState} />
          </span>
        )}
        {tone !== null && (
          <Pill variant="tag" tone={tone}>
            {doc.meta.priority}
          </Pill>
        )}
      </div>
      <div className="task-card-tile-title">{doc.meta.title}</div>
      {(blocked || doc.meta.parent !== null || doc.meta.labels.length > 0) && (
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
          {doc.meta.labels.map((label) => (
            <Pill key={label} variant="tag" tone="accent">
              {label}
            </Pill>
          ))}
        </div>
      )}
      {ready && onDispatch !== undefined && (
        <button
          type="button"
          className="task-card-tile-dispatch"
          disabled={dispatching}
          onClick={(e) => void dispatchNow(e)}
        >
          {dispatching ? 'Dispatching…' : 'Dispatch →'}
        </button>
      )}
    </div>
  );
}
