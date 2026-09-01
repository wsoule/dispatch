import type { EpicProgress } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import {
  AlertCircle,
  ChevronRight,
  GitMerge,
  Layers,
  Play,
  Square,
  Waypoints,
} from 'lucide-react';
import { useState } from 'react';

import { clampConcurrencyInput } from '../../lib/epicConcurrency';
import { colorForEpic } from '../../lib/projectColor';
import { EpicDagModal } from './EpicDagModal';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

interface EpicLaneHeaderProps {
  /** The epic this lane belongs to, or `null` for the catch-all "No epic" lane — which still
   * collapses and still shows its count, it just has nothing to dispatch or graph. */
  epic: TaskDoc | null;
  /** Lane title: the epic's own, `No epic`, or a bare parent id that resolves to no known epic. */
  title: string;
  /** How many cards the lane holds, collapsed or not — the one count that never moves, so
   * folding a lane away can't look like its work disappeared. */
  total: number;
  expanded: boolean;
  onToggle: () => void;
  /** `undefined` until this epic's progress fetch resolves — the controls still render, just
   * without the done/total bar. */
  progress: EpicProgress | undefined;
  /** `orchestrator.epicConcurrency` from the project config, the stepper's starting value. */
  concurrencyDefault: number;
  /** This epic's children — the only extra data the dependency-graph modal needs. */
  childTasks: TaskDoc[];
  /** Opens a task in the peek/detail dialog: the epic itself (its id chip) or one of its
   * children (from the graph modal). */
  onOpenTask: (taskId: string) => void;
  onWork: (epicId: string, concurrency: number) => Promise<void>;
  /** When given, Work asks for a confirmation preview instead of dispatching straight away. */
  onRequestWork?: (epicId: string) => void;
  onStop: (epicId: string) => Promise<void>;
  /** Lands the finished epic branch on the default base (one PR or one local merge, decided
   * server-side). Optional so a header rendered without land wiring stays valid; the Land
   * button only renders once every child is done/cancelled, replacing the then-useless Work
   * button. */
  onLand?: (epicId: string) => Promise<void>;
}

/**
 * One epic's row on the unified board: the click target that folds the epic's status columns
 * away, plus the epic-level controls that used to live on an epic *card* — a done/total progress
 * bar, the dependency-graph button, and the concurrency stepper with Work/Stop.
 *
 * Epics are containers here, not objects on the board: they are never dragged and never occupy a
 * status column, so the header is a real `<button>` (the whole title stretch, hairline included,
 * is clickable) rather than a card. The controls sit outside that button — nested buttons aren't
 * valid HTML — and each stops propagation so using them never also toggles the lane.
 */
export function EpicLaneHeader({
  epic,
  title,
  total,
  expanded,
  onToggle,
  progress,
  concurrencyDefault,
  childTasks,
  onOpenTask,
  onWork,
  onRequestWork,
  onStop,
  onLand,
}: EpicLaneHeaderProps) {
  const [concurrency, setConcurrency] = useState(concurrencyDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const active = progress?.active ?? false;

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
      (c) => c.status === 'landed' || c.status === 'dropped'
    ).length ?? 0;
  const totalCount = progress?.children.length ?? 0;
  const liveCount = progress?.liveRuns.length ?? 0;
  // Same "finished" rule the server's land validation applies (every child
  // done or cancelled) — the button still only *requests*; the server is the
  // authority and 409s with its reason into the error alert below.
  const landable =
    onLand !== undefined &&
    epic !== null &&
    !active &&
    totalCount > 0 &&
    doneCount === totalCount &&
    epic.meta.status !== 'landed';

  return (
    <>
      <div className="group/lane mb-2 flex items-center gap-2 px-0.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="focus-visible:ring-ring/50 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-0.5 text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'text-muted-foreground size-3.5 shrink-0 transition-transform duration-150',
              expanded && 'rotate-90'
            )}
          />
          {/* A swatch in the epic's own color rather than the generic Layers glyph every lane
              used to share — with one icon repeated down the page, nothing told the lanes
              apart. The "no epic" lane has no id to hash, so it keeps the neutral glyph. */}
          {epic !== null ? (
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-[4px]"
              style={{ background: colorForEpic(epic.meta.id) }}
            />
          ) : (
            <Layers className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span className="truncate text-[13px] font-semibold">{title}</span>
          <span className="dense-meta">{total}</span>
          <span
            aria-hidden
            className="h-px flex-1 bg-[linear-gradient(to_right,var(--border-default),transparent_70%)]"
          />
        </button>

        {epic !== null && (
          <>
            {totalCount > 0 && (
              <div className="flex shrink-0 items-center gap-1.5">
                {/* The progress line the epic card carried, as an actual bar: a lane header is
                    read at a glance down a column of other lanes, where a filled track compares
                    far faster than two numbers. The numbers stay beside it all the same. */}
                <span
                  aria-hidden
                  className="bg-border/70 h-1 w-14 overflow-hidden rounded-full"
                >
                  <span
                    className="bg-primary/70 block h-full rounded-full transition-[width] duration-300"
                    style={{
                      width: `${Math.round((doneCount / totalCount) * 100)}%`,
                    }}
                  />
                </span>
                <span className="text-muted-foreground flex items-center gap-1 font-mono text-[11px] whitespace-nowrap">
                  {liveCount > 0 && (
                    <span className="bg-primary size-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none" />
                  )}
                  {doneCount}/{totalCount} done
                  {liveCount > 0 && ` · ${liveCount} running`}
                </span>
              </div>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Open ${epic.meta.id}`}
                  onClick={() => onOpenTask(epic.meta.id)}
                  className="text-muted-foreground/70 hover:bg-accent hover:text-foreground h-6 shrink-0 rounded-md px-1 font-mono text-[11px]"
                >
                  {epic.meta.id}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open epic</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`View dependency graph for ${epic.meta.id}`}
                  onClick={() => setShowGraph(true)}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground size-auto shrink-0 rounded-md p-1 has-[>svg]:px-1"
                >
                  <Waypoints className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>View dependency graph</TooltipContent>
            </Tooltip>
            {/* Dispatch controls stay hover/focus-revealed (and pinned open while a session is
                active), the same way they behaved on the epic card — a board of ten lanes should
                not read as ten permanent control rows. */}
            <div
              className={cn(
                'flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity duration-150',
                'group-hover/lane:opacity-100 group-focus-within/lane:opacity-100 focus-within:opacity-100',
                active && 'opacity-100'
              )}
            >
              {!landable && (
                <Input
                  type="number"
                  min={1}
                  value={concurrency}
                  disabled={active || busy}
                  onChange={(e) =>
                    setConcurrency(clampConcurrencyInput(e.target.value))
                  }
                  aria-label={`Epic dispatch concurrency for ${epic.meta.id}`}
                  className="h-6 w-11 rounded px-1.5 py-0 text-[11px]"
                />
              )}
              {active ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => onStop(epic.meta.id))}
                  className="hover:bg-destructive/10 hover:text-destructive h-6 gap-1 px-2 text-[11px]"
                >
                  <Square className="size-3" />
                  Stop
                </Button>
              ) : landable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => onLand(epic.meta.id))}
                  className="hover:bg-primary/10 hover:text-primary h-6 gap-1 px-2 text-[11px]"
                >
                  <GitMerge className="size-3" />
                  Land
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (onRequestWork !== undefined) {
                      onRequestWork(epic.meta.id);
                      return;
                    }
                    void run(() => onWork(epic.meta.id, concurrency));
                  }}
                  className="hover:bg-primary/10 hover:text-primary h-6 gap-1 px-2 text-[11px]"
                >
                  <Play className="size-3" />
                  Work
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      {error !== null && (
        <Alert
          variant="destructive"
          className="bg-destructive/10 mb-2 flex items-center gap-1.5 rounded-md border-0 px-2 py-1 text-[11px] has-[>svg]:gap-x-1.5 [&>svg]:translate-y-0"
        >
          <AlertCircle className="size-3 shrink-0" />
          <AlertDescription className="truncate text-[11px]">
            {error}
          </AlertDescription>
        </Alert>
      )}

      {epic !== null && (
        <EpicDagModal
          epic={showGraph ? epic : null}
          tasks={childTasks}
          onOpenTask={onOpenTask}
          onClose={() => setShowGraph(false)}
        />
      )}
    </>
  );
}
