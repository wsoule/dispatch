import { statusLabel } from '@dispatch-foo/core/browser';
import { Waypoints } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import {
  type DagDirection,
  type DagEdge,
  dagLayout,
  type DagNode,
  type DagTask,
} from '../../lib/dagLayout';
import { StatusIcon } from '../tasks/StatusIcon';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/ui/chrome';

// Fixed node footprint: a board card's 12px padding around a 16px id row and two 18px
// title lines. Fixed because the layout needs every node's box before anything renders,
// and the card fills the box (`h-full`) so edges always meet its actual edge.
const CARD_WIDTH = 200;
const CARD_HEIGHT = 80;

interface GraphNodeCardProps {
  node: DagNode;
  /** Short sans header label (defaults to the status label). */
  refLabel: string;
  /** Right side of the header — a priority glyph, a badge, anything small. */
  accessory?: ReactNode;
  onOpen?: () => void;
}

/** One graph node as a board card (quaternary surface, half-pixel ring): status glyph +
 * short sans ref on the first row, then the title in 13px/500 wrapping to two lines.
 * Everything longer (description, criteria) lives behind the click-through, not on the
 * node — at graph scale the card's job is identity and scannability, not prose. */
function GraphNodeCard({
  node,
  refLabel,
  accessory,
  onOpen,
}: GraphNodeCardProps) {
  const content = (
    <>
      <div className="flex min-w-0 items-center gap-1.5 leading-4">
        <StatusIcon status={node.status} className="size-3.5 shrink-0" />
        <span
          data-slot="graph-node-ref"
          className="text-muted-foreground font-book min-w-0 truncate text-[12px] tracking-(--id-tracking)"
        >
          {refLabel}
        </span>
        {accessory !== undefined && (
          <span className="ml-auto flex shrink-0 items-center">
            {accessory}
          </span>
        )}
      </div>
      <p className="text-foreground line-clamp-2 text-left text-[13px] leading-[18px] font-medium">
        {node.title}
      </p>
    </>
  );

  const className = cn(
    'bg-surface-quaternary rounded-card shadow-card flex h-full w-full flex-col gap-1 overflow-hidden p-3 text-left',
    onOpen !== undefined &&
      'hover:bg-surface-hover transition-colors duration-100'
  );

  if (onOpen !== undefined) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={node.title}
        className={className}
      >
        {content}
      </button>
    );
  }
  return (
    <div title={node.title} className={className}>
      {content}
    </div>
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
  horizontal,
  label,
  hint,
  tone,
}: {
  edge: DagEdge;
  nodesById: Map<string, DagNode>;
  horizontal: boolean;
  label?: string;
  hint?: string;
  tone: EdgeTone;
}) {
  const from = nodesById.get(edge.from);
  const to = nodesById.get(edge.to);
  if (from === undefined || to === undefined) return null;

  // Left to right runs side to side, except into a wrapped band, which drops below.
  const sideways = horizontal && to.x > from.x;
  const fromX = sideways ? from.x + from.width : from.x + from.width / 2;
  const fromY = sideways ? from.y + from.height / 2 : from.y + from.height;
  const toX = sideways ? to.x : to.x + to.width / 2;
  const toY = sideways ? to.y + to.height / 2 : to.y;
  const midX = (fromX + toX) / 2;
  const midY = (fromY + toY) / 2;
  const d = sideways
    ? `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`
    : `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`;

  const attention = tone === 'attention';
  // A pill wide enough for the label at 11px tabular figures.
  const pillWidth = label === undefined ? 0 : label.length * 7 + 12;
  return (
    <g data-slot="graph-edge">
      <path
        d={d}
        className={cn(
          'fill-none',
          attention
            ? 'stroke-(--state-waiting-fg)'
            : 'stroke-[var(--border-strong)]'
        )}
        strokeWidth={1.5}
        markerEnd={
          attention
            ? 'url(#dep-graph-arrow-attention)'
            : 'url(#dep-graph-arrow)'
        }
      />
      {label !== undefined && (
        <g className="pointer-events-auto">
          {hint !== undefined && <title>{hint}</title>}
          <rect
            data-slot="graph-edge-label"
            x={midX - pillWidth / 2}
            y={midY - 9}
            width={pillWidth}
            height={18}
            rx={9}
            strokeWidth={1}
            className={cn(
              'fill-(--background)',
              attention
                ? 'stroke-(--state-waiting-fg)'
                : 'stroke-[var(--border-strong)]'
            )}
          />
          <text
            x={midX}
            y={midY + 4}
            textAnchor="middle"
            className={cn(
              'text-[11px] font-semibold tabular-nums',
              attention
                ? 'fill-(--state-waiting-fg)'
                : 'fill-(--text-secondary)'
            )}
          >
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

/** An edge's colour: amber when what it leads from needs you. */
type EdgeTone = 'default' | 'attention';

export interface DependencyGraphProps {
  /** The node set — dagLayout derives layering/edges from `blockedBy` links among just this
   * set (see dagLayout.ts's "real edges only" rule); a blockedBy id pointing outside it is
   * treated the same as a dangling one. */
  tasks: DagTask[];
  /** Short header ref per node id (e.g. "#2" for plan drafts, a task id for epics).
   * Defaults to the status label. */
  refFor?: (id: string) => string | undefined;
  /** Small right-side header glyph per node id (e.g. a priority icon). */
  accessoryFor?: (id: string) => ReactNode;
  /** Opens the clicked node. Omitted renders every node as a plain, non-interactive card. */
  onOpenNode?: (id: string) => void;
  ariaLabel?: string;
  className?: string;
  /** Top to bottom by default; left to right wraps after `wrap` columns. */
  direction?: DagDirection;
  wrap?: number;
  /** A label on an edge, such as how many waits it stands for. */
  edgeLabel?: (edge: DagEdge) => string | undefined;
  /** An edge's tooltip, saying in words what its label counts. */
  edgeHint?: (edge: DagEdge) => string | undefined;
  edgeTone?: (edge: DagEdge) => EdgeTone;
  /** Draws a node's body in place of the task card; `nodeSize` sizes it. */
  renderNode?: (node: DagNode) => ReactNode;
  nodeSize?: { width: number; height: number };
  /** Shown when there are no nodes. */
  empty?: { heading: string; description: string };
}

/**
 * True-branching dependency graph — the app's shared "mermaid-style" graph surface. Nodes
 * are compact board cards (see `GraphNodeCard`), absolutely
 * positioned by the hand-rolled `dagLayout` over an SVG layer that draws the curved edges —
 * no charting dependency, and the nodes stay real DOM (selectable text, focusable buttons)
 * instead of SVG text. Sized exactly to its content and left to the caller's container to
 * scroll — no pan/zoom (the task counts these graphs see never approach needing it).
 */
export function DependencyGraph({
  tasks,
  refFor,
  accessoryFor,
  onOpenNode,
  ariaLabel = 'Dependency graph',
  className,
  direction = 'TB',
  wrap,
  edgeLabel,
  edgeHint,
  edgeTone,
  renderNode,
  nodeSize,
  empty,
}: DependencyGraphProps) {
  const width = nodeSize?.width ?? CARD_WIDTH;
  const height = nodeSize?.height ?? CARD_HEIGHT;
  const layout = useMemo(
    () =>
      dagLayout(tasks, {
        nodeWidth: width,
        nodeHeight: height,
        direction,
        wrap: wrap ?? null,
      }),
    [tasks, width, height, direction, wrap]
  );

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={Waypoints}
        heading={empty?.heading ?? 'No tasks yet'}
        description={
          empty?.description ??
          'Tasks under this epic show up here with their blocking edges.'
        }
        className={className}
      />
    );
  }

  const nodesById = new Map(layout.nodes.map((n) => [n.id, n]));

  return (
    <div className={cn('overflow-x-auto', className)}>
      <div
        role="group"
        aria-label={ariaLabel}
        className="relative"
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden
          className="pointer-events-none absolute inset-0"
        >
          <defs>
            <marker
              id="dep-graph-arrow"
              viewBox="0 0 8 8"
              refX={4}
              refY={4}
              markerWidth={6}
              markerHeight={6}
              orient="auto-start-reverse"
            >
              <path
                d="M 0 0 L 8 4 L 0 8 z"
                className="fill-[var(--border-strong)]"
              />
            </marker>
            <marker
              id="dep-graph-arrow-attention"
              viewBox="0 0 8 8"
              refX={4}
              refY={4}
              markerWidth={6}
              markerHeight={6}
              orient="auto-start-reverse"
            >
              <path
                d="M 0 0 L 8 4 L 0 8 z"
                className="fill-(--state-waiting-fg)"
              />
            </marker>
          </defs>
          {layout.edges.map((edge) => (
            <EdgePath
              key={`${edge.from}->${edge.to}`}
              edge={edge}
              nodesById={nodesById}
              horizontal={direction === 'LR'}
              label={edgeLabel?.(edge)}
              hint={edgeHint?.(edge)}
              tone={edgeTone?.(edge) ?? 'default'}
            />
          ))}
        </svg>
        {layout.nodes.map((node) => (
          <div
            key={node.id}
            className="absolute"
            style={{
              left: node.x,
              top: node.y,
              width: node.width,
              height: node.height,
            }}
          >
            {renderNode !== undefined ? (
              renderNode(node)
            ) : (
              <GraphNodeCard
                node={node}
                refLabel={refFor?.(node.id) ?? statusLabel(node.status)}
                accessory={accessoryFor?.(node.id)}
                onOpen={
                  onOpenNode === undefined
                    ? undefined
                    : () => onOpenNode(node.id)
                }
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
