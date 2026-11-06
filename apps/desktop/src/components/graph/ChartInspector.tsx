import { Button, Chip, Kbd, SectionHeader } from '@dispatch/ui';
import type { ReactNode } from 'react';

import type { ContainerStatus } from '../../lib/containerStatus';
import {
  type ChartModel,
  type ChartTask,
  traceChart,
} from '../../lib/dependencyChart';
import { StatusIcon } from '../tasks/StatusIcon';
import { TraceSwatch } from './ChartCanvas';
import styles from './ChartInspector.module.css';
import { CHART_STATE, HEALTH, shortDate } from './chartTones';

// How many rows a list shows before folding the rest into "+N more".
const LIST_LIMIT = 8;

/** The inspector's frame: a kicker, a title, then sections and the actions. */
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
    <div className={styles.frame}>
      <div className={styles.head}>
        <span className={styles.kicker}>{kicker}</span>
        <h2 className={styles.title}>{title}</h2>
        {meta !== undefined && <div className={styles.meta}>{meta}</div>}
      </div>
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
      {children}
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
    <section className={styles.section}>
      <SectionHeader
        name={label}
        count={count}
        as="h3"
        icon={dir === undefined ? undefined : <TraceSwatch dir={dir} />}
      />
      {children}
    </section>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className={styles.hint}>{children}</p>;
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
    <span className={styles.rowBody}>
      <span className={styles.rowId}>{id}</span>
      <span
        className={styles.rowTitle}
        data-missing={task === undefined || undefined}
      >
        {task?.title ?? 'Not on this chart'}
      </span>
      {note !== undefined && <span className={styles.rowNote}>{note}</span>}
    </span>
  );
  const icon =
    task === undefined ? (
      <span aria-hidden className={styles.rowIconGap} />
    ) : (
      <StatusIcon status={task.status} size={12} />
    );
  if (onPick === undefined || task === undefined) {
    return (
      <li className={styles.row}>
        {icon}
        {body}
      </li>
    );
  }
  return (
    <li>
      <Button
        variant="quiet"
        size="sm"
        block
        align="start"
        icon={icon}
        data-testid="chart-inspector-task"
        title={task.title}
        onClick={() => onPick(id)}
      >
        {body}
      </Button>
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
    return empty === undefined ? null : <Hint>{empty}</Hint>;
  }
  const shown = ids.slice(0, limit);
  return (
    <>
      <ul className={styles.list}>
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
        <Hint>+{ids.length - shown.length} more</Hint>
      )}
    </>
  );
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
    <div data-testid="chart-inspector-overview" className={styles.frame}>
      <div className={styles.howTo}>
        {view === 'tasks' ? (
          <p>
            Click a task to trace it. Lines turn{' '}
            <span className={styles.up}>amber</span> back through everything it
            waits on and <span className={styles.down}>teal</span> forward
            through everything it unblocks. Double-click a task to open it.
          </p>
        ) : (
          <p>
            Click a milestone to see its neighbours. Lines turn{' '}
            <span className={styles.up}>amber</span> to the milestones it waits
            on and <span className={styles.down}>teal</span> to the ones it
            unblocks. The number on a line counts the task waits behind it;
            click it to list them.
          </p>
        )}
        <p className={styles.keys}>
          <Kbd>/</Kbd> find · <Kbd>Esc</Kbd> clear · <Kbd>0</Kbd> fit ·{' '}
          <Kbd>+</Kbd> <Kbd>−</Kbd> zoom
        </p>
      </div>
      <dl className={styles.facts}>
        {facts.map(([label, n]) => (
          <div key={label} className={styles.fact}>
            <dt>{label}</dt>
            <dd>{n}</dd>
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
          <Hint>
            Open tasks with no waits either way are left off so the chains stay
            readable.
          </Hint>
          <div>
            <Button size="sm" variant="secondary" onClick={onShowUnlinked}>
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
  const state = CHART_STATE[task.state];
  return (
    <Frame
      kicker={task.milestoneTitle}
      title={
        <>
          <span className={styles.titleId}>{id}</span> {task.title}
        </>
      }
      meta={
        <>
          <Chip tone={state.tone}>{state.label}</Chip>
          <Chip>{task.status}</Chip>
          {meta.assignee !== 'none' && meta.assignee !== '' && (
            <Chip>{meta.assignee}</Chip>
          )}
          {meta.priority !== 'none' && <Chip>{meta.priority}</Chip>}
        </>
      }
      actions={
        <>
          <Button size="sm" variant="primary" onClick={() => onOpen(id)}>
            Open task
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onFitChain(new Set([...up, ...down, id]))}
          >
            Fit its chain
          </Button>
          <Button size="sm" variant="quiet" onClick={onClear}>
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
          <Hint>
            Also waits on {hidden.join(', ')}, outside this view (filtered out,
            archived or dropped).
          </Hint>
        )}
        {up.size > blockers.length && (
          <Hint>
            {up.size} tasks upstream in all, {openUp} still open.
          </Hint>
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
          <Hint>{down.size} tasks downstream in all.</Hint>
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
        <div key={other.id} className={styles.link}>
          <Button
            variant="quiet"
            size="sm"
            block
            align="start"
            data-testid="chart-inspector-milestone"
            onClick={() => onPickMilestone(other.id)}
          >
            <span className={styles.rowBody}>
              <span className={styles.linkTitle}>{other.title}</span>
              <span className={styles.rowNote}>
                {pairs.length} {pairs.length === 1 ? 'wait' : 'waits'}
              </span>
            </span>
          </Button>
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
          <Chip>
            {status.done}/{status.total} landed
          </Chip>
          <Chip tone={health.tone}>{health.label}</Chip>
          {dueDate !== null && <Chip>due {shortDate(dueDate)}</Chip>}
        </>
      }
      actions={
        <>
          <Button
            size="sm"
            variant="primary"
            data-testid="milestone-node-open"
            onClick={() => onOpenPlan(id)}
          >
            Open milestone
          </Button>
          {taskIds.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onShowTasks(id)}
            >
              Show its tasks
            </Button>
          )}
          <Button size="sm" variant="quiet" onClick={onClear}>
            Clear
          </Button>
        </>
      }
    >
      <Section label="Waits on" count={waitsOn.length} dir="up">
        {waitsOn.length === 0 ? (
          <Hint>No other milestone.</Hint>
        ) : (
          links(waitsOn, 'up')
        )}
      </Section>
      <Section label="Unblocks" count={unblocks.length} dir="down">
        {unblocks.length === 0 ? (
          <Hint>No other milestone.</Hint>
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
    <ul className={styles.pairs}>
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
        <Button size="sm" variant="quiet" onClick={onClear}>
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
        <Button size="sm" variant="quiet" onClick={onClear}>
          Clear
        </Button>
      }
    >
      <Hint>{blurb}</Hint>
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
