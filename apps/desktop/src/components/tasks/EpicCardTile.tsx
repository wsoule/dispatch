import type { EpicProgress } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { AlertCircle, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { clampConcurrencyInput } from '../../lib/epicConcurrency';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

// See `TaskCardTile`'s identical type — kept as its own copy rather than a shared import
// since the two cards' JSX around it differs enough that sharing the type alone wouldn't
// save much, and both files independently need it with no natural home to hoist it to
// without creating an extra shared-types file for two small interfaces.
export interface CardDragProps {
  setNodeRef: (node: HTMLElement | null) => void;
  style: React.CSSProperties | undefined;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
}

interface EpicCardTileProps {
  doc: TaskDoc;
  /** `undefined` while the progress fetch for this epic hasn't resolved yet — the stepper and
   * buttons still render (using `concurrencyDefault`), just without a progress line. */
  progress: EpicProgress | undefined;
  /** Default concurrency for a fresh dispatch session — `orchestrator.epicConcurrency` from the
   * project's config (see TasksPanel), which is itself defaulted to 3 by @dispatch/core. */
  concurrencyDefault: number;
  onSelect: () => void;
  onWork: (epicId: string, concurrency: number) => Promise<void>;
  onStop: (epicId: string) => Promise<void>;
  /** Same meaning as `TaskCardTile`'s `focused` — the Board's j/k roving-focus cursor. */
  focused?: boolean;
  /** Same meaning as `TaskCardTile`'s `onFocus` — syncs `BoardView`'s `focusedTaskId` cursor
   * to wherever real DOM focus actually lands on this card. */
  onFocus?: () => void;
  /** See `CardDragProps` — omitted for a card that isn't draggable. */
  drag?: CardDragProps;
}

/** Board card for a `kind: 'epic'` task: the same StatusIcon/PriorityIcon/title language as a
 * plain `TaskCardTile` (click to open detail), plus the epic-level parallel dispatch controls
 * — a concurrency stepper, "Work"/"Stop", and a live x/y-done + running-count progress line
 * once the epic has ever been dispatched. The dispatch controls live in the footer as
 * hover/focus-revealed actions (always visible once a session is active), matching the plain
 * card's "Dispatch" affordance rather than a permanently-visible control row — keeps the two
 * card types visually coherent. A distinct component from TaskCardTile (rather than a
 * kind-branch inside it) because it needs a click target for "open detail" *and* independent
 * interactive controls below it — two nested `<button>`s isn't valid HTML, so this uses a
 * plain clickable card root instead. */
export function EpicCardTile({
  doc,
  progress,
  concurrencyDefault,
  onSelect,
  onWork,
  onStop,
  focused = false,
  onFocus,
  drag,
}: EpicCardTileProps) {
  const [concurrency, setConcurrency] = useState(concurrencyDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = progress?.active ?? false;
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) cardRef.current?.focus();
  }, [focused]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const doneCount =
    progress?.children.filter(
      (c) => c.status === 'done' || c.status === 'cancelled'
    ).length ?? 0;
  const totalCount = progress?.children.length ?? 0;
  const liveCount = progress?.liveRuns.length ?? 0;

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
        'group flex w-full flex-col gap-1.5 rounded-[10px] bg-card p-3 text-left transition-colors duration-150',
        'hover:bg-accent/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'data-[focused=true]:ring-2 data-[focused=true]:ring-ring/50',
        drag?.isDragging === true && 'opacity-40'
      )}
      onClick={onSelect}
      onFocus={onFocus}
      onKeyDown={(e) => {
        const isDirectTarget = e.target === e.currentTarget;
        if (drag !== undefined && e.key === ' ' && isDirectTarget) {
          drag.listeners?.onKeyDown?.(e);
          return;
        }
        if (isDirectTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect();
          return;
        }
        if (!isDirectTarget) {
          // A keydown bubbled from the concurrency input or the Work/Stop button below —
          // those own their own Enter/Space handling, so it must not also reach the Board's
          // roving-focus track.
          e.stopPropagation();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground/70 shrink-0 font-mono">
          {doc.meta.id}
        </span>
        <Badge
          variant="outline"
          className="bg-accent text-accent-foreground h-4 rounded border-transparent px-1.5 py-0 text-[10px] font-medium"
        >
          Epic
        </Badge>
      </div>

      <div className="flex items-start gap-1.5">
        <span className="mt-0.5">
          <StatusIcon status={doc.meta.status} />
        </span>
        <span className="text-foreground line-clamp-2 text-[13px] leading-snug font-medium">
          {doc.meta.title}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <PriorityIcon priority={doc.meta.priority} />
        {totalCount > 0 && (
          <span className="text-muted-foreground flex items-center gap-1 font-mono text-[11px]">
            {liveCount > 0 && (
              <span className="bg-primary size-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none" />
            )}
            {doneCount}/{totalCount} done
            {liveCount > 0 && ` · ${liveCount} running`}
          </span>
        )}
      </div>

      {error !== null && (
        <div className="bg-destructive/10 text-destructive flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]">
          <AlertCircle className="size-3 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      <div className="mt-0.5 flex items-center justify-between gap-2">
        <span className="text-muted-foreground/70 text-[11px]">
          Updated {formatRelativeTimeFromIso(doc.meta.updated)}
        </span>
        <div
          className={cn(
            'flex items-center gap-1.5 opacity-0 transition-opacity duration-150',
            'group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100',
            active && 'opacity-100'
          )}
        >
          <Input
            type="number"
            min={1}
            value={concurrency}
            disabled={active || busy}
            onChange={(e) =>
              setConcurrency(clampConcurrencyInput(e.target.value))
            }
            aria-label="Epic dispatch concurrency"
            className="h-6 w-11 rounded px-1.5 py-0 text-[11px]"
          />
          {active ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => onStop(doc.meta.id))}
              className="hover:bg-destructive/10 hover:text-destructive h-6 gap-1 px-2 text-[11px]"
            >
              <Square className="size-3" />
              Stop
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => onWork(doc.meta.id, concurrency))}
              className="hover:bg-primary/10 hover:text-primary h-6 gap-1 px-2 text-[11px]"
            >
              <Play className="size-3" />
              Work
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
