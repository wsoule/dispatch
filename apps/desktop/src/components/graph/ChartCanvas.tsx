import { Maximize, Minus, Plus } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';

import {
  type ChartLayout,
  type PlacedBox,
  type Point,
  roundedPath,
} from '../../lib/chartLayout';
import type { ChartViewportApi } from './useChartViewport';
import { IconButton } from '@/ui/ai/icon-button';
import { Kbd } from '@/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

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

// Strokes per tone, as CSS colours so they follow the theme. The arrowheads are one marker
// per colour; a faded edge keeps its idle marker and fades with it.
const EDGE: Record<
  EdgeTone,
  { stroke: string; width: number; opacity: number; marker: MarkerKey }
> = {
  idle: { stroke: 'var(--text-ghost)', width: 1.3, opacity: 1, marker: 'idle' },
  attention: {
    stroke: 'var(--text-ghost)',
    width: 1.3,
    opacity: 1,
    marker: 'idle',
  },
  up: {
    stroke: 'var(--state-waiting-fg)',
    width: 2.4,
    opacity: 1,
    marker: 'up',
  },
  down: { stroke: 'var(--teal)', width: 2.4, opacity: 1, marker: 'down' },
  set: { stroke: 'var(--foreground)', width: 2.2, opacity: 1, marker: 'set' },
  dim: {
    stroke: 'var(--text-ghost)',
    width: 1.3,
    opacity: 0.08,
    marker: 'idle',
  },
};

type MarkerKey = 'idle' | 'up' | 'down' | 'set';
const MARKERS: Record<MarkerKey, string> = {
  idle: 'var(--text-ghost)',
  up: 'var(--state-waiting-fg)',
  down: 'var(--teal)',
  set: 'var(--foreground)',
};

// The colour of the trace lines, for the legend and the inspector's section headings.
const TRACE_COLOR = { up: MARKERS.up, down: MARKERS.down };

/** A short line in a trace colour: the legend's and the inspector's key for waits/unblocks. */
export function TraceSwatch({ dir }: { dir: 'up' | 'down' }) {
  return (
    <span
      aria-hidden
      className="inline-block h-0 w-4 shrink-0 border-t-2"
      style={{ borderColor: TRACE_COLOR[dir] }}
    />
  );
}

// A count pill's outline and figure per tone: neutral at rest, amber for attention, and
// the line's own colour while traced.
function pillColours(tone: EdgeTone): { stroke: string; text: string } {
  if (tone === 'idle' || tone === 'dim') {
    return { stroke: 'var(--border-strong)', text: 'var(--text-secondary)' };
  }
  if (tone === 'attention') {
    return {
      stroke: 'var(--state-waiting-fg)',
      text: 'var(--state-waiting-fg)',
    };
  }
  return { stroke: EDGE[tone].stroke, text: EDGE[tone].stroke };
}

/** A count pill for the legend: what the numbers on milestone lines look like. */
export function PillSwatch({ attention = false }: { attention?: boolean }) {
  const colours = pillColours(attention ? 'attention' : 'idle');
  return (
    <span
      aria-hidden
      className="rounded-pill bg-surface-quaternary inline-flex h-3.5 min-w-5 shrink-0 items-center justify-center border px-1 text-[10px] font-semibold tabular-nums"
      style={{ borderColor: colours.stroke, color: colours.text }}
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
  const tone = EDGE[edge.tone];
  const pill = pillColours(edge.tone);
  const d = roundedPath(edge.points);
  const select = edge.onSelect;
  const pillWidth = edge.label === undefined ? 0 : edge.label.length * 7 + 12;
  return (
    <g data-slot="graph-edge" data-tone={edge.tone} data-chart-edge="">
      <path
        d={d}
        fill="none"
        stroke={tone.stroke}
        strokeWidth={edge.width ?? tone.width}
        strokeDasharray={edge.dashed === true ? '4 3' : undefined}
        opacity={tone.opacity}
        markerEnd={`url(#${markerId(tone.marker)})`}
        style={{ transition: 'opacity 150ms, stroke 150ms' }}
      />
      {select !== undefined && (
        <path
          d={d}
          fill="none"
          stroke="transparent"
          strokeWidth={14}
          className="cursor-pointer"
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
          opacity={edge.tone === 'dim' ? 0.15 : 1}
          className={select === undefined ? undefined : 'cursor-pointer'}
          style={{ transition: 'opacity 150ms' }}
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
            fill="var(--surface-quaternary)"
            stroke={pill.stroke}
            strokeWidth={1}
          />
          <text
            x={edge.labelAt.x}
            y={edge.labelAt.y + 4}
            textAnchor="middle"
            fill={pill.text}
            className="text-[11px] font-semibold tabular-nums"
          >
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
      className="bg-background relative min-h-0 min-w-0 flex-1 cursor-grab touch-none overflow-hidden bg-[radial-gradient(var(--border-default)_1.2px,transparent_1.2px)] bg-size-[22px_22px] outline-none select-none"
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
        className="absolute top-0 left-0"
        style={{ width, height }}
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`}
          className="absolute inset-0 overflow-visible"
        >
          <defs>
            {(Object.keys(MARKERS) as MarkerKey[]).map((key) => (
              <marker
                key={key}
                id={markerId(key)}
                viewBox="0 0 10 10"
                refX={9}
                refY={5}
                markerWidth={key === 'idle' ? 7 : 6}
                markerHeight={key === 'idle' ? 7 : 6}
                orient="auto-start-reverse"
              >
                <path d="M0 0L10 5L0 10z" fill={MARKERS[key]} />
              </marker>
            ))}
          </defs>
          {layout?.groups.map((group) => (
            <g key={group.id} data-slot="graph-group">
              <rect
                x={group.x}
                y={group.y}
                width={group.width}
                height={group.height}
                rx={8}
                fill="var(--surface-secondary)"
                fillOpacity={0.7}
                stroke="var(--border-strong)"
                strokeWidth={1}
                strokeDasharray={
                  group.id === NO_MILESTONE_GROUP ? '5 4' : undefined
                }
              />
              <text
                x={group.x + 14}
                y={group.y + 24}
                fill="var(--text-secondary)"
                className="text-[12px] font-semibold"
              >
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
              // A faded node comes back to full strength while it holds focus, so its
              // focus ring is never drawn at a fifth of its strength.
              <div
                key={box.id}
                data-chart-node={box.id}
                data-trace={trace ?? undefined}
                className="absolute transition-opacity duration-150 data-[trace=dim]:opacity-[0.18] data-[trace=dim]:focus-within:opacity-100"
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
      <div
        data-chart-ignore=""
        className="bg-surface-quaternary shadow-raised rounded-control absolute top-3 right-3 flex flex-col gap-0.5 p-0.5"
      >
        <ZoomButton
          label="Zoom in"
          keycap="+"
          onClick={() => viewport.zoomBy(1.35)}
        >
          <Plus aria-hidden />
        </ZoomButton>
        <ZoomButton
          label="Zoom out"
          keycap="−"
          onClick={() => viewport.zoomBy(1 / 1.35)}
        >
          <Minus aria-hidden />
        </ZoomButton>
        <ZoomButton label="Fit the whole chart" keycap="0" onClick={onFit}>
          <Maximize aria-hidden />
        </ZoomButton>
      </div>
      <div
        data-chart-ignore=""
        data-testid="chart-legend"
        className="bg-surface-quaternary shadow-raised rounded-control text-muted-foreground absolute bottom-3 left-3 flex max-w-[calc(100%-24px)] flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5 text-[11px]"
      >
        {legend}
        <span className="text-(--text-ghost)">
          Drag to pan · scroll to zoom
        </span>
      </div>
      {message !== null && (
        <div
          data-testid="chart-message"
          className="text-muted-foreground pointer-events-none absolute inset-0 grid place-items-center text-[12px]"
        >
          {message}
        </div>
      )}
    </div>
  );
}

/** The group id the Tasks chart boxes loose tasks under; drawn dashed, as outside the plan. */
export const NO_MILESTONE_GROUP = 'group:none';

function ZoomButton({
  label,
  keycap,
  onClick,
  children,
}: {
  label: string;
  keycap: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconButton label={label} onClick={onClick}>
            {children}
          </IconButton>
        }
      />
      <TooltipContent side="left">
        {label} <Kbd>{keycap}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
