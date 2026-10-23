import type { TaskListItem } from '@dispatch-foo/core/browser';
import { memo } from 'react';

import type { ContainerStatus } from '../../lib/containerStatus';
import type { ChartState, ChartTask } from '../../lib/dependencyChart';
import { type MilestoneMix, MIX_ORDER } from '../../lib/milestoneMap';
import { CELLS, HEALTH, shortDate } from '../tasks/MilestoneStatusCells';
import { StatusIcon } from '../tasks/StatusIcon';
import { cn } from '@/lib/utils';
import { TextButton } from '@/ui/ai/text-button';

/** Fixed node footprints: the layout needs every box before anything renders, and each
 * card fills its box (`h-full`) so routed edges meet its actual edge. A task card is 8px
 * padding around a 16px id row and two 17px title lines, plus a 16px kicker line (and its
 * 2px gap) when cards are not boxed by milestone. A milestone card is 12px padding around
 * the title row (19.5px at the body's 1.5 line height), the 6px bar, the 18px counts and
 * next rows and three 8px gaps: 109.5px, rounded up. */
export const TASK_NODE = { width: 220, height: 68, kicker: 18 };
export const MILESTONE_NODE = { width: 268, height: 112 };

// A tint laid over the opaque card surface: the state surfaces are translucent in dark
// mode, and a see-through card would show the canvas dots and the edges behind it.
const tint = (token: string) =>
  `bg-[linear-gradient(var(${token}),var(${token}))]`;

/**
 * How each state draws on the chart: the card's ring and fill, the colour of its state word,
 * and a CSS colour for the legend. Moving and attention states reuse the app's state tokens;
 * ready gets a heavier neutral ring rather than a hue (the tokens keep ready free of colour on
 * purpose); landed is dashed and quiet, since it only explains the chains.
 */
export const CHART_STATE: Record<
  ChartState,
  { label: string; card: string; text: string; color: string }
> = {
  'need-you': {
    label: 'Needs you',
    card: cn(
      tint('--state-waiting-surface'),
      'ring-[1.5px] ring-(--state-waiting-fg)'
    ),
    text: 'text-(--state-waiting-fg)',
    color: 'var(--state-waiting-fg)',
  },
  failed: {
    label: 'Failed',
    card: cn(
      tint('--state-failed-surface'),
      'ring-[1.5px] ring-(--state-failed-fg)'
    ),
    text: 'text-(--state-failed-fg)',
    color: 'var(--state-failed-fg)',
  },
  working: {
    label: 'Working',
    card: cn(
      tint('--state-working-surface'),
      'ring-1 ring-(--state-working-edge)'
    ),
    text: 'text-(--state-working-fg)',
    color: 'var(--state-working-fg)',
  },
  review: {
    label: 'In review',
    card: cn(
      tint('--state-review-surface'),
      'ring-1 ring-(--state-review-edge)'
    ),
    text: 'text-(--state-review-fg)',
    color: 'var(--state-review-fg)',
  },
  landing: {
    label: 'Landing',
    card: cn(
      tint('--state-landing-surface'),
      'ring-1 ring-(--state-landing-edge)'
    ),
    text: 'text-(--state-landing-fg)',
    color: 'var(--state-landing-fg)',
  },
  ready: {
    label: 'Ready',
    card: 'ring-[1.5px] ring-(--text-secondary)',
    text: 'text-(--text-secondary)',
    color: 'var(--text-secondary)',
  },
  blocked: {
    label: 'Blocked',
    card: '',
    text: 'text-muted-foreground',
    color: 'var(--state-blocked-fg)',
  },
  draft: {
    label: 'Draft',
    card: '',
    text: 'text-muted-foreground',
    color: 'var(--status-backlog)',
  },
  landed: {
    label: 'Landed',
    // An inset outline rather than a border, so the dash takes no room from the content.
    card: 'bg-surface-secondary outline-1 outline-dashed -outline-offset-1 outline-(--border-strong) shadow-none',
    text: 'text-muted-foreground',
    color: 'var(--status-done)',
  },
};

/** The legend's order: what needs a look first, then what moves, then the rest. */
export const STATE_ORDER: readonly ChartState[] = [
  'need-you',
  'failed',
  'working',
  'review',
  'landing',
  'ready',
  'blocked',
  'draft',
  'landed',
];

// The card every chart node shares; state and selection layer rings and fills over it.
const CARD =
  'bg-surface-quaternary rounded-card shadow-card relative flex h-full w-full flex-col';

// The selection: an ink outline outside the card, so the state ring stays visible and the
// indigo focus ring stays the only indigo ring (the accent is reserved for focus).
const SELECTED =
  'outline-2 outline-solid outline-offset-2 outline-(--text-primary)';

/** A legend swatch: a tiny card in the state's own ring and fill. */
export function StateSwatch({ state }: { state: ChartState }) {
  return (
    <span
      aria-hidden
      className={cn(
        'bg-surface-quaternary rounded-chip shadow-card inline-block h-2.5 w-4 shrink-0',
        CHART_STATE[state].card
      )}
    />
  );
}

/**
 * One task on the chart: its milestone as a kicker, status glyph, id and state word, then the
 * title over two lines. The title is the card's single control, stretched over the whole card
 * and named with the id and state too: a click selects (traces) the task, a double-click
 * opens it. Memoised, with handlers that take the id, so a selection only re-renders the
 * cards whose `selected` changes.
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
  const tone = CHART_STATE[task.state];
  return (
    <div
      data-testid="chart-task"
      data-state={task.state}
      className={cn(
        CARD,
        'gap-0.5 px-2.5 py-2',
        tone.card,
        selected && SELECTED
      )}
    >
      {showMilestone && (
        <span className="text-muted-foreground truncate text-[11px] leading-4">
          {task.milestoneTitle}
        </span>
      )}
      <span className="flex min-w-0 items-center gap-1.5 leading-4">
        <StatusIcon status={task.status} className="size-3.5 shrink-0" />
        <span
          className={cn(
            'font-book min-w-0 truncate text-[12px] tracking-(--id-tracking)',
            task.state === 'landed'
              ? 'text-(--text-ghost)'
              : 'text-muted-foreground'
          )}
        >
          {task.id}
        </span>
        <span
          className={cn('ml-auto shrink-0 text-[11px] font-medium', tone.text)}
        >
          {tone.label}
        </span>
      </span>
      <TextButton
        stretch
        aria-label={`${task.id} ${task.title}, ${tone.label}`}
        aria-current={selected || undefined}
        title={task.title}
        onClick={() => onSelect(task.id)}
        onDoubleClick={() => onOpen(task.id)}
        className={cn(
          'text-[13px] leading-[17px] font-medium whitespace-normal',
          task.state === 'landed' ? 'text-muted-foreground' : 'text-foreground'
        )}
      >
        {/* The clamp sits on a span: a button ignores -webkit-line-clamp. */}
        <span className="line-clamp-2">{task.title}</span>
      </TextButton>
    </div>
  );
});

const MIX: Record<keyof MilestoneMix, { label: string; fill: string }> = {
  landed: { label: 'landed', fill: 'bg-(--text-secondary)' },
  landing: { label: 'landing', fill: 'bg-(--state-landing-fg)' },
  review: { label: 'in review', fill: 'bg-(--state-review-fg)' },
  working: { label: 'working', fill: 'bg-(--state-working-fg)' },
  needYou: { label: 'need you', fill: 'bg-(--state-waiting-fg)' },
  failed: { label: 'failed', fill: 'bg-(--state-failed-fg)' },
  ready: { label: 'ready', fill: 'bg-(--text-ghost)' },
  waiting: { label: 'draft or blocked', fill: '' },
};

/** The bar: one segment per state, sized by its task count, landed first. */
function MixBar({ mix }: { mix: MilestoneMix }) {
  return (
    <span
      data-testid="milestone-mix"
      className="bg-surface-secondary flex h-1.5 w-full shrink-0 gap-px overflow-hidden rounded-full"
    >
      {MIX_ORDER.map((key) =>
        mix[key] === 0 ? null : (
          <span
            key={key}
            data-mix={key}
            title={`${mix[key]} ${MIX[key].label}`}
            className={cn('h-full', MIX[key].fill)}
            style={{ flexGrow: mix[key], flexBasis: 0 }}
          />
        )
      )}
    </span>
  );
}

/**
 * One milestone on the overview: title, due date and health, progress by state, the urgent
 * counts, and the task to start next. The title is stretched over the card and named with the
 * health and progress too: a click selects the milestone (its waits light up and the
 * inspector lists its tasks), a double-click opens its flight plan. Memoised like the task
 * card.
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
  const pct =
    status.total === 0 ? 0 : Math.round((status.done / status.total) * 100);
  return (
    <div
      data-testid="milestone-node"
      className={cn(
        CARD,
        'gap-2 p-3',
        status.health === 'attention' && 'ring-1 ring-(--state-waiting-fg)',
        status.total > 0 &&
          status.done === status.total &&
          'bg-surface-secondary',
        selected && SELECTED
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <TextButton
          stretch
          aria-label={`${title}, ${health.label}, ${status.done} of ${status.total} landed${dueDate === null ? '' : `, due ${shortDate(dueDate)}`}`}
          aria-current={selected || undefined}
          title={title}
          onClick={() => onSelect(id)}
          onDoubleClick={() => onOpen(id)}
          data-testid="milestone-node-select"
          className="flex-1 text-[13px] font-semibold"
        >
          {title}
        </TextButton>
        {dueDate !== null && (
          <span className="text-muted-foreground shrink-0 text-[12px]">
            due {shortDate(dueDate)}
          </span>
        )}
        <span
          className={cn(
            'rounded-pill shrink-0 px-2 py-px text-[11px]',
            health.tone
          )}
        >
          {health.label}
        </span>
      </span>
      <MixBar mix={mix} />
      <span className="flex items-center gap-2.5 text-[12px] tabular-nums">
        <span>
          <span className="font-semibold">{status.done}</span>
          <span className="text-muted-foreground">
            /{status.total} landed · {pct}%
          </span>
        </span>
        <span className="flex-1" />
        {CELLS.map((cell) => {
          const n = status[cell.key];
          return (
            <span
              key={cell.key}
              title={`${n} ${cell.label}`}
              data-testid={`milestone-node-${cell.key}`}
              className={
                n > 0 ? cn(cell.tone, 'font-semibold') : 'text-(--text-ghost)'
              }
            >
              {cell.glyph} {n}
            </span>
          );
        })}
      </span>
      <span className="text-muted-foreground mt-auto flex min-w-0 items-center gap-1.5 text-[12px]">
        {next !== null ? (
          <>
            <span className="shrink-0">Next</span>
            <span className="font-book shrink-0 tracking-(--id-tracking)">
              {next.meta.id}
            </span>
            <span className="min-w-0 truncate text-(--text-secondary)">
              {next.meta.title}
            </span>
          </>
        ) : (
          <span className="truncate">
            {status.total > 0 && status.done === status.total
              ? 'All landed'
              : openCount === 0
                ? 'No open tasks'
                : `${openCount} open, none ready to start`}
          </span>
        )}
      </span>
    </div>
  );
});
