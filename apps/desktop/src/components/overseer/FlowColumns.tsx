import type { EpicProgress, MergeQueueEntry, RunMeta } from '@dispatch/client';
import { type ReactNode, useState } from 'react';

import { useRunStep } from '../../hooks/useRunStep';
import { formatUsd, spendPillLabel } from '../../lib/epicSession';
import { type FlowRow, useFlowRows } from '../../lib/flowList';
import { type LiveCeilings, liveCeilingsLabel } from '../../lib/liveSpend';
import { isTerminalRunState } from '../../lib/runState';
import { cn } from '@/lib/utils';
import { GroupHeader } from '@/ui/ai/group-header';
import { ListRow } from '@/ui/ai/list-row';
import { Button } from '@/ui/button';
import { MetaText, SectionLabel } from '@/ui/chrome';
import { StateMark } from '@/ui/chrome/state-mark';
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
  sub,
  children,
}: {
  label: string;
  count: number;
  testId: string;
  /** A quiet line under the head, e.g. what the work is costing. */
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label={label}
      data-testid={testId}
      className="hidden min-h-0 w-[300px] shrink-0 flex-col gap-2 min-[1440px]:w-[340px] xl:flex"
    >
      <ColumnHead label={label} count={count} />
      {sub}
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

/** Today's spend and the live milestones against their ceilings, in one line. */
export function spendLine(
  today: number | null,
  ceilings: LiveCeilings | null
): string | null {
  const parts: string[] = [];
  if (today !== null && today > 0) parts.push(`${formatUsd(today)} today`);
  if (ceilings !== null && ceilings.live > 0) {
    parts.push(liveCeilingsLabel(ceilings));
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** One live milestone session: its title, how many of its runs are live, and its spend. */
function SessionRow({
  progress,
  title,
  onOpen,
}: {
  progress: EpicProgress;
  title: string;
  onOpen: () => void;
}) {
  const live = progress.liveRuns.length;
  const paused = progress.session?.state === 'paused';
  return (
    <ListRow
      role="listitem"
      data-testid="overseer-session-row"
      onClick={onOpen}
      // A paused session still drains its last runs; held, not working.
      leading={<StateMark state={paused ? 'blocked' : 'working'} />}
      title={title}
      crumb={paused ? 'paused' : `${live} running`}
      date={spendPillLabel(progress.spend)}
    />
  );
}

/** What Going out shows beyond runs and merges, handed through from App. */
export interface OutflowExtras {
  /** Milestones with an active or paused fan-out session. */
  sessions?: readonly EpicProgress[];
  /** A milestone's title by id. */
  epicTitle?: (epicId: string) => string;
  /** Finished runs "Merge all ready" would queue. */
  mergeReady?: number;
  onMergeAll?: () => Promise<void>;
  /** Settled spend across today's runs; `null` or zero shows nothing. */
  spendToday?: number | null;
  /** The live sessions' spend against their ceilings, summed. */
  ceilings?: LiveCeilings | null;
}

interface OutflowColumnProps extends OutflowExtras {
  runs: readonly RunMeta[];
  merges: readonly MergeQueueEntry[];
  setAside: ReactNode[];
  onOpenTask: (taskId: string) => void;
}

/**
 * What is leaving your hands: live milestone sessions, live runs, merges
 * landing and set-aside conversations. New work slides in; finished work
 * slides out to the right. The head carries today's spend, and Landing offers
 * "Merge all ready" while finished work waits to be queued.
 */
export function OutflowColumn({
  runs,
  merges,
  setAside,
  onOpenTask,
  sessions = [],
  epicTitle = (id) => id,
  mergeReady = 0,
  onMergeAll,
  spendToday = null,
  ceilings = null,
}: OutflowColumnProps) {
  const [merging, setMerging] = useState(false);
  const live = runs.filter(
    (r) => !isTerminalRunState(r.state) && (r.kind ?? 'execute') === 'execute'
  );
  const landing = merges.filter((m) => LANDING.has(m.state));
  const liveRows = useFlowRows(live, (r) => r.id);
  const landingRows = useFlowRows(landing, (m) => m.runId);
  const sessionRows = useFlowRows(sessions, (p) => p.epicId);
  const count =
    sessions.length + live.length + landing.length + setAside.length;
  const canMergeAll = onMergeAll !== undefined && mergeReady > 0;
  const spend = spendLine(spendToday, ceilings);
  const mergeAll = () => {
    if (onMergeAll === undefined) return;
    setMerging(true);
    void onMergeAll().finally(() => setMerging(false));
  };
  return (
    <Column
      label="Going out"
      count={count}
      testId="overseer-outflow"
      sub={
        spend !== null && (
          <p
            data-testid="overseer-spend"
            className="truncate px-2 pb-1 leading-none"
            title={spend}
          >
            <MetaText>{spend}</MetaText>
          </p>
        )
      }
    >
      {count === 0 &&
        liveRows.length === 0 &&
        landingRows.length === 0 &&
        sessionRows.length === 0 &&
        !canMergeAll && <EmptyLine>Nothing is running.</EmptyLine>}
      {sessionRows.length > 0 && (
        <section className="flex flex-col">
          <SectionLabel className="px-2 pb-0.5">Milestones</SectionLabel>
          <div role="list" className="flex flex-col">
            <Rows
              rows={sessionRows}
              render={(progress) => (
                <SessionRow
                  progress={progress}
                  title={epicTitle(progress.epicId)}
                  onOpen={() => onOpenTask(progress.epicId)}
                />
              )}
            />
          </div>
        </section>
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
      {(landingRows.length > 0 || canMergeAll) && (
        <section className="flex flex-col">
          <SectionLabel
            className="h-6 px-2 pb-0.5"
            trailing={
              canMergeAll && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto"
                  disabled={merging}
                  onClick={mergeAll}
                  data-testid="overseer-merge-all"
                >
                  Merge all ready ({mergeReady})
                </Button>
              )
            }
          >
            Landing
          </SectionLabel>
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
