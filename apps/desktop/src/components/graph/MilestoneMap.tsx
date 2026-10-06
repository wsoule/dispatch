import type { TaskListItem } from '@dispatch-foo/core/browser';
import { useEffect, useMemo, useState } from 'react';

import type { TaskTab } from '../../lib/appNav';
import {
  type ContainerStatus,
  containerStatus,
} from '../../lib/containerStatus';
import { dagTaskFromDoc, fitNodeWidth } from '../../lib/dagLayout';
import type { ListGroup } from '../../lib/listGrouping';
import { milestonesToMermaid, tasksToMermaid } from '../../lib/mermaidExport';
import {
  milestoneMap,
  type MilestoneMix,
  milestoneMix,
  MIX_ORDER,
} from '../../lib/milestoneMap';
import type { TaskBucket } from '../../lib/taskStatus';
import {
  CELLS,
  HEALTH,
  MilestoneStatusCells,
  shortDate,
} from '../tasks/MilestoneStatusCells';
import { StatusIcon } from '../tasks/StatusIcon';
import { DependencyGraph } from './DependencyGraph';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

type GraphMode = 'milestones' | 'tasks';

// Nodes stretch to share the width between these bounds; the height fits the body below.
const NODE_MIN_WIDTH = 280;
const NODE_MAX_WIDTH = 380;
// Title, bar, counts and padding take 96px; each open-task row 20px; the footer 24px.
const NODE_BASE_HEIGHT = 96;
const NODE_ROW_HEIGHT = 20;
const NODE_FOOTER_HEIGHT = 24;
const NODE_MAX_ROWS = 4;
const WRAP = 6;

// Remembered per project; storage that throws just means it is not remembered.
function storedMode(key: string): GraphMode {
  try {
    return localStorage.getItem(key) === 'tasks' ? 'tasks' : 'milestones';
  } catch {
    return 'milestones';
  }
}

function storeMode(key: string, mode: GraphMode): void {
  try {
    localStorage.setItem(key, mode);
  } catch {
    // Kept for this session only.
  }
}

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
      className="bg-surface-secondary flex h-1.5 w-full gap-px overflow-hidden rounded-full"
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

// A row's marker for the states that want a look, in the top bar's glyphs.
const ROW_MARK: Partial<Record<TaskBucket, { glyph: string; tone: string }>> = {
  'need-you': { glyph: '●', tone: 'text-(--state-waiting-fg)' },
  failed: { glyph: '✕', tone: 'text-(--state-failed-fg)' },
  working: { glyph: '◐', tone: 'text-(--state-working-fg)' },
  review: { glyph: '◇', tone: 'text-(--state-review-fg)' },
};

/**
 * One milestone on the map: state, progress by status, urgent counts and its most urgent
 * open tasks. The title is the drill-in and stretches over the card; rows open their task.
 */
function MilestoneNode({
  title,
  status,
  mix,
  open,
  next,
  rows,
  waitsOn,
  dueDate,
  bucketOf,
  onOpen,
  onOpenTask,
}: {
  title: string;
  status: ContainerStatus;
  mix: MilestoneMix;
  open: readonly TaskListItem[];
  next: TaskListItem | null;
  /** How many open tasks fit in the body. */
  rows: number;
  /** Titles of the milestones this one waits on. */
  waitsOn: readonly string[];
  dueDate: string | null;
  bucketOf: (doc: TaskListItem) => TaskBucket | null;
  onOpen: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const health = HEALTH[status.health];
  const pct =
    status.total === 0 ? 0 : Math.round((status.done / status.total) * 100);
  const shown = open.slice(0, rows);
  const footer: string[] = [];
  if (open.length > shown.length) {
    footer.push(`+${open.length - shown.length} more open`);
  }
  if (waitsOn.length > 0) footer.push(`waits on ${waitsOn.join(', ')}`);
  return (
    <div
      data-testid="milestone-node"
      className={cn(
        'bg-surface-quaternary rounded-card shadow-card hover:bg-surface-hover relative flex h-full w-full flex-col gap-2 p-3 transition-colors duration-100',
        status.health === 'attention' && 'ring-1 ring-(--state-waiting-fg)'
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          title={`Open the flight plan for ${title}`}
          data-testid="milestone-node-open"
          className="after:rounded-card min-w-0 flex-1 truncate text-left text-[13px] font-semibold outline-none after:absolute after:inset-0 focus-visible:after:ring-1 focus-visible:after:ring-(--accent)"
        >
          {title}
        </button>
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
      {shown.length > 0 ? (
        <ul className="border-border flex flex-col border-t-[0.5px] pt-1">
          {shown.map((doc) => {
            const bucket = bucketOf(doc);
            const mark = bucket === null ? undefined : ROW_MARK[bucket];
            return (
              <li key={doc.meta.id}>
                <button
                  type="button"
                  onClick={() => onOpenTask(doc.meta.id)}
                  title={doc.meta.title}
                  data-testid="milestone-node-task"
                  className="rounded-control hover:bg-surface-secondary relative z-10 -mx-1 flex h-5 w-[calc(100%+8px)] min-w-0 items-center gap-1.5 px-1 text-left text-[12px]"
                >
                  <StatusIcon
                    status={doc.meta.status}
                    className="size-3 shrink-0"
                  />
                  <span className="text-muted-foreground font-book shrink-0 tracking-(--id-tracking)">
                    {doc.meta.id}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {doc.meta.title}
                  </span>
                  {doc === next ? (
                    <span className="text-muted-foreground shrink-0">next</span>
                  ) : (
                    mark !== undefined && (
                      <span className={cn('shrink-0', mark.tone)}>
                        {mark.glyph}
                      </span>
                    )
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <span className="border-border text-muted-foreground border-t-[0.5px] pt-2 text-[12px]">
          {status.total > 0 && status.done === status.total
            ? 'All landed'
            : 'No open tasks'}
        </span>
      )}
      {footer.length > 0 && (
        <span className="text-muted-foreground mt-auto truncate text-[12px]">
          {footer.join(' · ')}
        </span>
      )}
    </div>
  );
}

// The scroller's content width, kept current so nodes can share it.
function useContentWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const style = getComputedStyle(el);
      const padding =
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0);
      setWidth(el.clientWidth - padding);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}

export interface MilestoneMapViewProps {
  groups: readonly ListGroup[];
  bucketOf: (doc: TaskListItem) => TaskBucket | null;
  asksByTask: ReadonlyMap<string, number>;
  /** Keys the remembered Milestones | Tasks choice. */
  projectKey: string;
  /** A milestone's due date, if it has one. */
  dueDateOf?: (milestoneId: string) => string | null;
  onOpenTask: (taskId: string, tab?: TaskTab) => void;
}

/** The milestone map: milestones as nodes, waits between them as counted edges. */
export function MilestoneMapView({
  groups,
  bucketOf,
  asksByTask,
  projectKey,
  dueDateOf,
  onOpenTask,
}: MilestoneMapViewProps) {
  const storageKey = `dispatch:graph-mode:${projectKey}`;
  const [mode, setMode] = useState<GraphMode>(() => storedMode(storageKey));
  const [copied, setCopied] = useState(false);
  const map = useMemo(() => milestoneMap(groups), [groups]);
  const statusOf = useMemo(() => {
    const out = new Map<string, ContainerStatus>();
    for (const [id, children] of map.childrenOf) {
      out.set(id, containerStatus(children, { bucketOf, asksByTask }));
    }
    return out;
  }, [map, bucketOf, asksByTask]);
  const mixOf = useMemo(() => {
    const out = new Map<string, ReturnType<typeof milestoneMix>>();
    for (const [id, children] of map.childrenOf) {
      out.set(id, milestoneMix(children, { bucketOf }));
    }
    return out;
  }, [map, bucketOf]);
  const titleOf = new Map(map.nodes.map((n) => [n.id, n.title]));
  const [scrollerRef, available] = useContentWidth();
  // Every node shares one height: enough rows for the busiest, and a footer if any needs one.
  const openCounts = [...mixOf.values()].map((m) => m.open.length);
  const rows = Math.max(1, Math.min(NODE_MAX_ROWS, Math.max(0, ...openCounts)));
  const waitsOnOf = (id: string) =>
    map.edges
      .filter((e) => e.to === id)
      .map((e) => titleOf.get(e.from) ?? e.from);
  const footers = openCounts.some((n) => n > rows) || map.edges.length > 0;
  const nodeSize = useMemo(
    () => ({
      width: fitNodeWidth(map.nodes, {
        available,
        direction: 'LR',
        wrap: WRAP,
        min: NODE_MIN_WIDTH,
        max: NODE_MAX_WIDTH,
      }),
      height:
        NODE_BASE_HEIGHT +
        rows * NODE_ROW_HEIGHT +
        (footers ? NODE_FOOTER_HEIGHT : 0),
    }),
    [map.nodes, available, rows, footers]
  );
  const edgeOf = new Map(map.edges.map((e) => [`${e.from}\u0000${e.to}`, e]));
  const waits = map.edges.reduce((sum, e) => sum + e.count, 0);
  let landed = 0;
  let total = 0;
  for (const status of statusOf.values()) {
    landed += status.done;
    total += status.total;
  }

  const pick = (next: GraphMode) => {
    setMode(next);
    storeMode(storageKey, next);
  };

  const copy = () => {
    const text =
      mode === 'milestones'
        ? milestonesToMermaid(
            map.nodes.map((n) => ({
              id: n.id,
              title: n.title,
              done: statusOf.get(n.id)?.done ?? 0,
              total: statusOf.get(n.id)?.total ?? 0,
            })),
            map.edges
          )
        : tasksToMermaid(
            map.nodes.map((n) => ({
              id: n.id,
              title: n.title,
              tasks: (map.childrenOf.get(n.id) ?? []).map((doc) => ({
                id: doc.meta.id,
                title: doc.meta.title,
                blockedBy: doc.meta.blockedBy,
              })),
            }))
          );
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div data-testid="milestone-map" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-4 py-2">
        <div
          role="radiogroup"
          aria-label="Graph of"
          className="rounded-control border-border-chip bg-surface-secondary flex gap-0.5 border-[0.5px] p-0.5"
        >
          {(['milestones', 'tasks'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => pick(m)}
              className={cn(
                'rounded-[6px] px-2.5 py-0.5 text-[12px] capitalize',
                mode === m
                  ? 'bg-background shadow-card font-medium'
                  : 'text-muted-foreground'
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <span
          data-testid="milestone-map-summary"
          className="text-muted-foreground text-[12px] tabular-nums"
        >
          {map.nodes.length}{' '}
          {map.nodes.length === 1 ? 'milestone' : 'milestones'} ·{' '}
          {waits === 0
            ? 'no waits between them'
            : `${waits} ${waits === 1 ? 'wait' : 'waits'} between them`}{' '}
          · {landed}/{total} landed
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? 'Copied' : 'Copy as Mermaid'}
        </Button>
      </div>
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {mode === 'milestones' ? (
          <div className="flex min-h-full">
            <DependencyGraph
              className="m-auto"
              tasks={map.nodes}
              direction="LR"
              wrap={WRAP}
              nodeSize={nodeSize}
              ariaLabel="Milestone map"
              edgeLabel={(edge) =>
                edgeOf.get(`${edge.from}\u0000${edge.to}`)?.count.toString()
              }
              edgeHint={(edge) => {
                const found = edgeOf.get(`${edge.from}\u0000${edge.to}`);
                return found === undefined
                  ? undefined
                  : `${titleOf.get(edge.to)} waits on ${titleOf.get(edge.from)} ${found.count} ${found.count === 1 ? 'time' : 'times'}`;
              }}
              edgeTone={(edge) =>
                statusOf.get(edge.from)?.health === 'attention'
                  ? 'attention'
                  : 'default'
              }
              renderNode={(node) => (
                <MilestoneNode
                  title={node.title}
                  status={
                    statusOf.get(node.id) ??
                    containerStatus([], { bucketOf, asksByTask })
                  }
                  {...(mixOf.get(node.id) ?? milestoneMix([], { bucketOf }))}
                  rows={rows}
                  waitsOn={waitsOnOf(node.id)}
                  bucketOf={bucketOf}
                  onOpenTask={(id) => onOpenTask(id)}
                  dueDate={dueDateOf?.(node.id) ?? null}
                  onOpen={() => onOpenTask(node.id, 'plan')}
                />
              )}
              empty={{
                heading: 'No milestones yet',
                description:
                  'Group tasks under milestones to see how they wait on each other.',
              }}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {map.nodes.map((node) => {
              const status = statusOf.get(node.id);
              return (
                <section key={node.id} aria-label={titleOf.get(node.id)}>
                  <div className="flex items-center gap-3 py-2">
                    <button
                      type="button"
                      onClick={() => onOpenTask(node.id, 'plan')}
                      title={`Open the flight plan for ${node.title}`}
                      className="text-[13px] font-semibold hover:underline"
                    >
                      {node.title}
                    </button>
                    {status !== undefined && (
                      <MilestoneStatusCells
                        status={status}
                        dueDate={dueDateOf?.(node.id) ?? null}
                      />
                    )}
                  </div>
                  <DependencyGraph
                    tasks={(map.childrenOf.get(node.id) ?? []).map(
                      dagTaskFromDoc
                    )}
                    direction="LR"
                    wrap={WRAP}
                    refFor={(id) => id}
                    onOpenNode={(id) => onOpenTask(id)}
                    ariaLabel={`Tasks in ${node.title}`}
                  />
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
