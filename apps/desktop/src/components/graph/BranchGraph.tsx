import type { StatusModel } from '@dispatch-foo/core/browser';
import { isDoneStatus, isStartedStatus } from '@dispatch-foo/core/browser';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import {
  type BranchEdge,
  type BranchLayout,
  branchLayout,
  type BranchRow,
} from '../../lib/branchLayout';
import type { DagTask } from '../../lib/dagLayout';
import { useActiveStatusModel } from '../../lib/statusModel';
import { statusColor, StatusIcon } from '../tasks/StatusIcon';
import { cn } from '@/lib/utils';

// Fixed geometry: every line is 28px (the compact answer to the 36px list row) so the
// gutter's dots and the titles share one grid; lanes sit 16px apart from a 12px left edge.
export const BRANCH_LINE_HEIGHT = 28;
const LANE_PITCH = 16;
const GUTTER_PAD = 12;
const DOT_RADIUS = 4;
// Off-path dots draw a size down so the path reads by weight, never by colour alone.
const MUTED_DOT_RADIUS = 3;
const HALO_RADIUS = 6.5;
const PATH_STROKE = 2;
const MUTED_STROKE = 1;
const STRONG = 'var(--border-strong)';
const MUTED = 'var(--border-default)';
// A cycle's back-edge sits this far right of its lane so it is not lost under the forward edge.
const BACK_EDGE_OFFSET = 2;

type DotKind = 'done' | 'open' | 'live';

// Liveness is the status's type (started), read from the task's own status rather than a
// run-state prop so the gutter never disagrees with the status glyph beside it; the live-run
// mark itself arrives through `accessoryFor`.
function dotKind(status: string, model: StatusModel): DotKind {
  if (isDoneStatus(status, model)) return 'done';
  if (isStartedStatus(status, model)) return 'live';
  return 'open';
}

/** Gutter width for a layout of `laneCount` lanes: padding either side of the lane span. */
function gutterWidth(laneCount: number): number {
  return GUTTER_PAD * 2 + LANE_PITCH * Math.max(0, laneCount - 1);
}

function laneX(lane: number): number {
  return GUTTER_PAD + lane * LANE_PITCH;
}

function rowY(row: number): number {
  return row * BRANCH_LINE_HEIGHT + BRANCH_LINE_HEIGHT / 2;
}

interface BranchDotProps {
  row: BranchRow;
  status: string;
  model: StatusModel;
  onOpen?: () => void;
}

/** One commit dot: filled for a finished task, a ring for an open one, filled plus a halo
 * ring for a live one — all in the status's own colour from `StatusIcon`'s map, so the
 * gutter and the glyph beside it always agree. On-path dots are the full radius, off-path
 * a size down. */
function BranchDot({ row, status, model, onOpen }: BranchDotProps) {
  const kind = dotKind(status, model);
  const color = statusColor(status, model);
  const cx = laneX(row.lane);
  const cy = rowY(row.row);
  const r = row.onPath ? DOT_RADIUS : MUTED_DOT_RADIUS;
  return (
    <g data-slot="branch-dot-group">
      {kind === 'live' && (
        <circle
          data-slot="branch-dot-halo"
          cx={cx}
          cy={cy}
          r={HALO_RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={1}
          strokeOpacity={0.45}
        />
      )}
      <circle
        data-slot="branch-dot"
        data-dot={kind}
        data-path={row.onPath || undefined}
        cx={cx}
        cy={cy}
        r={r}
        fill={kind === 'open' ? 'var(--surface-page)' : color}
        stroke={color}
        strokeWidth={1.5}
        className={cn(
          onOpen !== undefined && 'pointer-events-auto cursor-pointer'
        )}
        onClick={onOpen}
      />
    </g>
  );
}

type DotRows = Map<number, number[]>;

/** The rows holding a dot on each lane, ascending — what `edgePath` consults to keep a fork's
 * straight run off another branch's dot. */
function dotRowsByLane(rows: BranchRow[]): DotRows {
  const byLane: DotRows = new Map();
  for (const row of rows) {
    const bucket = byLane.get(row.lane);
    if (bucket !== undefined) bucket.push(row.row);
    else byLane.set(row.lane, [row.row]);
  }
  for (const bucket of byLane.values()) bucket.sort((a, b) => a - b);
  return byLane;
}

// Which gap an edge bends across, by direction. An outward fork (to a higher lane) bends in
// the first gap below its source and runs the rest straight down the target lane — bending
// late would run it down the source lane through every dot in between, and lane 0 always has
// dots below a trunk blocker, so the diamond's A→C would read as B→C. The layout only holds a
// forked lane from the branch task's own row, though, so when a released lane was reused above
// the target the bend drops to the gap below the last dot in the way. An inward merge bends in
// the last gap above its target: the source's side lane is held for it until this dependent is
// placed, so the straight run down it is free.
function bendRow(edge: BranchEdge, dotRows: DotRows): number {
  if (edge.toLane < edge.fromLane) return edge.toRow - 1;
  let last = edge.fromRow;
  for (const row of dotRows.get(edge.toLane) ?? []) {
    if (row > edge.fromRow && row < edge.toRow) last = row;
  }
  return last;
}

// One edge as SVG path data: straight down its lane when both ends share one, otherwise a
// straight run plus one S-bend across the lanes in `EdgePath`'s cubic-bezier idiom (control
// points at the gap's vertical midpoint, so the bend is gentle rather than a kink). Ends stop
// a dot radius short of each centre so the stroke never crosses a dot.
function edgePath(edge: BranchEdge, dotRows: DotRows): string {
  const fromX = laneX(edge.fromLane);
  const toX = laneX(edge.toLane);
  const fromY = rowY(edge.fromRow) + DOT_RADIUS;
  const toY = rowY(edge.toRow) - DOT_RADIUS;

  // A cycle's back-edge points upward, offset so it stays visible beside the forward edge.
  if (edge.toRow <= edge.fromRow) {
    const dx = BACK_EDGE_OFFSET;
    return `M ${fromX + dx} ${rowY(edge.fromRow) - DOT_RADIUS} L ${toX + dx} ${rowY(edge.toRow) + DOT_RADIUS}`;
  }
  if (edge.fromLane === edge.toLane) {
    return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  }
  const bend = bendRow(edge, dotRows);
  const bendStartY = bend === edge.fromRow ? fromY : rowY(bend) + DOT_RADIUS;
  const bendEndY = rowY(bend + 1) - DOT_RADIUS;
  const midY = (bendStartY + bendEndY) / 2;
  const before = bendStartY > fromY ? ` L ${fromX} ${bendStartY}` : '';
  const after = bendEndY < toY ? ` L ${toX} ${toY}` : '';
  return `M ${fromX} ${fromY}${before} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${bendEndY}${after}`;
}

/**
 * The trunk is one continuous line in a git log, so consecutive lane-0 rows are joined even
 * when no edge links them (a flat milestone's isolated tasks). Side lanes get no such
 * filler: the layout reuses a released lane for a later branch, and a line between the two
 * would invent a dependency. Pairs an edge already draws are skipped.
 */
function trunkSegments(
  rows: BranchRow[],
  edges: BranchEdge[]
): Array<{ fromRow: number; toRow: number; onPath: boolean }> {
  const drawn = new Set(
    edges
      .filter((e) => e.fromLane === 0 && e.toLane === 0)
      .map((e) => `${e.fromRow}->${e.toRow}`)
  );
  const trunk = rows.filter((r) => r.lane === 0).sort((a, b) => a.row - b.row);
  const segments: Array<{ fromRow: number; toRow: number; onPath: boolean }> =
    [];
  for (let i = 1; i < trunk.length; i++) {
    const prev = trunk[i - 1];
    const next = trunk[i];
    if (
      prev === undefined ||
      next === undefined ||
      drawn.has(`${prev.row}->${next.row}`)
    ) {
      continue;
    }
    segments.push({
      fromRow: prev.row,
      toRow: next.row,
      onPath: prev.onPath && next.onPath,
    });
  }
  return segments;
}

interface BranchLineProps {
  task: DagTask;
  row: BranchRow;
  refLabel: string;
  accessory?: ReactNode;
  focused: boolean;
  gutter: number;
  onOpen?: () => void;
}

/** One 28px line: status glyph, sans id in the id tracking, one-line title, trailing slot.
 * On-path lines carry `data-path` and the full foreground; off-path lines read in the
 * secondary text. The focused line is marked with the neutral active surface — never the
 * accent — and keyboard focus on the button itself takes the same wash. The line spans the gutter too (the SVG floats over it without pointer events) so
 * clicking a dot's whitespace opens the task and the focus wash covers the whole row. */
function BranchLine({
  task,
  row,
  refLabel,
  accessory,
  focused,
  gutter,
  onOpen,
}: BranchLineProps) {
  const content = (
    <>
      <StatusIcon status={task.status} className="size-3.5 shrink-0" />
      <span
        data-slot="branch-line-id"
        className="font-book shrink-0 tracking-(--id-tracking) text-(--text-muted) tabular-nums"
      >
        {refLabel}
      </span>
      <span
        data-slot="branch-line-title"
        className={cn(
          'min-w-0 flex-1 truncate text-left font-medium',
          row.onPath ? 'text-foreground' : 'text-(--text-secondary)'
        )}
      >
        {task.title}
      </span>
      {accessory !== undefined && (
        <span
          data-slot="branch-line-trailing"
          className="ml-auto flex shrink-0 items-center gap-1.5"
        >
          {accessory}
        </span>
      )}
    </>
  );

  const className = cn(
    'flex w-full items-center gap-2 rounded-control pr-3 text-[13px] leading-4 outline-none transition-colors duration-100',
    onOpen !== undefined &&
      'hover:bg-surface-hover focus-visible:bg-surface-active cursor-pointer',
    focused && 'bg-surface-active'
  );
  const style = { height: BRANCH_LINE_HEIGHT, paddingLeft: gutter };
  const data = {
    'data-slot': 'branch-line',
    'data-task-id': task.id,
    'data-path': row.onPath || undefined,
    'data-focused': focused || undefined,
  };

  if (onOpen !== undefined) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={task.title}
        className={className}
        style={style}
        {...data}
      >
        {content}
      </button>
    );
  }
  return (
    <div title={task.title} className={className} style={style} {...data}>
      {content}
    </div>
  );
}

export interface BranchGraphProps {
  /** One milestone's tasks — `branchLayout` derives rows, lanes and edges from `blockedBy`
   * links inside just this set (a blocker filtered out is simply not an edge). */
  tasks: DagTask[];
  /** Short sans id per row (defaults to the task id). */
  refFor?: (id: string) => string | undefined;
  /** The trailing slot per row — the live-run mark, an assignee avatar. */
  accessoryFor?: (id: string) => ReactNode;
  /** Opens the clicked row. Omitted renders every line as plain, non-interactive text. */
  onOpenNode?: (id: string) => void;
  /** The roving keyboard cursor; that line is marked with the active surface. */
  focusedId?: string | null;
  /** The project's statuses, which type each dot; defaults to the open project's. */
  model?: StatusModel;
  ariaLabel?: string;
  className?: string;
  /** `branchLayout(tasks)` when the caller already has it. */
  layout?: BranchLayout;
  /** Draw only lines `start`..`end - 1`, with the gutter clipped to the same band — one
   * slice of a long graph drawn in virtualized bands. Omitted draws every line. */
  band?: { start: number; end: number };
}

/**
 * One milestone as a mermaid-gitGraph-style stack of 28px lines: a hand-drawn SVG gutter on
 * the left carries the commit dots, the trunk line and the bezier fork/merge edges from
 * `branchLayout`, and each line beside it is real DOM — a selectable title, a focusable
 * button — never SVG text. The critical path is lane 0 drawn strong; everything else is
 * muted, so the path reads without colour. Sized to its rows and left to the caller's
 * container to scroll — no pan/zoom, for `DependencyGraph`'s reason (a milestone's task
 * count never approaches needing it).
 */
export function BranchGraph({
  tasks,
  refFor,
  accessoryFor,
  onOpenNode,
  focusedId = null,
  ariaLabel = 'Branch graph',
  className,
  layout: givenLayout,
  band,
  model: modelProp,
}: BranchGraphProps) {
  const activeModel = useActiveStatusModel();
  const model = modelProp ?? activeModel;
  const layout = useMemo(
    () => givenLayout ?? branchLayout(tasks, model),
    [givenLayout, tasks, model]
  );
  const tasksById = useMemo(
    () => new Map(tasks.map((t) => [t.id, t])),
    [tasks]
  );

  if (tasks.length === 0) {
    return (
      <div
        data-slot="branch-graph-empty"
        className={cn(
          'font-book flex items-center px-3 text-[13px] text-(--text-muted)',
          className
        )}
        style={{ height: BRANCH_LINE_HEIGHT }}
      >
        No tasks
      </div>
    );
  }

  const gutter = gutterWidth(layout.laneCount);
  const first = band?.start ?? 0;
  const last = band?.end ?? layout.rows.length;
  const inBand = (row: number) => row >= first && row < last;
  const crosses = (from: number, to: number) =>
    Math.max(from, to) >= first && Math.min(from, to) < last;
  const height = (last - first) * BRANCH_LINE_HEIGHT;
  const onPathIds = new Set(layout.path);
  const trunk = trunkSegments(layout.rows, layout.edges);
  const dotRows = dotRowsByLane(layout.rows);

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-slot="branch-graph"
      className={cn('relative', className)}
    >
      {layout.rows.map((row) => {
        const task = tasksById.get(row.id);
        if (task === undefined || !inBand(row.row)) return null;
        return (
          <BranchLine
            key={row.id}
            task={task}
            row={row}
            refLabel={refFor?.(row.id) ?? row.id}
            accessory={accessoryFor?.(row.id)}
            focused={focusedId === row.id}
            gutter={gutter}
            onOpen={
              onOpenNode === undefined ? undefined : () => onOpenNode(row.id)
            }
          />
        );
      })}
      <svg
        data-slot="branch-gutter"
        width={gutter}
        height={height}
        viewBox={`0 ${first * BRANCH_LINE_HEIGHT} ${gutter} ${height}`}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0"
      >
        {trunk.map((segment) =>
          crosses(segment.fromRow, segment.toRow) ? (
            <path
              key={`trunk:${segment.fromRow}->${segment.toRow}`}
              data-slot="branch-lane"
              data-path={segment.onPath || undefined}
              d={`M ${laneX(0)} ${rowY(segment.fromRow) + DOT_RADIUS} L ${laneX(0)} ${rowY(segment.toRow) - DOT_RADIUS}`}
              fill="none"
              stroke={segment.onPath ? STRONG : MUTED}
              strokeWidth={segment.onPath ? PATH_STROKE : MUTED_STROKE}
            />
          ) : null
        )}
        {layout.edges.map((edge) => {
          if (!crosses(edge.fromRow, edge.toRow)) return null;
          const onPath = onPathIds.has(edge.from) && onPathIds.has(edge.to);
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              data-slot="branch-edge"
              data-path={onPath || undefined}
              d={edgePath(edge, dotRows)}
              fill="none"
              stroke={onPath ? STRONG : MUTED}
              strokeWidth={onPath ? PATH_STROKE : MUTED_STROKE}
            />
          );
        })}
        {layout.rows.map((row) => {
          const task = tasksById.get(row.id);
          if (task === undefined || !inBand(row.row)) return null;
          return (
            <BranchDot
              key={row.id}
              row={row}
              status={task.status}
              model={model}
              onOpen={
                onOpenNode === undefined ? undefined : () => onOpenNode(row.id)
              }
            />
          );
        })}
      </svg>
    </div>
  );
}
