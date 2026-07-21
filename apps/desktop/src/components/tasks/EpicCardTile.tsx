import type { EpicProgress } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';
import { AlertCircle, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { clampConcurrencyInput } from '../../lib/epicConcurrency';
import { PriorityIcon } from './TaskCardTile';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

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
}

/** Board card for a `kind: 'epic'` task: the same id/priority/title header as a plain
 * TaskCardTile (click to open detail), plus the epic-level parallel dispatch controls the plan
 * calls for — a concurrency stepper, "Work this epic" (or "Stop" once a session is active),
 * and a live x/y-done + running-count progress line once the epic has ever been dispatched.
 * A distinct component from TaskCardTile (rather than a kind-branch inside it) because it
 * needs a click target for "open detail" *and* independent interactive controls below it —
 * two nested `<button>`s isn't valid HTML, so this uses a plain clickable header instead. */
export function EpicCardTile({
  doc,
  progress,
  concurrencyDefault,
  onSelect,
  onWork,
  onStop,
  focused = false,
  onFocus,
}: EpicCardTileProps) {
  const [concurrency, setConcurrency] = useState(concurrencyDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = progress?.active ?? false;
  const headerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) headerRef.current?.focus();
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
    <div className="border-border border-l-primary/70 bg-card flex w-full flex-col gap-2 rounded-md border border-l-2 p-2.5">
      <div
        ref={headerRef}
        role="button"
        tabIndex={0}
        data-focused={focused}
        className={cn(
          'flex flex-col gap-1 rounded-sm text-left transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          'data-[focused=true]:ring-2 data-[focused=true]:ring-ring/50'
        )}
        onClick={onSelect}
        onFocus={onFocus}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSelect();
          else if (e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground/70 truncate font-mono text-[11px]">
              {doc.meta.id}
            </span>
            <Badge
              variant="outline"
              className="bg-accent text-accent-foreground h-4 rounded border-transparent px-1.5 py-0 text-[10px] font-medium"
            >
              Epic
            </Badge>
          </div>
          <PriorityIcon priority={doc.meta.priority} />
        </div>
        <div className="text-foreground text-[13px] leading-snug font-medium">
          {doc.meta.title}
        </div>
      </div>

      {totalCount > 0 && (
        <div className="text-muted-foreground flex items-center gap-1 font-mono text-[11px]">
          {liveCount > 0 && (
            <span className="bg-primary size-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none" />
          )}
          <span>
            {doneCount}/{totalCount} done
            {liveCount > 0 && ` · ${liveCount} running`}
          </span>
        </div>
      )}

      {error !== null && (
        <div className="bg-destructive/10 text-destructive flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]">
          <AlertCircle className="size-3 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      <div className="border-border flex items-center justify-between gap-2 border-t pt-2">
        <label className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <span>Concurrency</span>
          <Input
            type="number"
            min={1}
            value={concurrency}
            disabled={active || busy}
            onChange={(e) =>
              setConcurrency(clampConcurrencyInput(e.target.value))
            }
            aria-label="Epic dispatch concurrency"
            className="h-6 w-12 rounded px-1.5 py-0 text-[11px]"
          />
        </label>
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
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => onWork(doc.meta.id, concurrency))}
            className="hover:border-primary/40 hover:bg-primary/10 hover:text-primary h-6 gap-1 px-2 text-[11px]"
          >
            <Play className="size-3" />
            Work this epic
          </Button>
        )}
      </div>
    </div>
  );
}
