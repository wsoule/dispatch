import { statusLabel } from '@dispatch/core/browser';
import { Waypoints } from 'lucide-react';
import type { ComponentType } from 'react';
import { useMemo } from 'react';

import {
  type DagEdge,
  dagLayout,
  type DagNode,
  type DagTask,
} from '../../lib/dagLayout';
import { StatusIcon } from '../tasks/StatusIcon';
import { cn } from '@/lib/utils';
import { ContextCard } from '@/ui/ai/context-cards';

// The ContextCard footprint: w-56 wide, and two fixed heights — header+snippet+footer for
// graphs that supply body text (`snippetFor`), header+footer for those that don't. Fixed
// because the layout needs every node's box before anything renders; the card fills the box
// (`h-full`) so edges always meet its actual edge.
const CARD_WIDTH = 224;
const CARD_HEIGHT_WITH_SNIPPET = 132;
const CARD_HEIGHT_COMPACT = 66;

// One icon component per status string, cached so ContextCard sees a stable component
// identity across renders (an inline closure would remount the header icon every render).
// The wrapper ignores ContextCard's muted icon classes on purpose: StatusIcon carries its
// own status color, which is the whole point of showing it.
const STATUS_ICON_CACHE = new Map<
  string,
  ComponentType<{ className?: string }>
>();
function statusIconFor(status: string): ComponentType<{ className?: string }> {
  let cached = STATUS_ICON_CACHE.get(status);
  if (cached === undefined) {
    cached = function NodeStatusIcon() {
      return <StatusIcon status={status} className="size-3.5 shrink-0" />;
    };
    STATUS_ICON_CACHE.set(status, cached);
  }
  return cached;
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
  /** Body text per node id (a description, an excerpt) — supplying this switches every node
   * to the taller snippet card so the graph stays a uniform grid. */
  snippetFor?: (id: string) => string | undefined;
  /** Footer line per node id, in place of the status label. */
  subtitleFor?: (id: string) => string | undefined;
  /** Opens the clicked node. Omitted renders every node as a plain, non-interactive card. */
  onOpenNode?: (id: string) => void;
  ariaLabel?: string;
  className?: string;
}

/**
 * True-branching dependency graph — the app's shared "mermaid-style" graph surface. Nodes
 * are the ai components' ContextCards (status icon + mono title header, clamped snippet,
 * mono footer), absolutely positioned by the hand-rolled `dagLayout` over an SVG layer that
 * draws the curved edges — no charting dependency, and the nodes stay real DOM (selectable
 * text, focusable buttons) instead of SVG text. Sized exactly to its content and left to
 * the caller's container to scroll — no pan/zoom (the task counts these graphs see never
 * approach needing it).
 */
export function DependencyGraph({
  tasks,
  snippetFor,
  subtitleFor,
  onOpenNode,
  ariaLabel = 'Dependency graph',
  className,
}: DependencyGraphProps) {
  const nodeHeight =
    snippetFor === undefined ? CARD_HEIGHT_COMPACT : CARD_HEIGHT_WITH_SNIPPET;
  const layout = useMemo(
    () => dagLayout(tasks, { nodeWidth: CARD_WIDTH, nodeHeight }),
    [tasks, nodeHeight]
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
            <ContextCard
              source={node.title}
              icon={statusIconFor(node.status)}
              snippet={snippetFor?.(node.id) ?? undefined}
              footer={
                <span className="text-muted-foreground font-mono text-[11px]">
                  {subtitleFor?.(node.id) ?? statusLabel(node.status)}
                </span>
              }
              onOpen={
                onOpenNode === undefined ? undefined : () => onOpenNode(node.id)
              }
              className={cn(
                'h-full w-full',
                onOpenNode !== undefined &&
                  'hover:ring-primary/40 ease-out-expo transition-shadow duration-100 hover:ring-1'
              )}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
