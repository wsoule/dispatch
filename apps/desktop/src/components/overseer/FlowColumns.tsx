import type { MergeQueueEntry, RunMeta } from '@dispatch/client';
import type { ReactNode } from 'react';

import { useRunStep } from '../../hooks/useRunStep';
import { type FlowRow, useFlowRows } from '../../lib/flowList';
import { isTerminalRunState } from '../../lib/runState';
import { cn } from '@/lib/utils';
import { GroupHeader } from '@/ui/ai/group-header';
import { ListRow } from '@/ui/ai/list-row';
import { MetaText, SectionLabel } from '@/ui/chrome';
import { ScrollArea } from '@/ui/scroll-area';

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
    <h2 className="contents">
      <GroupHeader
        name={label}
        count={count}
        actions={<FlowChevrons active={count > 0} />}
      />
    </h2>
  );
}

/** A column: the head pinned on top, the rest scrolling under it. */
function Column({
  label,
  count,
  testId,
  children,
}: {
  label: string;
  count: number;
  testId: string;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label={label}
      data-testid={testId}
      className="hidden min-h-0 w-[300px] shrink-0 flex-col gap-2 min-[1440px]:w-[340px] xl:flex"
    >
      <ColumnHead label={label} count={count} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3">{children}</div>
      </ScrollArea>
    </aside>
  );
}

/** The quiet line a column shows when nothing is in it. */
function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <p className="px-2">
      <MetaText>{children}</MetaText>
    </p>
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
    <Column label="Coming in" count={count} testId="overseer-inflow">
      {count === 0 && <EmptyLine>Nothing is waiting on you.</EmptyLine>}
      <div
        className={cn(
          'flex flex-col gap-2 motion-reduce:animate-none',
          ENTER_IN
        )}
      >
        {children}
      </div>
    </Column>
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
    <ListRow
      role="listitem"
      onClick={onOpen}
      leading={
        <span
          aria-hidden
          className="bg-state-working size-1.5 rounded-full motion-safe:animate-pulse"
        />
      }
      title={run.taskTitle}
      crumb={
        run.state === 'awaiting-approval'
          ? 'waiting on approval'
          : (step ?? run.state)
      }
    />
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
    <Column label="Going out" count={count} testId="overseer-outflow">
      {count === 0 && liveRows.length === 0 && landingRows.length === 0 && (
        <EmptyLine>Nothing is running.</EmptyLine>
      )}
      {liveRows.length > 0 && (
        <section className="flex flex-col">
          <SectionLabel className="px-2 pb-0.5">Running</SectionLabel>
          <div role="list" className="flex flex-col">
            <Rows
              rows={liveRows}
              render={(run) => (
                <RunRow run={run} onOpen={() => onOpenTask(run.taskId)} />
              )}
            />
          </div>
        </section>
      )}
      {landingRows.length > 0 && (
        <section className="flex flex-col">
          <SectionLabel className="px-2 pb-0.5">Landing</SectionLabel>
          <div role="list" className="flex flex-col">
            <Rows
              rows={landingRows}
              render={(entry) => (
                <ListRow
                  role="listitem"
                  onClick={() => onOpenTask(entry.taskId)}
                  title={entry.taskTitle}
                  date={entry.state.replace('-', ' ')}
                />
              )}
            />
          </div>
        </section>
      )}
      {setAside.length > 0 && (
        <section className="flex flex-col">
          <SectionLabel className="px-2 pb-0.5">Set aside</SectionLabel>
          <div role="list" className="flex flex-col gap-1">
            {setAside}
          </div>
        </section>
      )}
    </Column>
  );
}
