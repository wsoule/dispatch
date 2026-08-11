import type { TaskDoc } from '@dispatch/core/browser';
import { Waypoints } from 'lucide-react';
import { useMemo } from 'react';

import { type DagEdge, dagLayout, type DagNode } from '../../lib/dagLayout';
import { statusTone } from '../../lib/taskDisplay';
import { resolveStatusVisual } from './StatusIcon';
import { cn } from '@/lib/utils';

// Reuses statusTone's six-tone vocabulary rather than inventing a second status->color map for
// the SVG rect/dot below. The actual status->tone *resolution* comes from `resolveStatusVisual`
// (StatusIcon's own logic) so a node's border/fill/dot always agree with the StatusIcon glyph
// shown everywhere else in the app for that status — `statusTone` alone is only the fallback
// `resolveStatusVisual` uses for custom, non-built-in statuses. `ReturnType` avoids needing
// taskDisplay.ts to export its otherwise-private `Tone` type just for this one Record key.
type Tone = ReturnType<typeof statusTone>;

const TONE_NODE_CLASSES: Record<
  Tone,
  { stroke: string; fill: string; dot: string }
> = {
  green: {
    stroke: 'stroke-emerald-500 dark:stroke-emerald-400',
    fill: 'fill-emerald-500/10 dark:fill-emerald-400/10',
    dot: 'fill-emerald-500 dark:fill-emerald-400',
  },
  blue: {
    stroke: 'stroke-blue-500 dark:stroke-blue-400',
    fill: 'fill-blue-500/10 dark:fill-blue-400/10',
    dot: 'fill-blue-500 dark:fill-blue-400',
  },
  amber: {
    stroke: 'stroke-amber-500 dark:stroke-amber-400',
    fill: 'fill-amber-500/10 dark:fill-amber-400/10',
    dot: 'fill-amber-500 dark:fill-amber-400',
  },
  red: {
    stroke: 'stroke-destructive',
    fill: 'fill-destructive/10',
    dot: 'fill-destructive',
  },
  gray: {
    stroke: 'stroke-border',
    fill: 'fill-transparent',
    dot: 'fill-muted-foreground/60',
  },
  accent: {
    stroke: 'stroke-primary',
    fill: 'fill-primary/10',
    dot: 'fill-primary',
  },
};

// Node titles are drawn as plain SVG <text>, which has no CSS text-overflow support worth
// relying on cross-browser — this approximates how many characters fit the fixed node width at
// the font size used below and just slices, rather than pulling in canvas text measurement for
// a label that only ever needs to read "roughly right", not pixel-exact.
const MAX_TITLE_CHARS = 24;
// The status line sits below the title at a smaller font size but sees the same fixed node
// width, so it gets its own (shorter) budget rather than reusing MAX_TITLE_CHARS — a custom
// project status can be an arbitrarily long word with no natural break point, unlike a title.
const MAX_STATUS_CHARS = 16;

function truncate(text: string, maxChars: number = MAX_TITLE_CHARS): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

interface DagNodeShapeProps {
  node: DagNode;
  onOpenTask?: (taskId: string) => void;
}

// One task's box: a status-tinted rounded rect, a small status dot, and two lines of text
// (truncated title, then the raw status string) — the "SVG rect + two text lines" the design
// brief picked over a foreignObject for crispness at any zoom. Rendered as a `<g>` rather than
// a real DOM button (SVG has no button element) so it can still be keyboard-activated when
// `onOpenTask` is given.
function DagNodeShape({ node, onOpenTask }: DagNodeShapeProps) {
  const tone = TONE_NODE_CLASSES[resolveStatusVisual(node.status).tone];
  const clickable = onOpenTask !== undefined;

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      className={cn('group/node', clickable && 'cursor-pointer')}
      onClick={clickable ? () => onOpenTask(node.id) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenTask(node.id);
              }
            }
          : undefined
      }
      aria-label={clickable ? `Open task ${node.title}` : undefined}
    >
      <title>{node.title}</title>
      <rect
        width={node.width}
        height={node.height}
        rx={8}
        className={cn(
          'stroke-[1.5] transition-colors duration-150',
          tone.stroke,
          tone.fill,
          clickable && 'group-hover/node:fill-accent/40'
        )}
      />
      <circle cx={14} cy={16} r={4} className={tone.dot} />
      <text
        x={24}
        y={20}
        className="fill-foreground font-sans text-[12px] font-medium"
      >
        {truncate(node.title)}
      </text>
      <text
        x={14}
        y={38}
        className="fill-muted-foreground font-sans text-[10px]"
      >
        <title>{node.status}</title>
        {truncate(node.status, MAX_STATUS_CHARS)}
      </text>
    </g>
  );
}

// A vertical cubic-bezier from the blocker's bottom edge to the dependent's top edge — curved
// per the design brief rather than a straight line, so overlapping edges through a busy middle
// layer stay visually separable. The bezier's control points sit at the vertical midpoint
// directly below/above each endpoint, which is what gives it a gentle S-curve rather than a
// kinked line when the two nodes aren't in the same column.
function EdgePath({
  edge,
  nodesById,
}: {
  edge: DagEdge;
  nodesById: Map<string, DagNode>;
}) {
  const from = nodesById.get(edge.from);
  const to = nodesById.get(edge.to);
  if (from === undefined || to === undefined) return null;

  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height;
  const toX = to.x + to.width / 2;
  const toY = to.y;
  const midY = (fromY + toY) / 2;

  return (
    <path
      d={`M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`}
      className="stroke-border fill-none"
      strokeWidth={1.5}
      markerEnd="url(#epic-dag-arrow)"
    />
  );
}

export interface EpicDagViewProps {
  /** The epic's children — dagLayout derives layering/edges from `blockedBy` links among just
   * this set (see dagLayout.ts's "real edges only" rule); a blockedBy id pointing outside it
   * is treated the same as a dangling one. */
  tasks: TaskDoc[];
  /** Opens the clicked node's task in the peek/detail dialog. Omitted renders every node as
   * plain, non-interactive text — matching StackRail's `onOpenTask`-optional convention. */
  onOpenTask?: (taskId: string) => void;
  className?: string;
}

/**
 * True-branching dependency graph for one epic's tasks — the DAG view deferred from the
 * stacked-task spec (StackRail linearizes diamonds; this renders them as actual branches).
 * Pure SVG, laid out by the hand-rolled `dagLayout` (no charting dependency): edges as curved
 * paths, nodes as status-tinted rect+text boxes. The SVG is sized exactly to its content and
 * left to the caller's `overflow-x-auto` container to scroll — no pan/zoom, per the design
 * brief (an epic's task count never approaches needing it).
 */
export function EpicDagView({
  tasks,
  onOpenTask,
  className,
}: EpicDagViewProps) {
  const layout = useMemo(() => dagLayout(tasks), [tasks]);

  if (tasks.length === 0) {
    return (
      <div
        className={cn(
          'text-muted-foreground flex flex-col items-center justify-center gap-2 py-12 text-center',
          className
        )}
      >
        <Waypoints className="size-5" />
        <p className="text-[13px]">No tasks yet.</p>
      </div>
    );
  }

  const nodesById = new Map(layout.nodes.map((n) => [n.id, n]));

  return (
    <div className={cn('overflow-x-auto', className)}>
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label="Epic dependency graph"
      >
        <defs>
          <marker
            id="epic-dag-arrow"
            viewBox="0 0 8 8"
            refX={4}
            refY={4}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" className="fill-border" />
          </marker>
        </defs>
        <g>
          {layout.edges.map((edge) => (
            <EdgePath
              key={`${edge.from}->${edge.to}`}
              edge={edge}
              nodesById={nodesById}
            />
          ))}
        </g>
        <g>
          {layout.nodes.map((node) => (
            <DagNodeShape key={node.id} node={node} onOpenTask={onOpenTask} />
          ))}
        </g>
      </svg>
    </div>
  );
}
