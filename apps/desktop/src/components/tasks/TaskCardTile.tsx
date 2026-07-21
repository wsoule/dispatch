import type { RunState } from '@dispatch/client';
import type { Priority, TaskDoc } from '@dispatch/core';
import {
  ArrowRight,
  ChevronsUp,
  Loader2,
  type LucideIcon,
  Minus,
  SignalHigh,
  SignalLow,
  SignalMedium,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { resolveCardKeyAction } from '../../lib/keyboard';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';

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

/** One entry per `Priority` — icon + color + label, shared with `EpicCardTile` (both cards
 * show the same priority glyph). Every priority renders something (unlike the old Pill-based
 * treatment, which stayed silent below "high") since a single small icon costs far less
 * visual weight than a color-coded text chip did. */
const PRIORITY_ICON: Record<
  Priority,
  { Icon: LucideIcon; className: string; label: string }
> = {
  urgent: {
    Icon: ChevronsUp,
    className: 'text-destructive',
    label: 'Urgent priority',
  },
  high: {
    Icon: SignalHigh,
    className: 'text-amber-500 dark:text-amber-400',
    label: 'High priority',
  },
  medium: {
    Icon: SignalMedium,
    className: 'text-muted-foreground',
    label: 'Medium priority',
  },
  low: {
    Icon: SignalLow,
    className: 'text-muted-foreground/70',
    label: 'Low priority',
  },
  none: {
    Icon: Minus,
    className: 'text-muted-foreground/50',
    label: 'No priority',
  },
};

/** Small color-coded lucide glyph standing in for the old priority Pill — exported so
 * `EpicCardTile`'s header can show the exact same treatment. */
export function PriorityIcon({ priority }: { priority: Priority }) {
  const { Icon, className, label } = PRIORITY_ICON[priority];
  return (
    <span title={label} className="inline-flex shrink-0">
      <Icon className={cn('size-3.5 shrink-0', className)} aria-label={label} />
    </span>
  );
}

/** One dot color (+ accessible label) per `RunState` — stands in for the old `RunStatePill`
 * text badge on a card, per the redesign brief's "status = a small colored dot, not a text
 * pill." `RunStatePill` itself lives outside this worker's scope, so this is a small local
 * copy of just the color mapping rather than a shared export. */
const RUN_STATE_DOT: Record<RunState, { className: string; label: string }> = {
  provisioning: {
    className: 'bg-muted-foreground/60',
    label: 'Provisioning',
  },
  running: { className: 'bg-primary', label: 'Running' },
  'awaiting-approval': {
    className: 'bg-amber-500 dark:bg-amber-400',
    label: 'Awaiting approval',
  },
  finished: {
    className: 'bg-emerald-500 dark:bg-emerald-400',
    label: 'Finished',
  },
  failed: { className: 'bg-red-500 dark:bg-red-400', label: 'Failed' },
  cancelled: { className: 'bg-muted-foreground/60', label: 'Cancelled' },
};

/** A single Board card: id (mono), a live-run pulse when an agent is actively on it,
 * priority icon, title, and tiny chips for labels/epic-membership/blocked-status. Ready-to-
 * start cards get the accent left-border treatment plus an inline Dispatch action so starting
 * the next unit of work never requires opening the peek panel first. */
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

  const hasMeta =
    blocked || doc.meta.parent !== null || doc.meta.labels.length > 0;

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      data-focused={focused}
      className={cn(
        'group flex w-full flex-col gap-1 rounded-md border border-l-2 border-border border-l-transparent bg-card p-2.5 text-left transition-colors duration-150',
        'hover:border-foreground/15 hover:bg-accent/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'data-[focused=true]:ring-2 data-[focused=true]:ring-ring/50',
        ready && 'border-l-primary/70 bg-primary/[0.03]'
      )}
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
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-muted-foreground/70 truncate font-mono text-[11px]">
            {doc.meta.id}
          </span>
          {liveRunState !== undefined && (
            <span
              className="inline-flex shrink-0 items-center"
              title={RUN_STATE_DOT[liveRunState].label}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full animate-pulse motion-reduce:animate-none',
                  RUN_STATE_DOT[liveRunState].className
                )}
              />
            </span>
          )}
        </div>
        <PriorityIcon priority={doc.meta.priority} />
      </div>

      <div className="text-foreground text-[13px] leading-snug font-medium">
        {doc.meta.title}
      </div>

      {hasMeta && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {blocked && (
            <Badge
              variant="outline"
              className="border-destructive/30 bg-destructive/10 text-destructive h-4 rounded px-1.5 py-0 text-[10px] font-medium"
            >
              Blocked
            </Badge>
          )}
          {doc.meta.parent !== null && (
            <Badge
              variant="outline"
              className="bg-accent text-accent-foreground h-4 rounded border-transparent px-1.5 py-0 font-mono text-[10px] font-medium"
            >
              {doc.meta.parent}
            </Badge>
          )}
          {doc.meta.labels.map((label) => (
            <Badge
              key={label}
              variant="outline"
              className="text-muted-foreground h-4 rounded px-1.5 py-0 text-[10px] font-normal"
            >
              {label}
            </Badge>
          ))}
        </div>
      )}

      {ready && onDispatch !== undefined && (
        <button
          type="button"
          disabled={dispatching}
          onClick={(e) => void dispatchNow(e)}
          className={cn(
            'mt-1 inline-flex w-fit items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors duration-150',
            'hover:bg-primary/10 hover:text-primary',
            'group-hover:text-primary',
            dispatching && 'pointer-events-none opacity-60'
          )}
        >
          {dispatching ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              Dispatching
            </>
          ) : (
            <>
              Dispatch
              <ArrowRight className="size-3" />
            </>
          )}
        </button>
      )}
    </div>
  );
}
