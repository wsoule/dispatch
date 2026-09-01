import { statusLabel } from '@dispatch/core/browser';
import { Waypoints } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import {
  type DagEdge,
  dagLayout,
  type DagNode,
  type DagTask,
} from '../../lib/dagLayout';
import { StatusIcon } from '../tasks/StatusIcon';
import { cn } from '@/lib/utils';

// Fixed node footprint. Wide enough for two lines of a sans title at 12.5px (~28 chars per
// line); fixed because the layout needs every node's box before anything renders, and the
// card fills the box (`h-full`) so edges always meet its actual edge.
const CARD_WIDTH = 200;
const CARD_HEIGHT = 76;

interface GraphNodeCardProps {
  node: DagNode;
  /** Short mono header label (defaults to the status label). */
  refLabel: string;
  /** Right side of the header — a priority glyph, a badge, anything small. */
  accessory?: ReactNode;
  onOpen?: () => void;
}

/** One graph node in the ContextCard visual language (inset surface, hairline, bordered
 * mono header) with graph-appropriate detail: status glyph + short mono ref in the header,
 * and the title in readable sans that wraps to two lines instead of truncating in mono.
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
      <div className="border-border flex min-w-0 items-center gap-1.5 border-b px-2.5 py-1.5">
        <StatusIcon status={node.status} className="size-3.5 shrink-0" />
        <span className="text-muted-foreground min-w-0 truncate font-mono text-[11px]">
          {refLabel}
        </span>
        {accessory !== undefined && (
          <span className="ml-auto flex shrink-0 items-center">
            {accessory}
          </span>
        )}
      </div>
      <p className="text-foreground line-clamp-2 px-2.5 py-1.5 text-left text-[12.5px] leading-snug font-medium">
        {node.title}
      </p>
    </>
  );

  const className = cn(
    'bg-surface-inset rounded-card shadow-hairline h-full w-full overflow-hidden text-left',
    onOpen !== undefined &&
      'hover:ring-primary/40 ease-out-expo transition-shadow duration-100 hover:ring-1'
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
      markerEnd="url(#dep-graph-arrow)"
    />
  );
}

export interface DependencyGraphProps {
  /** The node set — dagLayout derives layering/edges from `blockedBy` links among just this
   * set (see dagLayout.ts's "real edges only" rule); a blockedBy id pointing outside it is
   * treated the same as a dangling one. */
  tasks: DagTask[];
  /** Short mono header ref per node id (e.g. "#2" for plan drafts, a task id for epics).
   * Defaults to the status label. */
  refFor?: (id: string) => string | undefined;
  /** Small right-side header glyph per node id (e.g. a priority icon). */
  accessoryFor?: (id: string) => ReactNode;
  /** Opens the clicked node. Omitted renders every node as a plain, non-interactive card. */
  onOpenNode?: (id: string) => void;
  ariaLabel?: string;
  className?: string;
}

/**
 * True-branching dependency graph — the app's shared "mermaid-style" graph surface. Nodes
 * are compact cards in the ContextCard visual language (see `GraphNodeCard`), absolutely
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
}: DependencyGraphProps) {
  const layout = useMemo(
    () => dagLayout(tasks, { nodeWidth: CARD_WIDTH, nodeHeight: CARD_HEIGHT }),
    [tasks]
  );

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
              <path d="M 0 0 L 8 4 L 0 8 z" className="fill-border" />
            </marker>
          </defs>
          {layout.edges.map((edge) => (
            <EdgePath
              key={`${edge.from}->${edge.to}`}
              edge={edge}
              nodesById={nodesById}
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
            <GraphNodeCard
              node={node}
              refLabel={refFor?.(node.id) ?? statusLabel(node.status)}
              accessory={accessoryFor?.(node.id)}
              onOpen={
                onOpenNode === undefined ? undefined : () => onOpenNode(node.id)
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
