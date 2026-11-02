import { cx, type UiTone } from '@dispatch/ui';
import { Check } from 'lucide-react';
import { memo, type ReactNode, useMemo } from 'react';

import { StatusIcon } from '../tasks/StatusIcon';
import styles from './FlightCanvas.module.css';
import {
  type CullWindow,
  edgeBounds,
  edgeInWindow,
  nodeInWindow,
} from './flightCull';
import { BAND_HEADER_HEIGHT, type FlightLayout } from './flightLayout';
import { FlightNodeCard, type FlightNodeView } from './FlightNodeCard';

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

/**
 * The status tone an edge strokes in, through its `data-tone` (`--tone`): a teammate or an
 * agent on the blocker is in progress (info), a blocker in review is green (success). Idle
 * and landed carry no tone: idle is a faint dashed line, and landed is done, a neutral
 * stroke, never green beside a red.
 */
const EDGE_TONE: Record<EdgeTone, UiTone | null> = {
  idle: null,
  active: 'info',
  flowing: 'info',
  satisfied: 'success',
  landed: null,
};

// One edge. Memoized on its path and tone, so a blocker landing repaints only its own
// out-edges. Stroke, width, dashes and the flowing edge's drift come from the module,
// keyed by `data-edge`.
const FlightEdgeLine = memo(function FlightEdgeLine({
  d,
  tone,
}: {
  d: string;
  tone: EdgeTone;
}) {
  return (
    <path
      d={d}
      data-slot="flight-edge"
      data-edge={tone}
      data-tone={EDGE_TONE[tone] ?? undefined}
      className={styles.edge}
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
      className={styles.waveHead}
      style={{ left: wave.x, width: wave.width }}
    >
      <span className={styles.waveName}>Wave {wave.wave + 1}</span>
      <span className={cx(styles.waveTally, 'num')}>
        {wave.done}/{wave.total}
      </span>
      {finished && (
        <Check
          aria-hidden
          size={14}
          strokeWidth={1.8}
          className={styles.waveDone}
        />
      )}
      {wave.current && (
        <span className={cx(styles.waveNow, 'toneText')} data-tone="info">
          <span aria-hidden className={styles.waveNowDot} />
          Now
        </span>
      )}
      <span aria-hidden className={styles.waveTrack}>
        <span className={styles.waveLanded} style={{ width: `${donePct}%` }} />
        <span
          className={styles.waveRunning}
          data-tone="info"
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
      className={styles.bandHead}
      style={{ top: band.top, width, height: BAND_HEADER_HEIGHT }}
    >
      <div className={styles.bandLabel}>
        <StatusIcon status={band.status} className={styles.bandGlyph} />
        <span className={styles.bandTitle}>{band.title}</span>
        {band.refLabel !== null && (
          <span className={styles.bandRef}>{band.refLabel}</span>
        )}
        <span className={cx(styles.bandCount, 'num')}>
          {band.done}/{band.total}
        </span>
        <span className={styles.bandControls}>{band.controls}</span>
      </div>
    </div>
  );
});

// Every edge in one SVG, the critical path's highlighter first so it sits beneath. Its own
// memoized layer, so moving the cursor never walks the edges, and its own compositing layer
// (`will-change` in the module), so cards mounting over it never repaint its strokes.
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
    <svg aria-hidden width={width} height={height} className={styles.edges}>
      {edges.map((edge) =>
        edge.critical ? (
          <path
            key={`crit:${edge.key}`}
            d={edge.d}
            data-slot="flight-critical"
            className={styles.critical}
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
    <div className={styles.root} style={{ width: Math.max(layout.width, 1) }}>
      <div
        data-slot="flight-wave-heads"
        className={styles.waveHeads}
        style={{ height: WAVE_HEADER_HEIGHT, width: layout.width }}
      >
        {waves.map((wave) => (
          <WaveHead key={wave.wave} wave={wave} />
        ))}
      </div>
      <div
        data-slot="flight-canvas"
        className={styles.canvas}
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
