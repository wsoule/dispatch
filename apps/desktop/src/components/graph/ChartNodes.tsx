import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { UiTone } from '@dispatch/ui';
import { memo } from 'react';

import type { ContainerStatus } from '../../lib/containerStatus';
import type { ChartState, ChartTask } from '../../lib/dependencyChart';
import { type MilestoneMix, MIX_ORDER } from '../../lib/milestoneMap';
import { StatusIcon } from '../tasks/StatusIcon';
import styles from './ChartNodes.module.css';
import { CELLS, CHART_STATE, HEALTH, shortDate } from './chartTones';

/** Fixed node footprints: the layout needs every box before anything renders, and each
 * card fills its box so routed edges meet its actual edge. A task card is 8px padding
 * around a 16px id row and two 17px title lines, plus a 16px kicker line (and its 2px gap)
 * when cards are not boxed by milestone. A milestone card is 12px padding around the title
 * row, the 6px bar, the 18px counts and next rows and three 8px gaps. */
export const TASK_NODE = { width: 220, height: 68, kicker: 18 };
export const MILESTONE_NODE = { width: 268, height: 112 };

/** A legend swatch: a tiny card in the state's own ring and fill. */
export function StateSwatch({ state }: { state: ChartState }) {
  return (
    <span
      aria-hidden
      className={styles.swatch}
      data-state={state}
      data-tone={CHART_STATE[state].tone}
    />
  );
}

/**
 * One task on the chart: its milestone as a kicker, status glyph, id and state word, then the
 * title over two lines. The whole card is the node's one control (a native button: the chart
 * places it at its laid-out box, which no library control does), named with the id and state
 * too: a click selects (traces) the task, a double-click opens it. Memoised, with handlers
 * that take the id, so a selection only re-renders the cards whose `selected` changes.
 */
export const TaskChartNode = memo(function TaskChartNode({
  task,
  showMilestone,
  selected,
  onSelect,
  onOpen,
}: {
  task: ChartTask;
  showMilestone: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const state = CHART_STATE[task.state];
  return (
    <button
      type="button"
      data-testid="chart-task"
      data-state={task.state}
      data-tone={state.tone}
      data-selected={selected ? '' : undefined}
      aria-label={`${task.id} ${task.title}, ${state.label}`}
      aria-current={selected || undefined}
      title={task.title}
      className={styles.card}
      data-kind="task"
      onClick={() => onSelect(task.id)}
      onDoubleClick={() => onOpen(task.id)}
    >
      {showMilestone && (
        <span className={styles.kicker}>{task.milestoneTitle}</span>
      )}
      <span className={styles.idRow}>
        <StatusIcon status={task.status} size={14} />
        <span className={styles.id}>{task.id}</span>
        <span className={styles.stateWord}>{state.label}</span>
      </span>
      <span className={styles.title}>{task.title}</span>
    </button>
  );
});

// Each bar segment's words and status tone; ready and waiting keep no hue.
const MIX: Record<keyof MilestoneMix, { label: string; tone?: UiTone }> = {
  landed: { label: 'landed', tone: 'muted' },
  landing: { label: 'landing', tone: 'info' },
  review: { label: 'in review', tone: 'success' },
  working: { label: 'working', tone: 'info' },
  needYou: { label: 'need you', tone: 'warning' },
  failed: { label: 'failed', tone: 'danger' },
  ready: { label: 'ready' },
  waiting: { label: 'draft or blocked' },
};

/** The bar: one segment per state, sized by its task count, landed first. */
function MixBar({ mix }: { mix: MilestoneMix }) {
  return (
    <span data-testid="milestone-mix" className={styles.mix}>
      {MIX_ORDER.map((key) =>
        mix[key] === 0 ? null : (
          <span
            key={key}
            data-mix={key}
            data-tone={MIX[key].tone}
            title={`${mix[key]} ${MIX[key].label}`}
            className={styles.mixSegment}
            // Each segment's share of the bar is its task count.
            style={{ flexGrow: mix[key] }}
          />
        )
      )}
    </span>
  );
}

/**
 * One milestone on the overview: title, due date and health, progress by state, the urgent
 * counts, and the task to start next. The card is one button named with the health and
 * progress too: a click selects the milestone (its waits light up and the inspector lists
 * its tasks), a double-click opens it. Memoised like the task card.
 */
export const MilestoneChartNode = memo(function MilestoneChartNode({
  id,
  title,
  status,
  mix,
  next,
  openCount,
  dueDate,
  selected,
  onSelect,
  onOpen,
}: {
  id: string;
  title: string;
  status: ContainerStatus;
  mix: MilestoneMix;
  next: TaskListItem | null;
  openCount: number;
  dueDate: string | null;
  selected: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const health = HEALTH[status.health];
  const finished = status.total > 0 && status.done === status.total;
  return (
    <button
      type="button"
      data-testid="milestone-node"
      data-kind="milestone"
      data-attention={status.health === 'attention' ? '' : undefined}
      data-finished={finished ? '' : undefined}
      data-selected={selected ? '' : undefined}
      aria-label={`${title}, ${health.label}, ${status.done} of ${status.total} landed${dueDate === null ? '' : `, due ${shortDate(dueDate)}`}`}
      aria-current={selected || undefined}
      title={title}
      className={styles.card}
      onClick={() => onSelect(id)}
      onDoubleClick={() => onOpen(id)}
    >
      <span className={styles.milestoneHead}>
        <span className={styles.milestoneTitle}>{title}</span>
        {dueDate !== null && (
          <span className={styles.due}>due {shortDate(dueDate)}</span>
        )}
        <span className={styles.health} data-tone={health.tone}>
          {health.label}
        </span>
      </span>
      <MixBar mix={mix} />
      <span className={styles.counts}>
        <span>
          <span className={styles.strong}>{status.done}</span>
          <span className={styles.quiet}>/{status.total} landed</span>
        </span>
        <span className={styles.spacer} />
        {CELLS.map((cell) => {
          const n = status[cell.key];
          // A zero counter is a glyph to decode for nothing: only what is there shows.
          if (n === 0) return null;
          return (
            <span
              key={cell.key}
              title={`${n} ${cell.label}`}
              data-testid={`milestone-node-${cell.key}`}
              data-tone={n > 0 ? cell.tone : undefined}
              className={styles.cell}
            >
              {cell.glyph} {n}
            </span>
          );
        })}
      </span>
      <span className={styles.next}>
        {next !== null ? (
          <>
            <span>Next</span>
            <span className={styles.nextId}>{next.meta.id}</span>
            <span className={styles.nextTitle}>{next.meta.title}</span>
          </>
        ) : (
          <span className={styles.nextTitle}>
            {finished
              ? 'All landed'
              : openCount === 0
                ? 'No open tasks'
                : `${openCount} open, none ready to start`}
          </span>
        )}
      </span>
    </button>
  );
});
