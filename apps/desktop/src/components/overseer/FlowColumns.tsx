import type { MergeQueueEntry, RunMeta } from '@dispatch/client';
import type { ReactNode } from 'react';

import { useRunStep } from '../../hooks/useRunStep';
import { type FlowRow, useFlowRows } from '../../lib/flowList';
import { isTerminalRunState } from '../../lib/runState';
import { cn } from '@/lib/utils';

// Entering slides in from the column's outer edge; leaving keeps going outward.
const ENTER_IN = 'animate-in fade-in-0 slide-in-from-left-6 duration-300';
const ENTER_OUT = 'animate-in fade-in-0 slide-in-from-right-6 duration-300';
const LEAVE_OUT =
  'animate-out fade-out-0 slide-out-to-right-10 duration-[450ms] fill-mode-forwards';

/** Three chevrons pointing the way things move; they march while anything flows. */
function FlowChevrons({ active }: { active: boolean }) {
  return (
    <span aria-hidden className="flex font-mono text-[11px] leading-none">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={active ? { animationDelay: `${i * 200}ms` } : undefined}
          className={cn(
            'opacity-40',
            active && 'motion-safe:animate-flow motion-reduce:opacity-70'
          )}
        >
          ›
        </span>
      ))}
    </span>
  );
}

/** A column title with its count and the direction its items travel. */
// Both point right: in travels toward the talk, out travels away from it.
function ColumnHead({ label, count }: { label: string; count: number }) {
  return (
    <h2 className="text-muted-foreground flex items-center gap-1.5 px-1 text-[12px] font-medium">
      {label}
      <span className="tabular-nums">· {count}</span>
      <span className="flex-1" />
      <FlowChevrons active={count > 0} />
    </h2>
  );
}

/** What is coming to you: the asks and the "For you" posts, entering from the left. */
export function InflowColumn({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="Coming in"
      data-testid="overseer-inflow"
      className="hidden min-h-0 w-[300px] shrink-0 flex-col gap-2 overflow-y-auto min-[1440px]:w-[340px] xl:flex"
    >
      <ColumnHead label="Coming in" count={count} />
      {count === 0 && (
        <p className="text-muted-foreground font-book px-1 text-[12px]">
          Nothing is waiting on you.
        </p>
      )}
      <div
        className={cn(
          'flex flex-col gap-2 motion-reduce:animate-none',
          ENTER_IN
        )}
      >
        {children}
      </div>
    </aside>
  );
}

const LANDING: ReadonlySet<MergeQueueEntry['state']> = new Set([
  'queued',
  'waiting-blockers',
  'blocked-environment',
  'waiting-github',
  'rebasing',
  'verifying',
  'merging',
]);

/** One live run: its task, and the step it is on right now. */
function RunRow({ run, onOpen }: { run: RunMeta; onOpen: () => void }) {
  const step = useRunStep(run.id);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="hover:bg-surface-hover rounded-control flex w-full min-w-0 items-start gap-2 px-2 py-1.5 text-left"
    >
      <span
        aria-hidden
        className="bg-state-working mt-1.5 size-1.5 shrink-0 rounded-full motion-safe:animate-pulse"
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px]">{run.taskTitle}</span>
        <span className="text-muted-foreground font-book truncate text-[11px]">
          {run.state === 'awaiting-approval'
            ? 'waiting on approval'
            : (step ?? run.state)}
        </span>
      </span>
    </button>
  );
}

function Rows<T>({
  rows,
  render,
}: {
  rows: FlowRow<T>[];
  render: (item: T) => ReactNode;
}) {
  return rows.map((row) => (
    <div
      key={row.key}
      className={cn(
        'motion-reduce:animate-none',
        row.leaving ? cn(LEAVE_OUT, 'pointer-events-none') : ENTER_OUT
      )}
    >
      {render(row.item)}
    </div>
  ));
}

/**
 * What is leaving your hands: live runs, merges landing and set-aside
 * conversations. New work slides in; finished work slides out to the right.
 */
export function OutflowColumn({
  runs,
  merges,
  setAside,
  onOpenTask,
}: {
  runs: readonly RunMeta[];
  merges: readonly MergeQueueEntry[];
  setAside: ReactNode[];
  onOpenTask: (taskId: string) => void;
}) {
  const live = runs.filter(
    (r) => !isTerminalRunState(r.state) && (r.kind ?? 'execute') === 'execute'
  );
  const landing = merges.filter((m) => LANDING.has(m.state));
  const liveRows = useFlowRows(live, (r) => r.id);
  const landingRows = useFlowRows(landing, (m) => m.runId);
  const count = live.length + landing.length + setAside.length;
  return (
    <aside
      aria-label="Going out"
      data-testid="overseer-outflow"
      className="hidden min-h-0 w-[300px] shrink-0 flex-col gap-3 overflow-y-auto min-[1440px]:w-[340px] xl:flex"
    >
      <ColumnHead label="Going out" count={count} />
      {count === 0 && liveRows.length === 0 && landingRows.length === 0 && (
        <p className="text-muted-foreground font-book px-1 text-[12px]">
          Nothing is running.
        </p>
      )}
      {liveRows.length > 0 && (
        <section className="flex flex-col">
          <h3 className="text-muted-foreground px-1 pb-0.5 text-[11px]">
            Running
          </h3>
          <Rows
            rows={liveRows}
            render={(run) => (
              <RunRow run={run} onOpen={() => onOpenTask(run.taskId)} />
            )}
          />
        </section>
      )}
      {landingRows.length > 0 && (
        <section className="flex flex-col">
          <h3 className="text-muted-foreground px-1 pb-0.5 text-[11px]">
            Landing
          </h3>
          <Rows
            rows={landingRows}
            render={(entry) => (
              <button
                type="button"
                onClick={() => onOpenTask(entry.taskId)}
                className="hover:bg-surface-hover rounded-control flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left"
              >
                <span className="truncate text-[13px]">{entry.taskTitle}</span>
                <span className="text-muted-foreground font-book ml-auto shrink-0 text-[11px]">
                  {entry.state.replace('-', ' ')}
                </span>
              </button>
            )}
          />
        </section>
      )}
      {setAside.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-muted-foreground px-1 text-[11px]">Set aside</h3>
          {setAside}
        </section>
      )}
    </aside>
  );
}
