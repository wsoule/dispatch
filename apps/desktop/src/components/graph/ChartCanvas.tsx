import { Button, Kbd, Tooltip } from '@dispatch/ui';
import { Maximize, Minus, Plus } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
} from 'react';

import {
  type ChartLayout,
  type PlacedBox,
  type Point,
  roundedPath,
} from '../../lib/chartLayout';
import styles from './ChartCanvas.module.css';
import type { ChartViewportApi } from './useChartViewport';

/** How a node reads while something is selected: the selection itself, what it waits on,
 * what it unblocks, a member of a highlighted set, or faded into the background. */
export type NodeTrace = 'sel' | 'up' | 'down' | 'set' | 'dim';

/** An edge's colour: at rest, at rest but leading from work that needs attention (only its
 * count pill turns amber, so a resting line never reads as a trace), traced up or down from
 * the selection, inside a highlighted set, or faded. */
export type EdgeTone = 'idle' | 'attention' | 'up' | 'down' | 'set' | 'dim';

export interface CanvasEdge {
  id: string;
  points: readonly Point[];
  labelAt: Point;
  tone: EdgeTone;
  /** Dashed: the wait is already satisfied (its blocker landed). */
  dashed?: boolean;
  /** Overrides the tone's stroke width (the milestone overview weights by count). */
  width?: number;
  /** A count pill on the edge's longest run. */
  label?: string;
  /** Says in words what the pill counts; also the pill's accessible name. */
  hint?: string;
  /** Makes the edge (and its pill) clickable. */
  onSelect?: () => void;
}

// One arrowhead marker per line colour (a marker cannot take its path's colour in WebKit);
// a faded edge keeps its idle marker and fades with it.
type MarkerKey = 'idle' | 'up' | 'down' | 'set';
const MARKER_OF: Record<EdgeTone, MarkerKey> = {
  idle: 'idle',
  attention: 'idle',
  up: 'up',
  down: 'down',
  set: 'set',
  dim: 'idle',
};
const MARKER_KEYS: readonly MarkerKey[] = ['idle', 'up', 'down', 'set'];

/** A short line in a trace colour: the legend's and the inspector's key for waits/unblocks. */
export function TraceSwatch({ dir }: { dir: 'up' | 'down' }) {
  return <span aria-hidden className={styles.traceSwatch} data-dir={dir} />;
}

/** A count pill for the legend: what the numbers on milestone lines look like. */
export function PillSwatch({ attention = false }: { attention?: boolean }) {
  return (
    <span
      aria-hidden
      className={styles.pillSwatch}
      data-attention={attention ? '' : undefined}
    >
      2
    </span>
  );
}

/** One edge: the routed line, a wide invisible hit path when clickable, and an optional
 * count pill. `data-slot="graph-edge"` and the pill's `<text>` are what tests read. */
function ChartEdge({
  edge,
  markerId,
}: {
  edge: CanvasEdge;
  markerId: (key: MarkerKey) => string;
}) {
  const d = roundedPath(edge.points);
  const select = edge.onSelect;
  const pillWidth = edge.label === undefined ? 0 : edge.label.length * 7 + 12;
  return (
    <g
      data-slot="graph-edge"
      data-tone={edge.tone}
      data-chart-edge=""
      className={styles.edge}
      // The milestone overview weights each line by its count of waits.
      style={
        edge.width === undefined
          ? undefined
          : ({ '--edge-width': edge.width } as CSSProperties)
      }
    >
      <path
        d={d}
        className={styles.edgeLine}
        strokeDasharray={edge.dashed === true ? '4 3' : undefined}
        markerEnd={`url(#${markerId(MARKER_OF[edge.tone])})`}
      />
      {select !== undefined && (
        <path
          d={d}
          className={styles.edgeHit}
          onClick={(event) => {
            event.stopPropagation();
            select();
          }}
        />
      )}
      {edge.label !== undefined && (
        // An SVG pill rather than a library button: it has to sit on the routed line inside
        // the chart's own coordinate space, so it is a focusable `<g role="button">`.
        <g
          role={select === undefined ? undefined : 'button'}
          tabIndex={select === undefined ? undefined : 0}
          aria-label={edge.hint}
          className={styles.edgePill}
          data-clickable={select === undefined ? undefined : ''}
          onClick={(event) => {
            if (select === undefined) return;
            event.stopPropagation();
            select();
          }}
          onKeyDown={(event) => {
            if (select === undefined) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              select();
            }
          }}
        >
          {edge.hint !== undefined && <title>{edge.hint}</title>}
          <rect
            data-slot="graph-edge-label"
            x={edge.labelAt.x - pillWidth / 2}
            y={edge.labelAt.y - 9}
            width={pillWidth}
            height={18}
            rx={9}
          />
          <text x={edge.labelAt.x} y={edge.labelAt.y + 4} textAnchor="middle">
            {edge.label}
          </text>
        </g>
      )}
    </g>
  );
}

interface ChartCanvasProps {
  viewport: ChartViewportApi;
  layout: ChartLayout | null;
  /** Shown over the stage while laying out, or when the layout failed. */
  message: string | null;
  edges: readonly CanvasEdge[];
  /** A node's body; it fills the placed box. */
  renderNode: (box: PlacedBox) => ReactNode;
  nodeTrace: (id: string) => NodeTrace | null;
  /** A plain click on the canvas itself (not a node, an edge or a control). */
  onBackgroundClick: () => void;
  /** The chart's keys; Escape is the keyboard way to do what a background click does. */
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFit: () => void;
  legend: ReactNode;
  ariaLabel: string;
  /** How the legend says to zoom: a chart embedded in a scrolling page zooms on a pinch. */
  zoomHint?: string;
}

/**
 * The stage every dependency chart draws on, panned and zoomed by hand: a dotted canvas,
 * one layer holding the routed SVG edges under absolutely placed DOM nodes (real buttons,
 * so focus and keyboard work), group boxes, zoom controls and a legend. The layer is moved
 * by `useChartViewport` with a CSS transform, so panning never re-renders the chart.
 */
export function ChartCanvas({
  viewport,
  layout,
  message,
  edges,
  renderNode,
  nodeTrace,
  onBackgroundClick,
  onKeyDown,
  onFit,
  legend,
  ariaLabel,
  zoomHint = 'scroll to zoom',
}: ChartCanvasProps) {
  const uid = useId().replace(/:/g, '');
  const markerId = (key: MarkerKey) => `chart-arrow-${key}-${uid}`;
  const width = layout?.width ?? 0;
  const height = layout?.height ?? 0;
  // Whether the press that ends in a click began on the bare canvas. A popover that closes
  // on pointerup (the search's pick) lets the click land on whatever was under it; that
  // click must not read as "clicked the background" and drop the selection it just made.
  const pressedBare = useRef(false);
  const isBare = (target: EventTarget) =>
    (target as Element).closest(
      '[data-chart-node],[data-chart-edge],[data-chart-ignore]'
    ) === null;
  return (
    <div
      ref={viewport.stageRef}
      data-testid="chart-stage"
      // Focusable so the chart's keys (/, Esc, 0, +, −) work after a click on the canvas;
      // the nodes inside carry the visible focus rings.
      tabIndex={0}
      className={styles.stage}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        pressedBare.current = isBare(event.target);
      }}
      onClick={(event) => {
        const bare = pressedBare.current;
        pressedBare.current = false;
        if (!bare || viewport.wasDrag() || !isBare(event.target)) return;
        onBackgroundClick();
      }}
    >
      <div
        ref={viewport.layerRef}
        role="group"
        aria-label={ariaLabel}
        className={styles.layer}
        // The laid-out chart's size: the layer is what the viewport transforms.
        style={{ width, height }}
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`}
          className={styles.svg}
        >
          <defs>
            {MARKER_KEYS.map((key) => (
              <marker
                key={key}
                id={markerId(key)}
                viewBox="0 0 10 10"
                refX={9}
                refY={5}
                markerWidth={key === 'idle' ? 7 : 6}
                markerHeight={key === 'idle' ? 7 : 6}
                orient="auto-start-reverse"
                className={styles.marker}
                data-marker={key}
              >
                <path d="M0 0L10 5L0 10z" />
              </marker>
            ))}
          </defs>
          {layout?.groups.map((group) => (
            <g
              key={group.id}
              data-slot="graph-group"
              className={styles.group}
              data-loose={group.id === NO_MILESTONE_GROUP ? '' : undefined}
            >
              <rect
                x={group.x}
                y={group.y}
                width={group.width}
                height={group.height}
                rx={8}
              />
              <text x={group.x + 14} y={group.y + 24}>
                {group.label}
              </text>
            </g>
          ))}
          {edges.map((edge) => (
            <ChartEdge key={edge.id} edge={edge} markerId={markerId} />
          ))}
        </svg>
        {layout !== null &&
          [...layout.nodes.values()].map((box) => {
            const trace = nodeTrace(box.id);
            return (
              <div
                key={box.id}
                data-chart-node={box.id}
                data-trace={trace ?? undefined}
                className={styles.node}
                // Each node sits at its laid-out box.
                style={{
                  left: box.x,
                  top: box.y,
                  width: box.width,
                  height: box.height,
                }}
              >
                {renderNode(box)}
              </div>
            );
          })}
      </div>
      <div data-chart-ignore="" className={styles.zoom}>
        <ZoomButton
          label="Zoom in"
          keycap="+"
          icon={<Plus aria-hidden strokeWidth={1.8} />}
          onClick={() => viewport.zoomBy(1.35)}
        />
        <ZoomButton
          label="Zoom out"
          keycap="−"
          icon={<Minus aria-hidden strokeWidth={1.8} />}
          onClick={() => viewport.zoomBy(1 / 1.35)}
        />
        <ZoomButton
          label="Fit the whole chart"
          keycap="0"
          icon={<Maximize aria-hidden strokeWidth={1.8} />}
          onClick={onFit}
        />
      </div>
      <div
        data-chart-ignore=""
        data-testid="chart-legend"
        className={styles.legend}
      >
        {legend}
        <span className={styles.legendHint}>Drag to pan · {zoomHint}</span>
      </div>
      {message !== null && (
        <div data-testid="chart-message" className={styles.message}>
          {message}
        </div>
      )}
    </div>
  );
}

/** The group id the Tasks chart boxes loose tasks under; drawn dashed, as outside the plan. */
export const NO_MILESTONE_GROUP = 'group:none';

/** One legend entry: a swatch and its words. */
export function LegendItem({
  swatch,
  children,
}: {
  swatch: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className={styles.legendItem}>
      {swatch}
      {children}
    </span>
  );
}

function ZoomButton({
  label,
  keycap,
  icon,
  onClick,
}: {
  label: string;
  keycap: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <Tooltip
      side="left"
      content={
        <>
          {label} <Kbd>{keycap}</Kbd>
        </>
      }
    >
      <Button
        variant="quiet"
        size="sm"
        icon={icon}
        aria-label={label}
        onClick={onClick}
      />
    </Tooltip>
  );
}
