import type { ReactNode } from 'react';

import type { ContainerStatus } from '../../lib/containerStatus';
import {
  type ChartModel,
  type ChartTask,
  traceChart,
} from '../../lib/dependencyChart';
import { HEALTH, shortDate } from '../tasks/MilestoneStatusCells';
import { StatusIcon } from '../tasks/StatusIcon';
import { TraceSwatch } from './ChartCanvas';
import { CHART_STATE } from './ChartNodes';
import { cn } from '@/lib/utils';
import { LabelPill, Pill } from '@/ui/ai/pill';
import { RowButton } from '@/ui/ai/row-button';
import { Button } from '@/ui/button';
import { HintText, MetaText, SectionLabel } from '@/ui/chrome';
import { Kbd } from '@/ui/kbd';

// How many rows a list shows before folding the rest into "+N more".
const LIST_LIMIT = 8;

/** The inspector's frame: a kicker, a title, then sections. */
function Frame({
  kicker,
  title,
  meta,
  children,
  actions,
}: {
  kicker: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <MetaText className="truncate">{kicker}</MetaText>
        <h2 className="text-foreground text-[15px] leading-snug font-semibold text-balance">
          {title}
        </h2>
        {meta !== undefined && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">{meta}</div>
        )}
      </div>
      {children}
      {actions !== undefined && (
        <div className="flex flex-wrap gap-2">{actions}</div>
      )}
    </div>
  );
}

function Section({
  label,
  count,
  dir,
  children,
}: {
  label: string;
  count?: number;
  dir?: 'up' | 'down';
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <SectionLabel
        count={count}
        rule
        trailing={dir === undefined ? undefined : <TraceSwatch dir={dir} />}
      >
        {label}
      </SectionLabel>
      {children}
    </section>
  );
}

/** A task as an inspector row: status glyph, id, title, and a muted note. A click hands the
 * id back, which traces it on the chart. */
function TaskRow({
  task,
  id,
  note,
  onPick,
}: {
  task: ChartTask | undefined;
  id: string;
  note?: string;
  onPick?: (id: string) => void;
}) {
  const body = (
    <>
      {task !== undefined ? (
        <StatusIcon status={task.status} className="size-3 shrink-0" />
      ) : (
        <span aria-hidden className="size-3 shrink-0" />
      )}
      <span className="text-muted-foreground font-book shrink-0 tracking-(--id-tracking)">
        {id}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          task === undefined && 'text-muted-foreground'
        )}
      >
        {task?.title ?? 'Not on this chart'}
      </span>
      {note !== undefined && (
        <span className="text-muted-foreground shrink-0">{note}</span>
      )}
    </>
  );
  if (onPick === undefined || task === undefined) {
    return (
      <li className="flex h-5 min-w-0 items-center gap-1.5 text-[12px]">
        {body}
      </li>
    );
  }
  return (
    <li>
      <RowButton
        data-testid="chart-inspector-task"
        title={task.title}
        onClick={() => onPick(id)}
      >
        {body}
      </RowButton>
    </li>
  );
}

function TaskList({
  ids,
  chart,
  onPick,
  empty,
  limit = LIST_LIMIT,
  note,
}: {
  ids: readonly string[];
  chart: ChartModel;
  onPick: (id: string) => void;
  empty?: string;
  limit?: number;
  note?: (id: string) => string | undefined;
}) {
  if (ids.length === 0) {
    return empty === undefined ? null : <HintText>{empty}</HintText>;
  }
  const shown = ids.slice(0, limit);
  return (
    <>
      <ul className="flex flex-col">
        {shown.map((id) => (
          <TaskRow
            key={id}
            id={id}
            task={chart.tasks.get(id)}
            note={note?.(id)}
            onPick={onPick}
          />
        ))}
      </ul>
      {ids.length > shown.length && (
        <HintText>+{ids.length - shown.length} more</HintText>
      )}
    </>
  );
}

/** The state word as a pill in the state's colour. */
function StatePill({ task }: { task: ChartTask }) {
  const tone = CHART_STATE[task.state];
  return <LabelPill color={tone.color}>{tone.label}</LabelPill>;
}

export interface OverviewProps {
  chart: ChartModel;
  view: 'milestones' | 'tasks';
  /** Open tasks left off the Tasks chart because nothing links them. */
  unlinkedHidden: number;
  onPick: (id: string) => void;
  onShowUnlinked: () => void;
}

/** What the inspector shows with nothing selected: how to read the chart, the headline
 * numbers, and the lists worth starting from (the longest chain, what can start now). */
export function InspectorOverview({
  chart,
  view,
  unlinkedHidden,
  onPick,
  onShowUnlinked,
}: OverviewProps) {
  const open = [...chart.tasks.values()].filter(
    (t) => t.state !== 'landed'
  ).length;
  const facts: [string, number][] = [
    ['Open', open],
    ['Ready', chart.readyNow.length],
    ['In progress', chart.inProgress.length],
    ['Needs you', chart.needsYou.length],
    ['Waits', chart.edges.length],
    ['Longest chain', chart.longestChain.length],
  ];
  return (
    <div data-testid="chart-inspector-overview" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5 text-[12px] leading-[18px] text-(--text-secondary)">
        {view === 'tasks' ? (
          <p>
            Click a task to trace it. Lines turn{' '}
            <span className="font-semibold text-(--state-waiting-fg)">
              amber
            </span>{' '}
            back through everything it waits on and{' '}
            <span className="font-semibold text-(--teal)">teal</span> forward
            through everything it unblocks. Double-click a task to open it.
          </p>
        ) : (
          <p>
            Click a milestone to see its neighbours. Lines turn{' '}
            <span className="font-semibold text-(--state-waiting-fg)">
              amber
            </span>{' '}
            to the milestones it waits on and{' '}
            <span className="font-semibold text-(--teal)">teal</span> to the
            ones it unblocks. The number on a line counts the task waits behind
            it; click it to list them.
          </p>
        )}
        <p className="text-muted-foreground">
          Drag to pan · scroll to zoom · <Kbd>/</Kbd> find · <Kbd>Esc</Kbd>{' '}
          clear · <Kbd>0</Kbd> fit · <Kbd>+</Kbd> <Kbd>−</Kbd> zoom
        </p>
      </div>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
        {facts.map(([label, n]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground truncate text-[11px]">
              {label}
            </dt>
            <dd className="text-foreground text-[17px] leading-6 font-semibold tabular-nums">
              {n}
            </dd>
          </div>
        ))}
      </dl>
      <Section label="Longest open chain" count={chart.longestChain.length}>
        <TaskList
          ids={chart.longestChain}
          chart={chart}
          onPick={onPick}
          empty="No open task waits on another."
          limit={12}
          note={(id) => `${chart.longestChain.indexOf(id) + 1}`}
        />
      </Section>
      <Section label="Ready to start" count={chart.readyNow.length}>
        <TaskList
          ids={chart.readyNow}
          chart={chart}
          onPick={onPick}
          empty="Nothing is ready: every open task waits on something or is a draft."
        />
      </Section>
      {chart.needsYou.length > 0 && (
        <Section label="Needs you" count={chart.needsYou.length}>
          <TaskList ids={chart.needsYou} chart={chart} onPick={onPick} />
        </Section>
      )}
      {view === 'tasks' && unlinkedHidden > 0 && (
        <Section label="Not on the chart" count={unlinkedHidden}>
          <HintText>
            Open tasks with no waits either way are left off so the chains stay
            readable.
          </HintText>
          <div>
            <Button size="xs" variant="outline" onClick={onShowUnlinked}>
              Show unlinked tasks
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}

export interface TaskInspectorProps {
  chart: ChartModel;
  id: string;
  onPick: (id: string) => void;
  onFitChain: (ids: ReadonlySet<string>) => void;
  onOpen: (id: string) => void;
  onClear: () => void;
}

/** A selected task: where it sits, its state, what it waits on and what it unblocks (direct
 * links listed, the transitive reach counted), and the way into the task itself. */
export function TaskInspector({
  chart,
  id,
  onPick,
  onFitChain,
  onOpen,
  onClear,
}: TaskInspectorProps) {
  const task = chart.tasks.get(id);
  if (task === undefined) return null;
  const up = traceChart(chart, id, 'up');
  const down = traceChart(chart, id, 'down');
  const blockers = chart.blockersOf.get(id) ?? [];
  const dependents = chart.dependentsOf.get(id) ?? [];
  const hidden = chart.hiddenBlockersOf.get(id) ?? [];
  const openUp = [...up].filter(
    (x) => chart.tasks.get(x)?.state !== 'landed'
  ).length;
  const { meta } = task.doc;
  return (
    <Frame
      kicker={task.milestoneTitle}
      title={
        <>
          <span className="text-muted-foreground font-book tracking-(--id-tracking)">
            {id}
          </span>{' '}
          {task.title}
        </>
      }
      meta={
        <>
          <StatePill task={task} />
          <Pill>
            <StatusIcon status={task.status} className="size-3" />
            {task.status}
          </Pill>
          {meta.assignee !== 'none' && meta.assignee !== '' && (
            <Pill>{meta.assignee}</Pill>
          )}
          {meta.priority !== 'none' && <Pill>{meta.priority}</Pill>}
        </>
      }
      actions={
        <>
          <Button size="sm" onClick={() => onOpen(id)}>
            Open task
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onFitChain(new Set([...up, ...down, id]))}
          >
            Fit its chain
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        </>
      }
    >
      <Section label="Waits on" count={blockers.length} dir="up">
        <TaskList
          ids={blockers}
          chart={chart}
          onPick={onPick}
          empty={
            hidden.length > 0
              ? undefined
              : task.state === 'landed'
                ? 'Nothing.'
                : 'Nothing. It can start whenever someone picks it up.'
          }
        />
        {hidden.length > 0 && (
          <HintText>
            Also waits on {hidden.join(', ')}, outside this view (filtered out,
            archived or dropped).
          </HintText>
        )}
        {up.size > blockers.length && (
          <HintText>
            {up.size} tasks upstream in all, {openUp} still open.
          </HintText>
        )}
      </Section>
      <Section label="Unblocks" count={dependents.length} dir="down">
        <TaskList
          ids={dependents}
          chart={chart}
          onPick={onPick}
          empty="Nothing waits on it."
        />
        {down.size > dependents.length && (
          <HintText>{down.size} tasks downstream in all.</HintText>
        )}
      </Section>
    </Frame>
  );
}

export interface MilestoneInspectorProps {
  chart: ChartModel;
  id: string;
  title: string;
  status: ContainerStatus;
  dueDate: string | null;
  /** Milestone ids and titles this one waits on, and those waiting on it. */
  waitsOn: readonly { id: string; title: string }[];
  unblocks: readonly { id: string; title: string }[];
  /** The milestone's tasks, open first (most urgent first), then landed. */
  taskIds: readonly string[];
  onPick: (id: string) => void;
  onPickMilestone: (id: string) => void;
  onOpenPlan: (id: string) => void;
  onShowTasks: (id: string) => void;
  onClear: () => void;
}

/** A selected milestone: progress, the milestones on either side with the task waits behind
 * each link, and its tasks. */
export function MilestoneInspector({
  chart,
  id,
  title,
  status,
  dueDate,
  waitsOn,
  unblocks,
  taskIds,
  onPick,
  onPickMilestone,
  onOpenPlan,
  onShowTasks,
  onClear,
}: MilestoneInspectorProps) {
  const health = HEALTH[status.health];
  const links = (
    list: readonly { id: string; title: string }[],
    dir: 'up' | 'down'
  ) =>
    list.map((other) => {
      const key =
        dir === 'up' ? `${other.id}\u0000${id}` : `${id}\u0000${other.id}`;
      const pairs = chart.milestonePairs.get(key) ?? [];
      return (
        <div key={other.id} className="flex flex-col gap-0.5">
          <RowButton
            data-testid="chart-inspector-milestone"
            onClick={() => onPickMilestone(other.id)}
            className="font-medium"
          >
            <span className="min-w-0 flex-1 truncate">{other.title}</span>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {pairs.length} {pairs.length === 1 ? 'wait' : 'waits'}
            </span>
          </RowButton>
          <PairList pairs={pairs} chart={chart} onPick={onPick} />
        </div>
      );
    });
  return (
    <Frame
      kicker="Milestone"
      title={title}
      meta={
        <>
          <Pill>
            {status.done}/{status.total} landed
          </Pill>
          <span
            className={cn(
              'rounded-pill inline-flex h-6 items-center px-2 text-[12px]',
              health.tone
            )}
          >
            {health.label}
          </span>
          {dueDate !== null && <Pill>due {shortDate(dueDate)}</Pill>}
        </>
      }
      actions={
        <>
          <Button
            size="sm"
            data-testid="milestone-node-open"
            onClick={() => onOpenPlan(id)}
          >
            Open flight plan
          </Button>
          {taskIds.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => onShowTasks(id)}>
              Show its tasks
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear
          </Button>
        </>
      }
    >
      <Section label="Waits on" count={waitsOn.length} dir="up">
        {waitsOn.length === 0 ? (
          <HintText>No other milestone.</HintText>
        ) : (
          links(waitsOn, 'up')
        )}
      </Section>
      <Section label="Unblocks" count={unblocks.length} dir="down">
        {unblocks.length === 0 ? (
          <HintText>No other milestone.</HintText>
        ) : (
          links(unblocks, 'down')
        )}
      </Section>
      <Section label="Tasks" count={taskIds.length}>
        <TaskList
          ids={taskIds}
          chart={chart}
          onPick={onPick}
          empty="No tasks yet."
          limit={12}
        />
      </Section>
    </Frame>
  );
}

/** Blocker → blocked pairs behind a milestone link, each a way onto the Tasks chart. */
function PairList({
  pairs,
  chart,
  onPick,
}: {
  pairs: readonly (readonly [string, string])[];
  chart: ChartModel;
  onPick: (id: string) => void;
}) {
  if (pairs.length === 0) return null;
  return (
    <ul className="flex flex-col pl-2">
      {pairs.map(([from, to]) => (
        <TaskRow
          key={`${from}\u0000${to}`}
          id={to}
          task={chart.tasks.get(to)}
          note={`waits on ${from}`}
          onPick={onPick}
        />
      ))}
    </ul>
  );
}

export interface LinkInspectorProps {
  chart: ChartModel;
  from: { id: string; title: string };
  to: { id: string; title: string };
  onPick: (id: string) => void;
  onClear: () => void;
}

/** A selected milestone link: every task wait it stands for. */
export function LinkInspector({
  chart,
  from,
  to,
  onPick,
  onClear,
}: LinkInspectorProps) {
  const pairs = chart.milestonePairs.get(`${from.id}\u0000${to.id}`) ?? [];
  return (
    <Frame
      kicker="Milestone link"
      title={`${to.title} waits on ${from.title}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      }
    >
      <Section label="Task waits" count={pairs.length}>
        <PairList pairs={pairs} chart={chart} onPick={onPick} />
      </Section>
    </Frame>
  );
}

export interface SetInspectorProps {
  chart: ChartModel;
  label: string;
  blurb: string;
  ids: readonly string[];
  onPick: (id: string) => void;
  onClear: () => void;
}

/** A highlighted set (a preset, or a milestone's tasks): what it is and its members. */
export function SetInspector({
  chart,
  label,
  blurb,
  ids,
  onPick,
  onClear,
}: SetInspectorProps) {
  return (
    <Frame
      kicker="Highlighted"
      title={`${label} · ${ids.length}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      }
    >
      <HintText className="text-[12px]">{blurb}</HintText>
      <TaskList
        ids={ids}
        chart={chart}
        onPick={onPick}
        empty="Nothing right now."
        limit={40}
      />
    </Frame>
  );
}
