import type { TaskListItem, UpdatePatch } from '@dispatch-foo/core/browser';
import type {
  MergeQueueEntryState,
  ReadinessReading,
  RunMeta,
  RunState,
} from '@dispatch/client';
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { ArrowRight } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';

import { readinessBadges } from '../../lib/judgmentBadges';
import { resolveCardKeyAction } from '../../lib/keyboard';
import { colorForLabel } from '../../lib/labelColor';
import { formatCreated } from '../../lib/taskDates';
import { TASK_PROPERTIES, type TaskProperty } from '../../lib/tasksPrefs';
import { MergeLadderPill } from '../runs/MergeLadderDot';
import { RunStatePill } from '../runs/RunStatePill';
import { LandingBadge } from './LandingBadge';
import {
  AssigneeControl,
  LabelsControl,
  PriorityControl,
  StatusControl,
} from './PropertyControls';
import { cn } from '@/lib/utils';
import { LabelPill, Pill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';

// Drag wiring handed down from `TaskBoard`'s `@dnd-kit` draggable card — grouped into one
// optional prop rather than several loose ones so a card rendered outside the board (the drag
// overlay, a test) can simply omit it and render as a plain, non-draggable card.
interface CardDragProps {
  setNodeRef: (node: HTMLElement | null) => void;
  style: React.CSSProperties | undefined;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
}

interface TaskCardTileProps {
  doc: TaskListItem;
  ready: boolean;
  blocked: boolean;
  /** State of this task's live (non-terminal) run, if it has one. */
  liveRunState: RunState | undefined;
  /** This task's latest run, if any — feeds the run-state mark and the merge-ladder pill. */
  run?: RunMeta;
  /** Title of this task's parent epic, resolved by the caller — the ` › Epic` crumb on row 1.
   * Omitted on a board grouped by epic, where the lane header already names it. */
  epicTitle?: string;
  /** The project's configured status list, for the card's inline status picker. */
  statuses: string[];
  // Callbacks take the task id so a board can hand every card the same stable functions.
  /** Changes this task's status inline from the card (optimistic, same path as drag-and-drop). */
  onStatusChange: (id: string, status: string) => void;
  /** Edits this task's priority/assignee/labels inline from the card. */
  onEditTask: (id: string, patch: UpdatePatch) => void;
  onClick: (id: string) => void;
  /** Dispatches this task directly from the card. Omitted (no action rendered) for cards that
   * aren't ready to start. */
  onDispatch?: (id: string) => Promise<void>;
  /** True when the Board's own j/k roving-focus cursor (see `BoardView`) is on this card —
   * moves real DOM focus onto the card so `:focus-visible` and screen readers agree with
   * what j/k just did. */
  focused?: boolean;
  /** Called whenever real DOM focus lands on this card (click, Tab, or the `focused` effect
   * above) — lets `BoardView` sync its `focusedTaskId` cursor to wherever focus actually is. */
  onFocus?: (id: string) => void;
  /** See `CardDragProps` — omitted for a card that isn't draggable. */
  drag?: CardDragProps;
  /** True for an archived task shown via Display › Show archived — dims the card and drops the
   * pickers; `TaskBoard` also disables the drag itself. */
  archived?: boolean;
  /** True when this task's latest run needs a human (see `deriveTaskAttentionById`) — a
   * `Needs you` pill on row 3, never a tinted card. */
  needsAttention?: boolean;
  /** Where the task's run stands in the merge queue, while it is landing — a `Landing` pill
   * on row 3. */
  landing?: MergeQueueEntryState;
  /** Which properties the card shows (Display › Display properties). Defaults to all. */
  properties?: ReadonlySet<TaskProperty>;
  /** The daemon's readiness reading for this task, when judged — a thin spec
   * or a likely split shows as a pill beside the labels. */
  readiness?: ReadinessReading;
  /** Every label the project uses — the vocabulary the label pills' picker offers. */
  labelCatalogue?: readonly string[];
}

// Only shows the first few label pills before collapsing the rest into a "+N" — Linear's own
// row/card treatment never lets an unbounded label list crowd out the title.
const MAX_VISIBLE_LABELS = 2;

const ALL_PROPERTIES: ReadonlySet<TaskProperty> = new Set(TASK_PROPERTIES);

/**
 * A Board card on Linear's four-row anatomy (§5): row 1 the id and ` › Epic` crumb with the
 * assignee avatar pushed right; row 2 the status glyph and a two-line title; row 3 the
 * priority glyph and the pills (labels, blocked, `Needs you`, `Landing`, live run mark, merge
 * ladder);
 * row 4 `Created Sep 13` with the Dispatch action on the right. Every card is the same
 * 322px `#1b1a1a` tile with a half-pixel ring — no coloured edge, no state tint; the
 * keyboard cursor and hover are neutral. Draggable via the optional `drag` prop.
 */
export const TaskCardTile = memo(function TaskCardTile({
  doc,
  ready,
  blocked,
  liveRunState,
  run,
  epicTitle,
  statuses,
  onStatusChange,
  onEditTask,
  onClick,
  onDispatch,
  focused = false,
  onFocus,
  drag,
  archived = false,
  needsAttention = false,
  landing,
  properties = ALL_PROPERTIES,
  readiness,
  labelCatalogue = [],
}: TaskCardTileProps) {
  const id = doc.meta.id;
  const [dispatching, setDispatching] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const has = (p: TaskProperty) => properties.has(p);

  useEffect(() => {
    if (focused) cardRef.current?.focus();
  }, [focused]);

  async function dispatchNow(e: React.MouseEvent) {
    e.stopPropagation();
    if (onDispatch === undefined) return;
    setDispatching(true);
    try {
      await onDispatch(id);
    } finally {
      setDispatching(false);
    }
  }

  const visibleLabels = has('labels')
    ? doc.meta.labels.slice(0, MAX_VISIBLE_LABELS)
    : [];
  const hiddenLabelCount = has('labels')
    ? doc.meta.labels.length - visibleLabels.length
    : 0;
  const showCrumb = has('epic') && epicTitle !== undefined;

  return (
    <div
      ref={(node) => {
        cardRef.current = node;
        drag?.setNodeRef(node);
      }}
      style={drag?.style}
      {...drag?.attributes}
      {...drag?.listeners}
      role="button"
      tabIndex={0}
      data-slot="task-card"
      data-focused={focused}
      className={cn(
        'group bg-surface-quaternary rounded-card shadow-card flex w-[322px] max-w-full cursor-pointer flex-col gap-1.5 p-3 text-left transition-[background-color,box-shadow] duration-100',
        // 3% of the text colour into the card surface: a lift in dark, a dip in light.
        'hover:bg-[color-mix(in_srgb,var(--surface-quaternary),var(--text-primary)_3%)]',
        'focus-visible:shadow-raised focus-visible:outline-none',
        'data-[focused=true]:shadow-raised',
        drag?.isDragging === true && 'opacity-40',
        archived && 'cursor-default opacity-55 hover:bg-surface-quaternary'
      )}
      onClick={() => onClick(id)}
      onFocus={onFocus === undefined ? undefined : () => onFocus(id)}
      onKeyDown={(e) => {
        const isDirectTarget = e.target === e.currentTarget;
        if (drag !== undefined && e.key === ' ' && isDirectTarget) {
          // Space belongs to @dnd-kit's keyboard sensor (pick up / move / drop) when this
          // card is draggable — Enter is still the "open" key below. `drag.listeners` was
          // spread onto this element above, but that spread's own `onKeyDown` is overwritten
          // by this handler, so the sensor's Space is forwarded by hand.
          drag.listeners?.onKeyDown?.(e);
          return;
        }
        if (resolveCardKeyAction(e.key, isDirectTarget) === 'activate') {
          e.preventDefault();
          onClick(id);
          return;
        }
        if (!isDirectTarget) {
          // A keydown from a nested control (a picker, the Dispatch button) owns its own
          // Enter/Space; stop it before it reaches the Board's roving-focus track.
          e.stopPropagation();
        }
      }}
    >
      <div
        data-slot="task-card-meta"
        className="font-book text-muted-foreground flex min-h-[18px] min-w-0 items-center gap-1 text-[12px]"
      >
        {has('id') && <span className="shrink-0">{doc.meta.id}</span>}
        {showCrumb && (
          <>
            <span aria-hidden className="shrink-0">
              ›
            </span>
            <span
              data-slot="task-card-crumb"
              className="min-w-0 truncate"
              title={epicTitle}
            >
              {epicTitle}
            </span>
          </>
        )}
        {has('assignee') && (
          <span className="ml-auto flex shrink-0 items-center">
            <AssigneeControl
              value={doc.meta.assignee}
              onChange={(a) => onEditTask(id, { assignee: a })}
            />
          </span>
        )}
      </div>

      <div data-slot="task-card-title" className="flex items-start gap-1.5">
        {has('status') && (
          <span className="mt-px -ml-0.5 shrink-0">
            <StatusControl
              value={doc.meta.status}
              statuses={statuses}
              onChange={(status) => onStatusChange(id, status)}
            />
          </span>
        )}
        <span className="text-foreground line-clamp-2 text-[13px] leading-5 font-medium">
          {doc.meta.title}
        </span>
      </div>

      <div
        data-slot="task-card-pills"
        className="flex flex-wrap items-center gap-1.5"
      >
        {has('priority') && (
          <span className="-ml-0.5 shrink-0">
            <PriorityControl
              value={doc.meta.priority}
              onChange={(p) => onEditTask(id, { priority: p })}
            />
          </span>
        )}
        {blocked && (
          <LabelPill color="var(--status-blocked)">Blocked</LabelPill>
        )}
        {needsAttention && !archived && (
          <LabelPill color="var(--state-waiting-fg)">Needs you</LabelPill>
        )}
        {/* The label pills are the face of the labels picker (click a pill to change the
            labels); the `+N` overflow stays outside it. An archived card shows plain pills. */}
        {visibleLabels.length > 0 &&
          (archived ? (
            visibleLabels.map((label) => (
              <LabelPill key={label} color={colorForLabel(label)}>
                {label}
              </LabelPill>
            ))
          ) : (
            <LabelsControl
              variant="inline"
              value={doc.meta.labels}
              candidates={labelCatalogue}
              onChange={(labels) => onEditTask(id, { labels })}
            >
              {visibleLabels.map((label) => (
                <LabelPill key={label} color={colorForLabel(label)}>
                  {label}
                </LabelPill>
              ))}
            </LabelsControl>
          ))}
        {hiddenLabelCount > 0 && (
          <Pill className="text-muted-foreground">+{hiddenLabelCount}</Pill>
        )}
        {readinessBadges(readiness).map((badge) => (
          <LabelPill key={badge} color="var(--state-waiting-fg)">
            {badge}
          </LabelPill>
        ))}
        {has('run') && landing !== undefined && !archived && (
          <LandingBadge state={landing} />
        )}
        {has('run') && liveRunState !== undefined && run !== undefined && (
          <RunStatePill meta={run} compact />
        )}
        {has('run') && <MergeLadderPill meta={run} />}
        {archived && <Pill className="text-muted-foreground">Archived</Pill>}
      </div>

      {/* The footer is the card's fixed `Created` line (Linear's row 4); the Created/Updated
          property chips govern the list's date column, not this. */}
      <div
        data-slot="task-card-footer"
        className="font-book text-muted-foreground flex min-h-6 items-center justify-between gap-2 text-[12px]"
      >
        <span className="shrink-0 whitespace-nowrap">
          {formatCreated(doc.meta.created)}
        </span>
        {ready && onDispatch !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={dispatching}
            onClick={(e) => void dispatchNow(e)}
            className={cn(
              '-my-1 -mr-1.5 text-[12px] font-medium',
              dispatching && 'pointer-events-none'
            )}
          >
            {dispatching ? (
              <>
                <Spinner className="size-3" />
                Dispatching
              </>
            ) : (
              <>
                Dispatch
                <ArrowRight className="size-3" />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
});
