import { Check } from 'lucide-react';
import { memo, type ReactNode, useMemo } from 'react';

import { StatusIcon } from '../tasks/StatusIcon';
import {
  type CullWindow,
  edgeBounds,
  edgeInWindow,
  nodeInWindow,
} from './flightCull';
import { BAND_HEADER_HEIGHT, type FlightLayout } from './flightLayout';
import { FlightNodeCard, type FlightNodeView } from './FlightNodeCard';
import { cn } from '@/lib/utils';

/**
 * How an edge reads, from its blocker's state: `landed` and `satisfied` (in review) are
 * lit — the dependent may go; `flowing` is an agent still on the blocker; `active` a
 * teammate on it; `idle` nothing moving yet.
 */
export type EdgeTone = 'idle' | 'active' | 'flowing' | 'satisfied' | 'landed';

export interface FlightEdgeView {
  key: string;
  d: string;
  tone: EdgeTone;
  critical: boolean;
}

export interface FlightWaveView {
  wave: number;
  x: number;
  width: number;
  total: number;
  done: number;
  running: number;
  current: boolean;
}

export interface FlightBandView {
  key: string;
  top: number;
  title: string;
  refLabel: string | null;
  /** The band's rolled-up status, for its glyph. */
  status: string;
  done: number;
  total: number;
  /** The band container's own fan-out controls. */
  controls: ReactNode;
}

/** The sticky wave-header row's height — where the canvas starts in its scroller. */
export const WAVE_HEADER_HEIGHT = 32;

const EDGE_STYLE: Record<
  EdgeTone,
  { stroke: string; width: number; dash?: string; opacity: number }
> = {
  idle: { stroke: 'var(--text-ghost)', width: 1, dash: '3 4', opacity: 0.6 },
  active: { stroke: 'var(--status-progress)', width: 1, opacity: 0.45 },
  flowing: {
    stroke: 'var(--state-working-fg)',
    width: 1.25,
    dash: '4 4',
    opacity: 0.9,
  },
  satisfied: { stroke: 'var(--state-review-fg)', width: 1.25, opacity: 0.7 },
  landed: { stroke: 'var(--status-done)', width: 1.25, opacity: 0.55 },
};

// One edge. Memoized on its path and tone, so a blocker landing repaints only its own
// out-edges; the stroke eases to the new colour. A flowing edge's dashes step rather than
// glide: five repaints a second instead of sixty, for the same sense of motion.
const FlightEdgeLine = memo(function FlightEdgeLine({
  d,
  tone,
}: {
  d: string;
  tone: EdgeTone;
}) {
  const style = EDGE_STYLE[tone];
  return (
    <path
      d={d}
      data-slot="flight-edge"
      data-tone={tone}
      fill="none"
      stroke={style.stroke}
      strokeWidth={style.width}
      strokeDasharray={style.dash}
      strokeOpacity={style.opacity}
      className={cn(
        'transition-[stroke,stroke-opacity] duration-500',
        tone === 'flowing' &&
          'motion-safe:animate-[flight-flow_1.6s_steps(8)_infinite]'
      )}
    />
  );
});

// One wave's column head: name, tally, and a hairline that fills landed then running.
const WaveHead = memo(function WaveHead({ wave }: { wave: FlightWaveView }) {
  const donePct = wave.total === 0 ? 0 : (wave.done / wave.total) * 100;
  const runPct = wave.total === 0 ? 0 : (wave.running / wave.total) * 100;
  const finished = wave.total > 0 && wave.done === wave.total;
  return (
    <div
      data-slot="flight-wave-head"
      data-current={wave.current || undefined}
      className="absolute top-0 flex h-full items-center gap-1.5 text-[12px]"
      style={{ left: wave.x, width: wave.width }}
    >
      <span
        className={cn(
          'font-medium',
          wave.current ? 'text-foreground' : 'text-text-secondary'
        )}
      >
        Wave {wave.wave + 1}
      </span>
      <span className="font-book text-(--text-muted) tabular-nums">
        {wave.done}/{wave.total}
      </span>
      {finished && (
        <Check
          aria-hidden
          className="text-status-done size-3"
          strokeWidth={2.25}
        />
      )}
      {wave.current && (
        <span className="text-state-working flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          Now
        </span>
      )}
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-px overflow-hidden bg-(--border-default)"
      >
        <span
          className="bg-status-done absolute inset-y-0 left-0 transition-[width] duration-500"
          style={{ width: `${donePct}%` }}
        />
        <span
          className="bg-state-working absolute inset-y-0 transition-[left,width] duration-500"
          style={{ left: `${donePct}%`, width: `${runPct}%` }}
        />
      </span>
    </div>
  );
});

// A band's title row. The label sticks to the left edge while the plan scrolls sideways.
const BandHead = memo(function BandHead({
  band,
  width,
}: {
  band: FlightBandView;
  width: number;
}) {
  return (
    <div
      data-slot="flight-band-head"
      data-band={band.key}
      className="absolute left-0 flex items-end"
      style={{ top: band.top, width, height: BAND_HEADER_HEIGHT }}
    >
      <div className="sticky left-0 flex h-8 max-w-full items-center gap-2 pr-3 pl-5">
        <StatusIcon status={band.status} className="size-3.5 shrink-0" />
        <span className="text-foreground truncate text-[13px] font-medium">
          {band.title}
        </span>
        {band.refLabel !== null && (
          <span className="font-book shrink-0 text-[12px] tracking-(--id-tracking) text-(--text-muted)">
            {band.refLabel}
          </span>
        )}
        <span className="font-book shrink-0 text-[12px] text-(--text-muted) tabular-nums">
          {band.done}/{band.total}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {band.controls}
        </span>
      </div>
    </div>
  );
});

// Every edge in one SVG, the critical path's highlighter first so it sits beneath. Its own
// memoized layer, so moving the cursor never walks the edges, and its own compositing layer,
// so cards mounting over it never repaint its strokes.
const EdgeLayer = memo(function EdgeLayer({
  edges,
  width,
  height,
}: {
  edges: readonly FlightEdgeView[];
  width: number;
  height: number;
}) {
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      className="pointer-events-none absolute inset-0 overflow-visible will-change-transform"
    >
      {edges.map((edge) =>
        edge.critical ? (
          <path
            key={`crit:${edge.key}`}
            d={edge.d}
            data-slot="flight-critical"
            fill="none"
            stroke="var(--accent)"
            strokeOpacity={0.26}
            strokeWidth={4}
            strokeLinecap="round"
          />
        ) : null
      )}
      {edges.map((edge) => (
        <FlightEdgeLine key={edge.key} d={edge.d} tone={edge.tone} />
      ))}
    </svg>
  );
});

interface FlightCanvasProps {
  layout: FlightLayout;
  nodes: readonly FlightNodeView[];
  edges: readonly FlightEdgeView[];
  waves: readonly FlightWaveView[];
  bands: readonly FlightBandView[] | null;
  focusedId: string | null;
  onActivate: (id: string) => void;
  /** The part of the canvas near the viewport; null draws every node and edge. */
  cull?: CullWindow | null;
}

/**
 * The plan itself: a sticky row of wave heads over an absolutely positioned canvas —
 * band title rows, one SVG of edges (the critical path drawn first as a soft accent
 * highlighter under its edges), then the node cards. Positions come from the layout
 * alone, so a state change touches colours and text, never geometry. With a `cull`
 * window only the cards and edges reaching into it are drawn (the focused card always).
 */
export function FlightCanvas({
  layout,
  nodes,
  edges,
  waves,
  bands,
  focusedId,
  onActivate,
  cull = null,
}: FlightCanvasProps) {
  const bounds = useMemo(() => edgeBounds(layout), [layout]);
  const shownNodes = useMemo(
    () =>
      cull === null
        ? nodes
        : nodes.filter(
            (node) =>
              node.id === focusedId || nodeInWindow(node.x, node.y, cull)
          ),
    [nodes, cull, focusedId]
  );
  const shownEdges = useMemo(
    () =>
      cull === null
        ? edges
        : edges.filter((edge) => edgeInWindow(bounds.get(edge.key), cull)),
    [edges, cull, bounds]
  );
  return (
    <div className="relative" style={{ width: Math.max(layout.width, 1) }}>
      <div
        data-slot="flight-wave-heads"
        className="sticky top-0 z-10 bg-(--surface-page)"
        style={{ height: WAVE_HEADER_HEIGHT, width: layout.width }}
      >
        {waves.map((wave) => (
          <WaveHead key={wave.wave} wave={wave} />
        ))}
      </div>
      <div
        data-slot="flight-canvas"
        className="relative"
        style={{ width: layout.width, height: layout.height }}
      >
        {bands?.map((band) => (
          <BandHead key={band.key} band={band} width={layout.width} />
        ))}
        <EdgeLayer
          edges={shownEdges}
          width={layout.width}
          height={layout.height}
        />
        {shownNodes.map((node) => (
          <FlightNodeCard
            key={node.id}
            {...node}
            focused={focusedId === node.id}
            onActivate={onActivate}
          />
        ))}
      </div>
    </div>
  );
}
