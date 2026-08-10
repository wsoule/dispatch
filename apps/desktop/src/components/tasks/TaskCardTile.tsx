import type { RunMeta, RunState } from '@dispatch/client';
import type { TaskDoc, UpdatePatch } from '@dispatch/core/browser';
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { formatRelativeTimeFromIso } from '../../lib/format';
import { resolveCardKeyAction } from '../../lib/keyboard';
import { colorForEpic } from '../../lib/projectColor';
import { MergeLadderDot } from '../runs/MergeLadderDot';
import {
  AssigneeControl,
  PriorityControl,
  StatusControl,
} from './PropertyControls';
import {
  runStateColorClass,
  RunStateIcon,
  runStateLabel,
} from './RunStateIcon';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';

// Drag wiring handed down from `TaskBoard`'s `@dnd-kit` sortable card — grouped into one
// optional prop rather than several loose ones so a card rendered outside the board (there
// isn't one today, but the type shouldn't assume there never will be) can simply omit it and
// render as a plain, non-draggable card.
interface CardDragProps {
  setNodeRef: (node: HTMLElement | null) => void;
  style: React.CSSProperties | undefined;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
}

interface TaskCardTileProps {
  doc: TaskDoc;
  ready: boolean;
  blocked: boolean;
  /** State of this task's live (non-terminal) run, if it has one. */
  liveRunState: RunState | undefined;
  /** This task's latest run, if any — feeds the card's merge-ladder dot. */
  run?: RunMeta;
  /** Title of this task's parent epic, resolved by the caller (`TaskBoard`/`TasksListView`
   * build an id->title map from the project's epic list) — lets the card render Linear's
   * `t-id › Epic title` breadcrumb without needing its own epic lookup. */
  epicTitle?: string;
  /** The project's configured status list, for the card's inline status picker. */
  statuses: string[];
  /** Changes this task's status inline from the card (optimistic, same path as drag-and-drop). */
  onStatusChange: (status: string) => void;
  /** Edits this task's priority/assignee inline from the card. */
  onEditTask: (patch: UpdatePatch) => void;
  onClick: () => void;
  /** Dispatches this task directly from the card without opening the peek panel first.
   * Omitted (no action rendered) for cards that aren't ready to start. */
  onDispatch?: () => Promise<void>;
  /** True when the Board's own j/k roving-focus cursor (see `BoardView`) is on this card —
   * moves real DOM focus onto the card so `:focus-visible` and screen readers agree with
   * what j/k just did, rather than a CSS-only highlight that looks focused but isn't. */
  focused?: boolean;
  /** Called whenever real DOM focus lands on this card (click, Tab, or the `focused` effect
   * above) — lets `BoardView` sync its `focusedTaskId` cursor to wherever focus actually is. */
  onFocus?: () => void;
  /** See `CardDragProps` — omitted for a card that isn't draggable. */
  drag?: CardDragProps;
  /** Task 9: true for an archived task shown via the "Archived" toggle — dims the card and
   * drops the drag affordance; `TaskBoard` also disables the drag itself and the underlying
   * `moveTaskStatus` call is gated centrally in `useDispatchProject`, so this is purely visual. */
  archived?: boolean;
  /** True when this task's latest run needs a human (see `deriveTaskAttentionById`) — tints
   * the card's border and background with the amber "waiting" tokens so it stands out on a
   * dense board without breaking the uniform card anatomy. */
  needsAttention?: boolean;
}

// Only shows the first few label pills before collapsing the rest into a "+N" — Linear's own
// row/card treatment never lets an unbounded label list crowd out the title.
const MAX_VISIBLE_LABELS = 2;

/**
 * A single Board card, redesigned to Linear's exact anatomy: a meta row (id, epic breadcrumb,
 * assignee), a title row (StatusIcon + title), a meta row (priority, labels, blocked, live-run
 * pulse), and a footer row ("Updated <relative>" plus a Dispatch action that only reveals on
 * hover/focus — never a persistent button, and no left accent edge; every card on the board
 * reads as visually uniform, matching Linear's calm density). Draggable via the optional
 * `drag` prop (see `TaskBoard`).
 */
export function TaskCardTile({
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
}: TaskCardTileProps) {
  const [dispatching, setDispatching] = useState(false);
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

  const visibleLabels = doc.meta.labels.slice(0, MAX_VISIBLE_LABELS);
  const hiddenLabelCount = doc.meta.labels.length - visibleLabels.length;

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
      data-focused={focused}
      className={cn(
        'group border-border/60 bg-card flex w-full cursor-pointer flex-col gap-2 rounded-lg border p-3 text-left shadow-sm transition-colors duration-150',
        'hover:border-border hover:bg-card/80',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'data-[focused=true]:border-ring/60 data-[focused=true]:ring-2 data-[focused=true]:ring-ring/40',
        drag?.isDragging === true && 'opacity-40',
        // The tint replaces both the resting and hover surfaces — flashing back to the
        // neutral card color on hover would read as the highlight switching off.
        needsAttention &&
          !archived &&
          'border-state-waiting-edge bg-state-waiting-surface hover:border-state-waiting-edge hover:bg-state-waiting-surface',
        archived && 'cursor-default opacity-55 saturate-50 hover:bg-card'
      )}
      onClick={onClick}
      onFocus={onFocus}
      onKeyDown={(e) => {
        const isDirectTarget = e.target === e.currentTarget;
        if (drag !== undefined && e.key === ' ' && isDirectTarget) {
          // Space belongs to @dnd-kit's keyboard sensor (pick up / move / drop) when this
          // card is draggable — Enter is still the "open peek" key below, so the two never
          // compete for the same keypress. `drag.listeners` was already spread onto this
          // element above, but that spread's own `onKeyDown` gets overwritten by this
          // explicit handler (later JSX props win) — forwarding to it manually here is what
          // keeps the keyboard sensor's Space behavior alive.
          drag.listeners?.onKeyDown?.(e);
          return;
        }
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
          // never reaches the Board's roving-focus track above.
          e.stopPropagation();
        }
      }}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1 text-[11px]">
          <span className="text-muted-foreground/60 shrink-0 font-mono tracking-tight">
            {doc.meta.id}
          </span>
          {epicTitle !== undefined && (
            <>
              <ChevronRight className="text-muted-foreground/40 size-3 shrink-0" />
              {/* Dot in the epic's own color, matching its swim-lane swatch — makes a card's
                  epic scannable in the flat board and list, where there's no lane heading to
                  group by. */}
              {doc.meta.parent !== undefined && (
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: colorForEpic(doc.meta.parent) }}
                />
              )}
              <span className="text-muted-foreground/80 min-w-0 truncate">
                {epicTitle}
              </span>
            </>
          )}
          {archived && (
            <Badge
              variant="outline"
              className="text-muted-foreground h-4 shrink-0 rounded px-1.5 py-0 text-[10px] font-normal"
            >
              Archived
            </Badge>
          )}
        </div>
        <AssigneeControl
          value={doc.meta.assignee}
          onChange={(a) => onEditTask({ assignee: a })}
        />
      </div>

      <div className="flex items-start gap-1.5">
        <span className="mt-px -ml-0.5 shrink-0">
          <StatusControl
            value={doc.meta.status}
            statuses={statuses}
            onChange={onStatusChange}
          />
        </span>
        {/* Merge-ladder dot: same affordance TasksListView/StackRail/TaskDetailDialog show. */}
        <MergeLadderDot meta={run} className="mt-1.5" />
        <span className="text-foreground line-clamp-2 text-[13.5px] leading-[1.35] font-medium">
          {doc.meta.title}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <PriorityControl
          value={doc.meta.priority}
          onChange={(p) => onEditTask({ priority: p })}
        />
        {blocked && (
          <span className="text-destructive inline-flex items-center gap-1 text-[11px]">
            <RunStateIcon state="blocked" className="size-3.5" />
            Blocked
          </span>
        )}
        {visibleLabels.map((label) => (
          <Badge
            key={label}
            variant="outline"
            className="text-muted-foreground h-4 rounded px-1.5 py-0 text-[10px] font-normal"
          >
            {label}
          </Badge>
        ))}
        {hiddenLabelCount > 0 && (
          <span className="text-muted-foreground/70 text-[10px]">
            +{hiddenLabelCount}
          </span>
        )}
        {liveRunState !== undefined && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 text-[11px] font-medium',
              runStateColorClass(liveRunState)
            )}
            title={runStateLabel(liveRunState)}
          >
            <RunStateIcon state={liveRunState} className="size-3.5" />
            {runStateLabel(liveRunState)}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground/60 shrink-0 text-[11px] whitespace-nowrap">
          {formatRelativeTimeFromIso(doc.meta.updated)}
        </span>
        {ready && onDispatch !== undefined && (
          <Button
            type="button"
            variant="ghost"
            disabled={dispatching}
            onClick={(e) => void dispatchNow(e)}
            className={cn(
              'h-auto gap-1 rounded-md px-1.5 py-0.5 has-[>svg]:px-1.5 text-[11px] font-medium text-muted-foreground opacity-0 transition-opacity duration-150',
              'hover:bg-primary/10 hover:text-primary',
              'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
              dispatching && 'pointer-events-none opacity-100'
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
}
