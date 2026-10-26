'use client';

import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minus,
  Network,
  Plus,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Link } from '../lib/link';
import { Chip } from '../tasks/chip';
import { cx } from '../tasks/class-names';
import { EmptyState } from '../tasks/notice';
import type { ChipTone } from '../tasks/types';
import styles from './dependency-graph.module.css';
import { CLUSTER_METRICS, edgeKey, layoutGraph } from './layout';
import {
  describePaths,
  longestChain,
  nodePaths,
  pathContext,
  type PathNameCounts,
  pathNameCounts,
  pathNamePhrase,
  pathNodeName,
  resolvePathWords,
} from './paths';
import type {
  DependencyGraphProps,
  GraphClusterData,
  GraphEdgeKind,
  GraphHighlight,
  GraphLayout,
  GraphNodeData,
  GraphNodeTone,
  LaidOutEdge,
  LaidOutGroup,
  LaidOutNode,
} from './types';

// Zoom bounds and steps. Buttons and keys step by a fixed factor; ctrl /
// cmd + wheel (and trackpad pinch, which browsers report as ctrl + wheel)
// zooms continuously around the pointer.
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const ZOOM_STEP = 1.2;
const WHEEL_RATE = 0.0025;
const FIT_PADDING = 16;
/** Pointer travel (px) before a press on the background becomes a pan. */
const PAN_THRESHOLD = 3;
/** Pointer travel (px) before a press on a box becomes a pan: more than
    on the background, so a shaky click still locks the box. */
const NODE_PAN_THRESHOLD = 8;
/**
 * How long (ms) a second tap on the same box still makes a double tap
 * (browsers do not count taps reliably), and how long a second tap on the
 * locked box waits before it opens, so a double tap drills down instead.
 */
export const DOUBLE_PRESS_MS = 300;
/**
 * How long (ms) a mouse's second click on the locked box waits before it
 * opens the box: the longest common double-click time (Windows and macOS
 * default to about 500 ms, GTK to 400 ms), so a slow double-click still
 * drills down instead of opening the box on the way. The strip's Open
 * opens at once.
 */
export const DOUBLE_CLICK_MS = 500;
/** The room (px) the action strip leaves round the box: the path ring
    (2px, hugging the box) and the keyboard focus ring (2px wide, 1px out)
    show whole beside the strip. */
const LOCK_RING = 4;
/** The least gap (px) the action strip keeps from the frame's edge, from
    the screen's fixed bars and from the step control. */
const STRIP_EDGE = 4;
/** The least part (px) of the box the action strip stays beside, so it
    reads as the box's own while it slides to stay in view. */
const STRIP_OVERLAP = 24;

/** A rectangle in canvas px (zoom applied). */
interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The area two rectangles share (0 when they do not meet). */
function sharedArea(a: CanvasRect, b: CanvasRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Where the strip sits beside the locked box. */
export type LockStripSide = 'below' | 'above' | 'right' | 'left';

/** `value` held inside [low, high] (low wins when they cross). */
function clampTo(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

/**
 * Where the locked box's action strip goes, in canvas px (zoom applied).
 * It hangs just outside the box (LOCK_RING), in this order of preference:
 * under it, over it, beside it on the right, beside it on the left. A
 * place counts only when the strip fits whole inside `visible` (the part
 * of the frame on screen, clear of the screen's fixed bars) and meets
 * nothing in `blocked` (a control drawn over the frame, such as the
 * critical path's step control). A side in `beside` set to false is left
 * out: the graph leaves out the side its own arrows leave or enter by, so
 * the strip never hides the start of the path the reader locked on. Of
 * the places that count, the one covering the least of the words in
 * `avoid` wins (other boxes' words and frame titles: in a dense drawing
 * the gap between two rows of boxes is narrower than the strip), the
 * earlier one on a tie. When none counts, the place that keeps the most
 * of the strip on screen wins (one clear of `blocked` on a tie). Under or
 * over the box it is aligned with
 * the box's left edge and slid across to stay on screen; beside it,
 * aligned with its top and slid up or down; never so far that it leaves
 * the box's side, and never over the box itself.
 */
export function lockStripPlace(input: {
  box: CanvasRect;
  strip: { width: number; height: number };
  visible: { left: number; top: number; right: number; bottom: number };
  avoid?: readonly CanvasRect[];
  blocked?: readonly CanvasRect[];
  beside?: { left: boolean; right: boolean };
}): { left: number; top: number; side: LockStripSide } {
  const {
    box,
    strip,
    visible,
    avoid = [],
    blocked = [],
    beside = { left: true, right: true },
  } = input;
  // The ring round the box, which the strip hangs from.
  const ring = {
    left: box.x - LOCK_RING,
    top: box.y - LOCK_RING,
    right: box.x + box.width + LOCK_RING,
    bottom: box.y + box.height + LOCK_RING,
  };
  const overlap = Math.min(STRIP_OVERLAP, ring.right - ring.left);
  // Across (under or over the box): from the ring's left edge, slid into
  // view, then back so at least `overlap` px of the box stay beside it.
  const across = clampTo(
    clampTo(
      ring.left,
      visible.left + STRIP_EDGE,
      visible.right - STRIP_EDGE - strip.width
    ),
    ring.left + overlap - strip.width,
    ring.right - overlap
  );
  // Down (beside the box): from the ring's top, slid into view, then kept
  // along the box's side (the whole strip, when the box is taller).
  const sideLow = Math.min(ring.top, ring.bottom - strip.height);
  const sideHigh = Math.max(ring.top, ring.bottom - strip.height);
  const down = clampTo(
    clampTo(
      ring.top,
      visible.top + STRIP_EDGE,
      visible.bottom - STRIP_EDGE - strip.height
    ),
    sideLow,
    sideHigh
  );
  const places: { side: LockStripSide; left: number; top: number }[] = [
    { side: 'below', left: across, top: ring.bottom },
    { side: 'above', left: across, top: ring.top - strip.height },
  ];
  if (beside.right) places.push({ side: 'right', left: ring.right, top: down });
  if (beside.left) {
    places.push({ side: 'left', left: ring.left - strip.width, top: down });
  }
  const rectOf = (place: { left: number; top: number }): CanvasRect => ({
    x: place.left,
    y: place.top,
    width: strip.width,
    height: strip.height,
  });
  const screen: CanvasRect = {
    x: visible.left,
    y: visible.top,
    width: Math.max(0, visible.right - visible.left),
    height: Math.max(0, visible.bottom - visible.top),
  };
  // A blocked control keeps a small gap round it.
  const keepOut = blocked.map((rect) => ({
    x: rect.x - STRIP_EDGE,
    y: rect.y - STRIP_EDGE,
    width: rect.width + STRIP_EDGE * 2,
    height: rect.height + STRIP_EDGE * 2,
  }));
  let best: (typeof places)[number] | null = null;
  let bestCover = Number.POSITIVE_INFINITY;
  // With no place that counts: the most of the strip on screen (a strip
  // off screen helps nobody, even when on screen it must cover a control,
  // as for a box half out of the frame's corner), then one clear of the
  // blocked controls.
  let fallback = places[0];
  let fallbackShown = Number.NEGATIVE_INFINITY;
  let fallbackClear = false;
  for (const place of places) {
    const at = rectOf(place);
    const clear = keepOut.every((rect) => sharedArea(at, rect) === 0);
    const shown = sharedArea(at, screen);
    if (
      shown > fallbackShown ||
      (shown === fallbackShown && clear && !fallbackClear)
    ) {
      fallback = place;
      fallbackShown = shown;
      fallbackClear = clear;
    }
    const fits =
      clear &&
      place.left >= visible.left &&
      place.left + strip.width <= visible.right &&
      place.top >= visible.top &&
      place.top + strip.height <= visible.bottom;
    if (!fits) continue;
    let cover = 0;
    for (const rect of avoid) cover += sharedArea(at, rect);
    if (cover < bestCover) {
      best = place;
      bestCover = cover;
    }
  }
  const chosen = best ?? fallback;
  return {
    left: Math.round(chosen.left),
    top: Math.round(chosen.top),
    side: chosen.side,
  };
}

/**
 * The part of the window the reader can see, in client px: the visual
 * viewport (a pinch zoom shows less of the page), less the bars fixed
 * over the page's edges (`data-ui-edge-bar="top"` or `"bottom"`, the app
 * shell's sticky top bar and a phone's fixed tab bar). The lock's strip
 * stays inside it, so it never sits under a bar where it cannot be tapped.
 */
function screenArea(): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const view = window.visualViewport;
  const left = view?.offsetLeft ?? 0;
  let top = view?.offsetTop ?? 0;
  const right = left + (view?.width ?? window.innerWidth);
  let bottom = top + (view?.height ?? window.innerHeight);
  for (const bar of document.querySelectorAll<HTMLElement>(
    '[data-ui-edge-bar]'
  )) {
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (bar.dataset.uiEdgeBar === 'bottom') {
      bottom = Math.min(bottom, rect.top);
    } else if (bar.dataset.uiEdgeBar === 'top') {
      top = Math.max(top, rect.bottom);
    }
  }
  return {
    left,
    top,
    right: Math.max(left, right),
    bottom: Math.max(top, bottom),
  };
}

/** The least frame width (px) a host's right-hand panel must leave
    uncovered for the graph to keep room beside it (coveredRight). */
const MIN_UNCOVERED = 240;

/**
 * How many px at the frame's right a panel of `width` px, fixed along the
 * window's right edge, covers: 0 for no panel, for one that misses the
 * frame, or for one that would leave less than MIN_UNCOVERED of it (a
 * phone's full-width sheet, where moving the drawing helps nobody).
 */
function coveredPart(viewport: HTMLElement, width: number): number {
  if (width <= 0) return 0;
  const frame = viewport.getBoundingClientRect();
  const panelLeft = window.innerWidth - Math.min(width, window.innerWidth);
  const covered = Math.max(0, frame.right - Math.max(panelLeft, frame.left));
  return viewport.clientWidth - covered >= MIN_UNCOVERED
    ? Math.round(covered)
    : 0;
}

/**
 * The boxes a framed drawing opens on: those of the top-level frame that
 * holds the first box in reading order (layoutGraph lists a clustered
 * layout's boxes frame by frame, and packs the frames from the top-left),
 * or, when that box sits in no frame, the loose boxes at the top level.
 */
function firstFrameNodes(layout: GraphLayout): readonly LaidOutNode[] {
  const first = layout.nodes[0];
  if (first === undefined) return [];
  const within = (n: LaidOutNode, g: LaidOutGroup) =>
    n.x >= g.x &&
    n.y >= g.y &&
    n.x + n.width <= g.x + g.width &&
    n.y + n.height <= g.y + g.height;
  const tops = layout.groups.filter(
    (g) => g.kind === 'cluster' && (g.depth ?? 0) === 0
  );
  const frame = tops.find((g) => within(first, g));
  return frame === undefined
    ? layout.nodes.filter((n) => !tops.some((g) => within(n, g)))
    : layout.nodes.filter((n) => within(n, frame));
}

/**
 * Where a graph with nothing to centre on (no focus, no selection) opens,
 * as frame scroll offsets at zoom `k`. dagre leaves empty space around a
 * layered drawing, so a big graph scrolled to (0, 0) can show no box at
 * all. In an unframed drawing blockers sit left of what waits (above it,
 * top-down), so the flow starts at the drawing's first layer: the frame
 * stays at the start of the flow axis and slides along the other axis to
 * the band, starting at a box, where the most boxes of that first
 * frame-length show whole (the earliest such band on a tie). A framed
 * drawing (`clustered`) opens on its first frame instead, which the
 * packing puts at the top-left: it stays at (0, 0) while that frame shows
 * a box whole there, and otherwise slides to the band of that frame's own
 * boxes, never to a later frame. Null, so nothing moves, when the frame
 * has no size, the drawing fits it across, or no box fits its flow length.
 */
function openingScroll(
  layout: GraphLayout,
  horizontal: boolean,
  frameWidth: number,
  frameHeight: number,
  k: number
): { left: number; top: number } | null {
  const flowLength = horizontal ? frameWidth : frameHeight;
  const crossLength = horizontal ? frameHeight : frameWidth;
  if (flowLength <= 0 || crossLength <= 0) return null;
  let crossExtent = 0;
  for (const n of layout.nodes) {
    crossExtent = Math.max(
      crossExtent,
      (horizontal ? n.y + n.height : n.x + n.width) * k
    );
  }
  if (crossExtent <= crossLength) return null;
  const framed = layout.clustered === true;
  // The candidate boxes whole along the flow from its start, as
  // cross-axis spans.
  const spans: { start: number; end: number }[] = [];
  for (const n of framed ? firstFrameNodes(layout) : layout.nodes) {
    const start = (horizontal ? n.y : n.x) * k;
    const end = start + (horizontal ? n.height : n.width) * k;
    const flowEnd = (horizontal ? n.x + n.width : n.y + n.height) * k;
    if (flowEnd <= flowLength) spans.push({ start, end });
  }
  if (spans.length === 0) return null;
  // The first frame already shows a box whole at the origin.
  if (framed && spans.some((s) => s.end <= crossLength)) return null;
  // Each band starts just above (left of) one of those boxes.
  let best = Number.POSITIVE_INFINITY;
  let bestCount = 0;
  for (const band of spans) {
    const offset = Math.max(0, band.start - FIT_PADDING);
    let count = 0;
    for (const s of spans) {
      if (s.start >= offset && s.end <= offset + crossLength) count += 1;
    }
    if (count > bestCount || (count === bestCount && offset < best)) {
      best = offset;
      bestCount = count;
    }
  }
  // No box fits across the frame whole: show the start of the first one.
  if (bestCount === 0) {
    best = Math.max(0, Math.min(...spans.map((s) => s.start)) - FIT_PADDING);
  }
  const cross = Math.round(best);
  return horizontal ? { left: 0, top: cross } : { left: cross, top: 0 };
}

const EDGE_WORDS: Record<GraphEdgeKind, string> = {
  default: 'blocks',
  risk: 'blocks, on a risk chain',
  cycle: 'blocks, in a cycle',
  cross: 'blocks, across projects',
  resolved: 'no longer blocks',
};

const EDGE_CLASS: Record<GraphEdgeKind, string | undefined> = {
  default: styles.edgeDefault,
  risk: styles.edgeRisk,
  cycle: styles.edgeCycle,
  cross: styles.edgeCross,
  resolved: styles.edgeResolved,
};

/** How a tag word is drawn: a Chip's tone, and whether a status tone is
    the tinted badge (filled) rather than the dot pill. */
interface TagChip {
  tone: ChipTone;
  filled: boolean;
}

/**
 * The tag words with a tone of their own (§8.2 "Status colours"): the
 * stronger claims tinted (Unassigned amber; a cycle red), the lighter ones
 * a dot pill (Overdue red, its box tinted under Risk; No lead amber), a
 * paused box's Inactive quiet text. Any other word is a neutral chip.
 * layout.ts keeps the dot's room for the dot pills (DOT_TAGS).
 */
const TAG_CHIP: Readonly<Record<string, TagChip>> = {
  Unassigned: { tone: 'warning', filled: true },
  Overdue: { tone: 'danger', filled: false },
  Cycle: { tone: 'danger', filled: true },
  'On a cycle': { tone: 'danger', filled: true },
  'Cycle inside': { tone: 'danger', filled: true },
  'No lead': { tone: 'warning', filled: false },
  Inactive: { tone: 'muted', filled: false },
};

const NEUTRAL_CHIP: TagChip = { tone: 'default', filled: false };

/**
 * The readiness chip's look: under Status the node's readiness tone (a
 * ready or clear node a green dot pill, a blocked or stuck one tinted, a
 * paused one quiet), elsewhere the neutral badge that keeps its word.
 */
function readinessChip(tone: GraphNodeTone | undefined): TagChip {
  if (tone === undefined || tone === 'default') return NEUTRAL_CHIP;
  return { tone, filled: tone === 'warning' || tone === 'danger' };
}

/** A node or edge while paths are shown: the node being read, what it
    waits on (lit), what it holds up (down), on the critical path shown
    (chain), or receding (dim). */
type HighlightState = 'active' | 'lit' | 'down' | 'chain' | 'dim';

const STATE_CLASS: Record<HighlightState, string | undefined> = {
  active: styles.active,
  lit: styles.lit,
  down: styles.down,
  chain: styles.chain,
  dim: styles.dim,
};

/** Overlay paint order: what it holds up, then what it waits on (an edge
    walked both ways is drawn as upstream), then the critical path. */
const OVERLAY_ORDER: readonly HighlightState[] = ['down', 'lit', 'chain'];

/**
 * The tone a node is drawn in under `highlight`: Status takes the host's
 * readiness tone (else its `tone`), Risk its `tone`, and Critical keeps
 * only closed or paused work faint, so the numbered path is all that
 * stands out.
 */
function shownTone(
  node: GraphNodeData,
  highlight: GraphHighlight
): GraphNodeTone {
  if (highlight === 'status') return node.readiness?.tone ?? node.tone;
  if (highlight === 'critical') {
    return node.tone === 'muted' || node.readiness?.tone === 'muted'
      ? 'muted'
      : 'default';
  }
  return node.tone;
}

// useLayoutEffect warns nowhere in React 19, but it never runs on the
// server; the alias keeps intent clear for hosts that render there.
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** True when a key press belongs to a text field, not to the graph. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * The labels of the frames each node sits in, innermost first ("Beta",
 * "Orion"), from the graph's clusters: what a sighted reader gets from the
 * frame around a box. A parent chain that loops back stops where it
 * repeats.
 */
function frameLabels(
  nodes: readonly GraphNodeData[],
  clusters: readonly GraphClusterData[] | undefined
): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  if (clusters === undefined || clusters.length === 0) return labels;
  const byId = new Map<string, GraphClusterData>();
  for (const cluster of clusters) {
    if (!byId.has(cluster.id)) byId.set(cluster.id, cluster);
  }
  for (const node of nodes) {
    const path: string[] = [];
    const seen = new Set<string>();
    let id = node.cluster;
    while (id !== undefined && !seen.has(id)) {
      const cluster = byId.get(id);
      if (cluster === undefined) break;
      seen.add(id);
      path.push(cluster.label);
      id = cluster.parent;
    }
    if (path.length > 0) labels.set(node.id, path);
  }
  return labels;
}

/**
 * The next box from `current` for an arrow key in a clustered layout,
 * where columns are per frame rather than global: the nearest box whose
 * centre lies that way, a step straight along the key's axis counting
 * half as much as one across it. Null when nothing lies that way.
 */
function nearestThatWay(
  nodes: readonly LaidOutNode[],
  current: LaidOutNode,
  key: string
): LaidOutNode | null {
  const dirs: Record<string, [number, number]> = {
    ArrowRight: [1, 0],
    ArrowLeft: [-1, 0],
    ArrowDown: [0, 1],
    ArrowUp: [0, -1],
  };
  const dir = dirs[key];
  if (dir === undefined) return null;
  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  let best: LaidOutNode | null = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    if (n === current) continue;
    const dx = n.x + n.width / 2 - cx;
    const dy = n.y + n.height / 2 - cy;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 1) continue;
    const across = Math.abs(dx * dir[1] + dy * dir[0]);
    const score = along + across * 2;
    if (score < bestScore) {
      best = n;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The sentence a screen reader hears on a node: name, context, status,
 * its readiness word and flags, scope, how many nodes it waits on and
 * holds up over the drawn edges (transitive within PATH_NAME_BUDGET, else
 * direct) and what finishing it would unblock, its step on the critical
 * path shown at rest (Critical only), and last the focus words when the
 * graph is about this node. Computed once per edge list, so it never
 * changes under the reader's focus.
 */
function nodeName(
  node: GraphNodeData,
  counts: PathNameCounts | undefined,
  step: { k: number; s: number } | null,
  focusWords: string | null,
  frames: readonly string[] = []
): string {
  const parts = [node.label];
  if (node.sublabel !== undefined && node.sublabel !== '') {
    parts.push(node.sublabel);
  }
  if (frames.length > 0) parts.push(`in ${frames.join(', ')}`);
  if (node.statusLabel !== undefined && node.statusLabel !== '') {
    parts.push(node.statusLabel);
  }
  const flags = [node.readiness?.label ?? '', ...(node.tags ?? [])].filter(
    (flag) => flag !== ''
  );
  if (flags.length > 0) {
    parts.push(flags.map((flag) => flag.toLowerCase()).join(', '));
  }
  if (node.external === true) parts.push('outside this scope');
  parts.push(
    pathNamePhrase(
      counts ?? { transitive: true, waitsOn: 0, holdsUp: 0, unblocks: 0 }
    )
  );
  if (step !== null) {
    parts.push(`step ${step.k} of ${step.s} on the critical path`);
  }
  if (focusWords !== null && focusWords !== '') parts.push(focusWords);
  return `${parts.join('. ')}.`;
}

/** The ids of edges marked `cross`, keyed as drawn (the first of a
    repeated pair wins, layoutGraph's rule). */
function crossKeysOf(edges: DependencyGraphProps['edges']): Set<string> {
  const keys = new Set<string>();
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = edgeKey(edge.from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    if (edge.cross === true) keys.add(key);
  }
  return keys;
}

/**
 * True when a press on the frame landed on its own scrollbar. Browsers
 * report that press to the page but may never send the matching
 * pointerup, so it must not start a pan.
 */
function onScrollbar(
  viewport: HTMLElement,
  event: ReactMouseEvent<HTMLDivElement>
): boolean {
  if (event.target !== viewport) return false;
  const { offsetX, offsetY } = event.nativeEvent;
  return (
    (viewport.clientWidth > 0 && offsetX >= viewport.clientWidth) ||
    (viewport.clientHeight > 0 && offsetY >= viewport.clientHeight)
  );
}

/**
 * Next node for a key: Home/End jump to the first/last box in focus
 * order; along the rank axis an arrow jumps to the nearest box (by centre)
 * in the neighbouring rank; across it, it steps within the rank. In a
 * clustered layout an arrow moves to the nearest box that way instead
 * (nearestThatWay).
 */
function neighbour(
  nodes: readonly LaidOutNode[],
  current: LaidOutNode,
  key: string,
  horizontal: boolean,
  clustered = false
): LaidOutNode | null {
  if (key === 'Home') return nodes[0] ?? null;
  if (key === 'End') return nodes[nodes.length - 1] ?? null;
  if (clustered) return nearestThatWay(nodes, current, key);
  const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
  const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
  const down = horizontal ? 'ArrowDown' : 'ArrowRight';
  const up = horizontal ? 'ArrowUp' : 'ArrowLeft';
  const cross = (n: LaidOutNode) =>
    horizontal ? n.y + n.height / 2 : n.x + n.width / 2;
  if (key === down || key === up) {
    const rank = nodes.filter((n) => n.rank === current.rank);
    const at = rank.indexOf(current);
    return rank[at + (key === down ? 1 : -1)] ?? null;
  }
  if (key !== forward && key !== back) return null;
  const step = key === forward ? 1 : -1;
  let rank = current.rank + step;
  const last = nodes.length === 0 ? 0 : nodes[nodes.length - 1].rank;
  while (rank >= 0 && rank <= last) {
    let best: LaidOutNode | null = null;
    let bestDistance = Infinity;
    for (const n of nodes) {
      if (n.rank !== rank) continue;
      const distance = Math.abs(cross(n) - cross(current));
      if (distance < bestDistance) {
        best = n;
        bestDistance = distance;
      }
    }
    if (best !== null) return best;
    rank += step;
  }
  return null;
}

/**
 * The key help every node points at (aria-describedby): moving, locking
 * and opening (when nodes open), the drill-down key (when some node has a
 * graph to open), the critical path's keys, zooming and the touch
 * gestures.
 */
function keyHelp(opens: boolean, drills: boolean, steps: boolean): string {
  const lock = opens
    ? 'Enter locks a box, keeping its paths lit; Enter on the locked box opens it'
    : 'Enter locks a box, keeping its paths lit';
  const parts = [
    'Arrow keys move between nodes, Home and End jump to the first and last.',
    `${lock}${drills ? `, Shift and Enter opens its graph${opens ? ' (the box itself when it has none)' : ''}` : ''}, Tab reaches its buttons and Escape unlocks.`,
    'Minus, plus and 0 zoom.',
  ];
  if (steps) {
    parts.push('Right and left square brackets move along the critical path.');
  }
  parts.push(
    opens
      ? `On a touch screen, a tap locks a box and a second tap opens it${drills ? '; a double tap opens its graph' : ''}.`
      : "On a touch screen, a tap locks a box's paths."
  );
  return parts.join(' ');
}

/** The leading (px) above and below a line of words that the strip may
    cover without hiding any of its letters. */
const WORDS_LEADING = 2;

/**
 * The locked box's action strip (Open, Open graph, Unlock), drawn in the
 * canvas beside the box at its zoomed place but at its own size, so its
 * targets stay readable and at least 24px at any zoom. lockStripPlace
 * puts it under, over or beside the box, inside the part of the frame on
 * screen (clear of the screen's fixed bars, screenArea) and clear of the
 * critical path's step control. It is placed again on every scroll of the
 * frame or the page and every resize, straight on the element: the graph
 * itself never re-renders while the reader pans with a box locked. It
 * finds the canvas and the frame from its own element, not from the
 * graph's refs: a lock from the URL draws the strip in the graph's first
 * render, when this effect runs before the graph's own refs are attached
 * (a child's layout effects run first), and it was never placed.
 */
function LockStrip({
  box,
  zoom,
  reserveRef,
  steps,
  beside,
  label,
  children,
}: {
  box: LaidOutNode;
  zoom: number;
  reserveRef: { readonly current: number };
  /** Whether the critical path's step control is drawn over the frame (it
      comes and goes with the highlight), so the strip is placed again
      when it does. */
  steps: boolean;
  /** The sides the strip may take beside the box (not the ones its own
      arrows use). */
  beside: { left: boolean; right: boolean };
  label: string;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const besideLeft = beside.left;
  const besideRight = beside.right;
  useIsomorphicLayoutEffect(() => {
    const strip = ref.current;
    // The strip sits straight in the canvas, inside the frame.
    const canvas = strip?.parentElement ?? null;
    const viewport =
      strip?.closest<HTMLElement>('[data-graph-viewport]') ?? null;
    if (strip === null || viewport === null || canvas === null) {
      return undefined;
    }
    // The words the strip should rather not cover (every other box's words
    // and the frame titles in a band around the box, less their leading),
    // measured once per box and zoom: a scroll moves them with the canvas.
    const avoid: CanvasRect[] = [];
    const origin = canvas.getBoundingClientRect();
    const band = strip.offsetHeight + LOCK_RING * 2;
    const bandTop = box.y * zoom - band;
    const bandBottom = (box.y + box.height) * zoom + band;
    for (const el of canvas.querySelectorAll(
      '[data-graph-words], [data-graph-cluster-title]'
    )) {
      const r = el.getBoundingClientRect();
      const y = r.top - origin.top;
      const outside = y > bandBottom || y + r.height < bandTop;
      if (r.width === 0 || r.height === 0 || outside) continue;
      avoid.push({
        x: r.left - origin.left,
        y: y + WORDS_LEADING,
        width: r.width,
        height: Math.max(0, r.height - WORDS_LEADING * 2),
      });
    }
    const place = () => {
      // A frame with no size (not laid out yet) keeps the first place.
      if (viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
      const left = viewport.scrollLeft - canvas.offsetLeft;
      const top = viewport.scrollTop - canvas.offsetTop;
      // What of the window shows, in canvas px (the canvas moves with the
      // frame's and the page's scroll, so it is read again each time).
      const at = canvas.getBoundingClientRect();
      const screen = screenArea();
      const blocked: CanvasRect[] = [];
      // Read from the DOM, not a ref: the control is drawn after the frame,
      // so its ref is not attached yet when this first runs.
      const control = viewport.parentElement
        ?.querySelector('[data-graph-steps]')
        ?.getBoundingClientRect();
      if (control !== undefined && control.width > 0 && control.height > 0) {
        blocked.push({
          x: control.left - at.left,
          y: control.top - at.top,
          width: control.width,
          height: control.height,
        });
      }
      const spot = lockStripPlace({
        box: {
          x: box.x * zoom,
          y: box.y * zoom,
          width: box.width * zoom,
          height: box.height * zoom,
        },
        strip: { width: strip.offsetWidth, height: strip.offsetHeight },
        visible: {
          left: Math.max(left, screen.left - at.left + STRIP_EDGE),
          top: Math.max(top, screen.top - at.top + STRIP_EDGE),
          right: Math.min(
            left + viewport.clientWidth - reserveRef.current,
            screen.right - at.left - STRIP_EDGE
          ),
          bottom: Math.min(
            top + viewport.clientHeight,
            screen.bottom - at.top - STRIP_EDGE
          ),
        },
        avoid,
        blocked,
        beside: { left: besideLeft, right: besideRight },
      });
      strip.style.left = `${spot.left}px`;
      strip.style.top = `${spot.top}px`;
      strip.dataset.side = spot.side;
    };
    place();
    const view = window.visualViewport;
    viewport.addEventListener('scroll', place, { passive: true });
    window.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    view?.addEventListener('scroll', place, { passive: true });
    view?.addEventListener('resize', place);
    const resized =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    resized?.observe(viewport);
    return () => {
      viewport.removeEventListener('scroll', place);
      window.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      view?.removeEventListener('scroll', place);
      view?.removeEventListener('resize', place);
      resized?.disconnect();
    };
  }, [box, zoom, reserveRef, steps, besideLeft, besideRight]);
  return (
    <div
      ref={ref}
      className={styles.lockStrip}
      style={{
        left: Math.round(box.x * zoom - LOCK_RING),
        top: Math.round((box.y + box.height) * zoom + LOCK_RING),
      }}
      role="group"
      aria-label={label}
      data-graph-lock-strip={box.id}
      data-side="below"
    >
      {children}
    </div>
  );
}

/**
 * A dependency graph in Gr8r's look: rounded cards on a recessed canvas
 * (a status diamond, a medium title, a quiet line with the key in mono,
 * sentence-case Chips), blockers on the left (or top), thin curved
 * connectors with small arrowheads, dashes for crossings, dots for what no
 * longer blocks, soft rounded frames around the boxes that share a parent.
 * The `highlight` picks the emphasis: `risk` (default) the status hues for
 * risk (amber chains, dashed red cycles, a red tint for overdue, a 1.5px
 * edge in the node's tone); `status` each node's readiness (a 1px green
 * edge when ready, the 1.5px amber edge when blocked, red when stuck) and
 * green dots for unblocked edges; `critical` the numbered critical path
 * with the rest receding. The purple accent is never a status here: it is
 * the selection, the keyboard focus, the box being read, the lock's
 * corner ticks and the upstream path (its Open button is the strip's one
 * primary).
 *
 * - Hover, focus, a lock or a selection on a node lights both paths:
 *   what it transitively waits on (accent rings and lines) and what waits
 *   on it (--text rings and lines), with a green "Ready next" pill on what
 *   finishing it alone would unblock; the rest recedes, its words and
 *   status marks still legible. Under `critical` it lights the longest
 *   chain through it. The readout line under the drawing says the same in
 *   words.
 * - Lock on (owner request 2026-10-23): a click, a tap or Enter on a node
 *   locks it, so its paths stay lit while the reader pans, scrolls, zooms
 *   or switches the highlight; pointing at other boxes then only outlines
 *   them. The locked node carries its own mark (four rounded accent corner
 *   ticks inside the box, apart from the keyboard focus ring). A second
 *   click (tap, Enter) on the locked node opens it (`onSelect`, else its
 *   link), as does the action strip floating by the box (Open, Open graph,
 *   Unlock) and the readout's copy of it; opening is the host's to keep
 *   idempotent (a second Open on an open box must leave it open). Escape,
 *   a click on the background (not the end of a drag), Unlock, or locking
 *   another node drops it. `lockedId` / `onLockChange` let a host keep it.
 * - A double-click (a double tap, Shift + Enter) on a node follows its
 *   `drillHref`, its own graph one level down; on a frame's title, the
 *   frame's `drillHref`.
 * - Under `critical` a step control over the canvas's bottom-left corner
 *   (and ] / [) walks the path shown at rest (with a node locked, the
 *   chain through it) step by step, centring each; entering `critical`
 *   scrolls the canvas to step 1 unless a step shows or a node is locked.
 * - Nodes are buttons in rank order behind one Tab stop (a roving
 *   tabindex: the last node focused, else the selected one, else the
 *   first). Enter locks, and opens the locked node; arrows move between
 *   neighbouring boxes, Home/End to the first/last; Tab from a box reaches
 *   the locked box's strip.
 * - The panel's canvas scrolls inside itself: drag the background (or a
 *   box) to pan, ctrl/cmd + wheel or the − / + / Fit buttons (or the
 *   - + 0 keys) to zoom. A plain wheel scrolls as usual and the page never
 *   loses its scroll.
 * - Screen readers get the summary sentence on the drawing and a hidden
 *   table of every edge.
 * - `focusId` marks the node the graph is about with an accent ring that
 *   stands off its box (it lights nothing); the first paint scrolls the
 *   canvas so that node, else the selected one, sits in the middle (of
 *   the part a host's open right-hand panel leaves uncovered,
 *   `coveredRight`).
 * - `layout` takes a layout the host already computed (e.g. on the
 *   server), so the client never runs dagre.
 */
export function DependencyGraph({
  nodes,
  edges,
  selectedId = null,
  onSelect,
  lockedId,
  onLockChange,
  onDrill,
  drillHrefFor,
  ariaSummary,
  emptyMessage,
  direction = 'LR',
  cluster,
  clusters,
  toolbar,
  hint,
  layout: givenLayout,
  focusId = null,
  focusLabel = 'focus',
  coveredRight,
  highlight = 'risk',
  readout,
  pathWords,
  className,
}: DependencyGraphProps): ReactNode {
  // A host-computed layout is used as is; dagre runs only without one.
  const layout = useMemo(
    () =>
      givenLayout ??
      layoutGraph(nodes, edges, { direction, cluster, clusters }),
    [givenLayout, nodes, edges, direction, cluster, clusters]
  );
  const framesOf = useMemo(
    () => frameLabels(nodes, clusters),
    [nodes, clusters]
  );
  // Each frame's drill-down graph by cluster id (its drillHref, as the
  // host rewrites it): a double-click on the frame's title follows it.
  const clusterDrill = new Map<string, string>();
  for (const cluster of clusters ?? []) {
    if (cluster.drillHref === undefined || cluster.drillHref === '') continue;
    clusterDrill.set(
      cluster.id,
      drillHrefFor === undefined
        ? cluster.drillHref
        : drillHrefFor(cluster.drillHref)
    );
  }
  const horizontal = layout.direction === 'LR';
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // The drawn graph indexed once per node and edge list: the path walks,
  // the critical-path facts and every node's name counts.
  const ctx = useMemo(() => pathContext(nodes, edges), [nodes, edges]);
  const nameCounts = useMemo(() => pathNameCounts(ctx), [ctx]);
  const crossKeys = useMemo(() => crossKeysOf(edges), [edges]);
  const words = useMemo(() => resolvePathWords(pathWords), [pathWords]);
  const drawn = (id: string | null): string | null =>
    id !== null && byId.has(id) ? id : null;

  const [hoverId, setHoverId] = useState<string | null>(null);
  // The box under the pointer, kept also while a lock holds the highlight
  // (when no state is set for it, so pointing round a locked graph
  // re-renders nothing): dropping the lock lights what the pointer is on.
  const hoverRef = useRef<string | null>(null);
  // The node holding keyboard focus (not the `focusId` prop, which names
  // the node the whole graph is about).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // The locked node: the host's (`lockedId`), else the graph's own.
  const [ownLock, setOwnLock] = useState<string | null>(null);
  const lockedNodeId = drawn(lockedId === undefined ? ownLock : lockedId);
  // The node a touch press went down on, until its click (or a cancel,
  // which a scroll sends) reads it: a tap's double press is timed here.
  const pendingTouch = useRef<string | null>(null);
  // The critical path's step the reader walked to with the step control
  // or [ and ] (Critical only): lit like the lock (over it, while one is
  // held) until they point elsewhere (unlocked), press a box, press
  // Escape, tap the background or switch the highlight.
  const [walkId, setWalkId] = useState<string | null>(null);
  const [walkHighlight, setWalkHighlight] = useState(highlight);
  if (highlight !== walkHighlight) {
    setWalkHighlight(highlight);
    setWalkId(null);
  }
  // A touch press focuses the node in Chromium: that focus is the tap's,
  // not the keyboard's, so it never lights the paths on its own (the lock
  // does), and an unlock leaves no trace behind on the tapped box.
  const touchFocus = useRef<string | null>(null);
  // The chain the names count steps on: the one shown at rest (through
  // the locked box when it is on an open chain, else through the
  // selection, else the focus, else graph-wide), so a name never changes
  // under hover. The step control walks it too, so with a box locked it
  // walks the chain the lock lights, not one elsewhere on the canvas.
  const restId = drawn(selectedId) ?? drawn(focusId);
  const nameChain = useMemo(() => {
    if (highlight !== 'critical') return null;
    const throughLock =
      lockedNodeId === null ? null : longestChain(ctx.chains, lockedNodeId);
    return throughLock ?? longestChain(ctx.chains, restId);
  }, [highlight, ctx, restId, lockedNodeId]);
  // Each step's box in order (a cycle's step: its first member).
  const chainSteps = useMemo(
    () =>
      nameChain === null
        ? []
        : nameChain.groups
            .map((group) => group[0])
            .filter((id) => id !== undefined),
    [nameChain]
  );
  const walkStep =
    walkId === null || nameChain === null
      ? null
      : (nameChain.steps.get(walkId) ?? null);
  const walkedId = walkStep === null ? null : walkId;
  // While a node is locked, pointing at or focusing another previews
  // nothing: the lock keeps its paths lit (a walked step still shows).
  const previewing = lockedNodeId === null;
  // The node the reader is on right now (pointer, keyboard focus, a
  // walked step, the lock): drawn with the soft accent tint and the accent
  // ring on every input, unlike a selection or a chain's focus, which
  // light their paths at rest.
  const pointedId =
    [
      previewing ? hoverId : null,
      previewing ? focusedId : null,
      walkedId,
      lockedNodeId,
    ].find((id) => drawn(id) !== null) ?? null;
  // The node whose paths are lit: hover, else keyboard focus (neither
  // while locked), else the walked step, else the lock, else the
  // selection; under Critical, else the chain's focus.
  const activeId =
    pointedId ??
    [selectedId, highlight === 'critical' ? focusId : null].find(
      (id) => drawn(id) !== null
    ) ??
    null;
  const paths = useMemo(
    () =>
      activeId === null || highlight === 'critical'
        ? null
        : nodePaths(activeId, ctx),
    [activeId, highlight, ctx]
  );
  const nextIds = useMemo(() => new Set(paths?.next ?? []), [paths]);
  // Critical: the chain through the active node, else the graph-wide one;
  // on a walked step, the chain being walked (so its numbers hold).
  const shownChain = useMemo(
    () =>
      highlight !== 'critical'
        ? null
        : activeId !== null && activeId === walkedId
          ? nameChain
          : longestChain(ctx.chains, activeId),
    [highlight, ctx, activeId, walkedId, nameChain]
  );
  const showing =
    highlight === 'critical'
      ? activeId !== null || shownChain !== null
      : paths !== null;

  /** A node's highlight state, undefined at rest. */
  const nodeState = (id: string): HighlightState | undefined => {
    if (!showing) return undefined;
    if (id === activeId) return 'active';
    if (highlight === 'critical') {
      return shownChain?.steps.has(id) === true ? 'chain' : 'dim';
    }
    if (paths?.upIds.has(id) === true) return 'lit';
    if (paths?.downIds.has(id) === true) return 'down';
    return 'dim';
  };

  /** An edge's highlight state, undefined at rest. */
  const edgeState = (key: string): HighlightState | undefined => {
    if (!showing) return undefined;
    if (highlight === 'critical') {
      return shownChain?.edgeKeys.has(key) === true ? 'chain' : 'dim';
    }
    if (paths?.upEdgeKeys.has(key) === true) return 'lit';
    if (paths?.downEdgeKeys.has(key) === true) return 'down';
    return 'dim';
  };

  // The readout's subject: the lit node, else the node the graph is about.
  const subjectId = activeId ?? drawn(focusId);
  const readoutLine = useMemo(() => {
    if (subjectId === null) return null;
    return describePaths(
      subjectId,
      ctx,
      words,
      highlight,
      highlight === 'critical' && subjectId === activeId
        ? shownChain
        : undefined
    );
  }, [subjectId, ctx, words, highlight, activeId, shownChain]);

  // The one node Tab reaches. Focus moves it; a new selection from
  // outside (a drawer's "Waits on" list) moves it too, so Tab returns to
  // what the reader picked last. Before either, Tab lands on the node the
  // graph is about.
  const [rovingId, setRovingId] = useState<string | null>(null);
  const [seenSelected, setSeenSelected] = useState(selectedId);
  if (selectedId !== seenSelected) {
    setSeenSelected(selectedId);
    if (selectedId !== null) setRovingId(selectedId);
  }
  const tabStop =
    [rovingId, selectedId, focusId].find((id) => id !== null && byId.has(id)) ??
    layout.nodes[0]?.id ??
    null;
  const helpId = useId();

  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [zoom, setZoom] = useState(1);
  // A content point that must stay under a client point across a zoom.
  const anchorRef = useRef<{
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);
  // Event handlers read the zoom through a ref so the wheel listener is
  // attached once, not on every zoom step.
  const zoomRef = useRef(zoom);
  useIsomorphicLayoutEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  /** Zooms to `next`, keeping the content under (clientX, clientY) still. */
  const zoomAround = useCallback(
    (next: number, clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current;
      const canvas = canvasRef.current;
      const target = clampZoom(next);
      if (viewport === null || canvas === null) {
        setZoom(target);
        return;
      }
      const frame = viewport.getBoundingClientRect();
      const box = canvas.getBoundingClientRect();
      const cx0 = clientX ?? frame.left + frame.width / 2;
      const cy0 = clientY ?? frame.top + frame.height / 2;
      const k = zoomRef.current;
      anchorRef.current = {
        clientX: cx0,
        clientY: cy0,
        x: (cx0 - box.left) / k,
        y: (cy0 - box.top) / k,
      };
      setZoom(target);
    },
    []
  );

  // After a zoom renders, scroll so the anchored point is back under the
  // pointer (or the frame centre).
  useIsomorphicLayoutEffect(() => {
    const anchor = anchorRef.current;
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    anchorRef.current = null;
    if (anchor === null || viewport === null || canvas === null) return;
    const box = canvas.getBoundingClientRect();
    viewport.scrollLeft += box.left + anchor.x * zoom - anchor.clientX;
    viewport.scrollTop += box.top + anchor.y * zoom - anchor.clientY;
  }, [zoom]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null || layout.width === 0) return;
    const scale = Math.min(
      (viewport.clientWidth - FIT_PADDING * 2) / layout.width,
      (viewport.clientHeight - FIT_PADDING * 2) / layout.height,
      1
    );
    anchorRef.current = null;
    setZoom(clampZoom(scale));
    viewport.scrollTo({ left: 0, top: 0 });
  }, [layout.width, layout.height]);

  // Ctrl/cmd + wheel zooms. React's onWheel is passive, so the listener is
  // attached by hand; a plain wheel is never prevented. The frame only
  // exists while there are nodes, so the listener is (re)attached when it
  // appears: a graph that starts empty and fills later still zooms.
  const hasNodes = nodes.length > 0;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!hasNodes || viewport === null) return undefined;
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAround(
        zoomRef.current * Math.exp(-event.deltaY * WHEEL_RATE),
        event.clientX,
        event.clientY
      );
    }
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [zoomAround, hasNodes]);

  // While a host panel covers the frame's right (coveredRight), the frame
  // gets that much right padding: a drawing narrower than the frame then
  // centres in the uncovered part, and a wider one can scroll its right
  // end out from under the panel. Set on the element before paint (and
  // before the centring below reads it), so nothing jumps.
  const reserveRef = useRef(0);
  useIsomorphicLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!hasNodes || viewport === null) return;
    const reserve = coveredPart(viewport, coveredRight ?? 0);
    reserveRef.current = reserve;
    viewport.style.paddingRight = reserve > 0 ? `${reserve}px` : '';
  }, [hasNodes, coveredRight]);

  // On the first paint that has a frame, centre the node the reader
  // locked (a reload or a shared link), else the node the graph is about
  // (the focus), else the selection, in the frame, so a long chain opens
  // on its subject rather than on its leftmost blocker. Beside a
  // host panel it scrolls only as far as it takes to show the whole box in
  // the uncovered part (when that is less than centring), so the box is
  // not hidden under its own panel and what it waits on, to its left,
  // stays in view. Only the frame scrolls, never the page, with no
  // animation; it happens once, so later selections never move the
  // drawing under the reader. With neither, it opens where the flow starts,
  // or on its first frame when framed (openingScroll), so a big graph never
  // opens on dagre's empty corner or in the middle of a later frame; under
  // Critical it then goes on to the path's first step unless a step already
  // shows (revealChain).
  const centredRef = useRef(false);
  const centreId = lockedNodeId ?? focusId ?? selectedId;

  /** Scrolls the frame (never the page) so box `id` sits in the middle of
      its uncovered part, as far as the drawing's edges allow. */
  const centreOnBox = useCallback(
    (id: string) => {
      const viewport = viewportRef.current;
      const box = layout.nodes.find((n) => n.id === id);
      if (viewport === null || box === undefined) return;
      const k = zoomRef.current;
      const visibleWidth = viewport.clientWidth - reserveRef.current;
      viewport.scrollLeft = Math.max(
        0,
        (box.x + box.width / 2) * k - visibleWidth / 2
      );
      viewport.scrollTop = Math.max(
        0,
        (box.y + box.height / 2) * k - viewport.clientHeight / 2
      );
    },
    [layout]
  );

  /**
   * Brings the critical path being shown at rest into view: unless one of
   * its step boxes already shows whole in the frame, the frame scrolls to
   * step 1. On a big graph the path can run across the whole canvas, so
   * nothing of it may show where the frame is; the step control walks on
   * from there.
   */
  const revealChain = useCallback(() => {
    const viewport = viewportRef.current;
    const first = chainSteps[0];
    if (viewport === null || nameChain === null || first === undefined) {
      return;
    }
    const k = zoomRef.current;
    const left = viewport.scrollLeft;
    const top = viewport.scrollTop;
    const right = left + viewport.clientWidth - reserveRef.current;
    const bottom = top + viewport.clientHeight;
    const shows = layout.nodes.some(
      (n) =>
        nameChain.steps.has(n.id) &&
        n.x * k >= left &&
        (n.x + n.width) * k <= right &&
        n.y * k >= top &&
        (n.y + n.height) * k <= bottom
    );
    if (!shows) centreOnBox(first);
  }, [chainSteps, nameChain, layout, centreOnBox]);

  useIsomorphicLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (centredRef.current || !hasNodes || viewport === null) return;
    centredRef.current = true;
    if (centreId === null) {
      const start = openingScroll(
        layout,
        horizontal,
        viewport.clientWidth - reserveRef.current,
        viewport.clientHeight,
        zoomRef.current
      );
      if (start !== null) {
        viewport.scrollLeft = start.left;
        viewport.scrollTop = start.top;
      }
      if (highlight === 'critical') revealChain();
      return;
    }
    const box =
      centreId === null
        ? undefined
        : layout.nodes.find((n) => n.id === centreId);
    if (box === undefined) return;
    const k = zoomRef.current;
    const visibleWidth = viewport.clientWidth - reserveRef.current;
    const centred = (box.x + box.width / 2) * k - visibleWidth / 2;
    const revealed = (box.x + box.width) * k + FIT_PADDING - visibleWidth;
    viewport.scrollLeft = Math.max(
      0,
      reserveRef.current > 0 ? Math.min(centred, revealed) : centred
    );
    viewport.scrollTop = Math.max(
      0,
      (box.y + box.height / 2) * k - viewport.clientHeight / 2
    );
  }, [hasNodes, centreId, layout, horizontal, highlight, revealChain]);

  // Switching to Critical path (or Back to an entry that shows it) brings
  // the path into view: the reader asked for it, so the frame may move.
  // Not while a box is locked: the lock then shows the chain through that
  // box, and the frame stays on what the reader locked on. Any other
  // change of highlight leaves the frame where it is.
  const shownHighlight = useRef(highlight);
  useIsomorphicLayoutEffect(() => {
    const was = shownHighlight.current;
    shownHighlight.current = highlight;
    if (
      highlight === 'critical' &&
      was !== 'critical' &&
      centredRef.current &&
      lockedNodeId === null
    ) {
      revealChain();
    }
  }, [highlight, revealChain, lockedNodeId]);

  /**
   * Walks the critical path being shown at rest by `delta` steps: the
   * step's box lights like a pin and the frame centres it. `moveFocus`
   * when the walk came from a key on a box: it starts from that box's
   * step (else the walked one) and focus follows, as an arrow key's would.
   * From the step control it starts from the walked step; with neither,
   * from before step 1.
   */
  function walk(delta: 1 | -1, moveFocus: boolean) {
    const count = chainSteps.length;
    if (count === 0) return;
    const focusStep =
      focusedId === null ? undefined : nameChain?.steps.get(focusedId);
    const at = moveFocus
      ? (focusStep ?? walkStep ?? 0)
      : (walkStep ?? focusStep ?? 0);
    const next = Math.min(count, Math.max(1, at + delta));
    if (at !== 0 && next === at) return;
    const id = chainSteps[next - 1];
    if (id === undefined) return;
    setWalkId(id);
    centreOnBox(id);
    if (moveFocus) focusNode(id, true);
  }

  // Link nodes render through the host's <Link>, whose props carry no
  // tabIndex, aria-describedby or a lock's aria-current, so the roving tab
  // stop, the key help and the lock are set on those anchors directly
  // after each render.
  useEffect(() => {
    for (const [id, el] of nodeRefs.current) {
      if (el.matches('a, button, [tabindex]')) continue;
      const anchor = el.querySelector('a');
      if (anchor === null) continue;
      anchor.tabIndex = id === tabStop ? 0 : -1;
      anchor.setAttribute('aria-describedby', helpId);
      if (id === lockedNodeId) anchor.setAttribute('aria-current', 'true');
      else anchor.removeAttribute('aria-current');
    }
  }, [tabStop, helpId, layout, lockedNodeId]);

  // Drag-to-pan with a mouse or pen, from the background or from a box (a
  // press on a box needs a longer travel, so a shaky click still locks
  // it); touch keeps native scrolling. A pan ends in no click: `panned`
  // swallows the click its release sends, so a drag never locks, opens or
  // unlocks anything. A pan that starts on a box (`node`) also drops the
  // trace the press's focus gave it: a drag never leaves a box lit.
  const pan = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
    threshold: number;
    node: string | null;
  } | null>(null);
  const panned = useRef(false);
  const [panning, setPanning] = useState(false);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Every press starts afresh, so a pan's swallowed click that never
    // came (some releases send none) never eats the next real one.
    panned.current = false;
    if (event.pointerType === 'touch' || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-graph-lock-strip]') != null) return;
    const viewport = viewportRef.current;
    if (viewport === null || onScrollbar(viewport, event)) return;
    const node =
      target?.closest('[data-graph-node]')?.getAttribute('data-graph-node') ??
      null;
    pan.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      moved: false,
      threshold: node === null ? PAN_THRESHOLD : NODE_PAN_THRESHOLD,
      node,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = pan.current;
    const viewport = viewportRef.current;
    if (state === null || viewport === null || state.id !== event.pointerId) {
      return;
    }
    // The button came up somewhere the pointerup never reached us (outside
    // the window, a native menu): the pan is over, not a hover-drag.
    if ((event.buttons & 1) === 0) {
      endPan(event);
      return;
    }
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < state.threshold) return;
    if (!state.moved) {
      state.moved = true;
      viewport.setPointerCapture(event.pointerId);
      setPanning(true);
      // The press focused the box it went down on (a mouse press focuses a
      // button): that focus is the drag's, not the keyboard's, so it stops
      // tracing the box (it keeps its tab stop).
      const from = state.node;
      if (from !== null) {
        setFocusedId((current) => (current === from ? null : current));
      }
    }
    viewport.scrollLeft = state.left - dx;
    viewport.scrollTop = state.top - dy;
  }

  function endPan(event: ReactPointerEvent<HTMLDivElement>) {
    const state = pan.current;
    if (state === null || state.id !== event.pointerId) return;
    pan.current = null;
    if (state.moved) {
      panned.current = true;
      viewportRef.current?.releasePointerCapture(event.pointerId);
      setPanning(false);
    }
  }

  // The lock as a handler reads it after the render it was bound in (a
  // timer, the follow-the-selection effect below).
  const lockRef = useRef(lockedNodeId);
  useIsomorphicLayoutEffect(() => {
    lockRef.current = lockedNodeId;
  }, [lockedNodeId]);
  // What the screen-reader status line says: set when the reader locks,
  // moves or drops the lock, so it is announced once, never on hover.
  const [announced, setAnnounced] = useState('');
  // The last press on a node (click, tap or key) and what it did, to tell
  // a double press from two presses.
  const lastPress = useRef<{
    id: string;
    at: number;
    did: 'lock' | 'open' | 'wait' | 'drill';
  } | null>(null);
  // A second click on the locked node, waiting out the double-press window
  // before it opens the node, in case it is the first half of a
  // double-click (or double tap).
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The link node whose anchor openNode clicks: that click follows it.
  const passThrough = useRef<string | null>(null);
  // The last press on a frame title, for its double press.
  const lastTitlePress = useRef<{ id: string; at: number } | null>(null);
  const titleTouch = useRef<string | null>(null);

  function cancelPendingOpen() {
    if (openTimer.current === null) return;
    clearTimeout(openTimer.current);
    openTimer.current = null;
  }
  useEffect(
    () => () => {
      if (openTimer.current !== null) clearTimeout(openTimer.current);
    },
    []
  );

  /**
   * Locks `id` (null unlocks): through `onLockChange` when the host keeps
   * the lock, else in the graph's own state. A new lock drops a walked
   * step and a pending open, and the status line says it once. Dropping
   * the lock lights what the pointer is on again.
   */
  function changeLock(id: string | null) {
    cancelPendingOpen();
    setWalkId(null);
    if (id === lockedNodeId) return;
    if (id === null) {
      // A press after an unlock starts afresh: never the second half of
      // a double press begun before it.
      lastPress.current = null;
      setHoverId(hoverRef.current);
      setAnnounced(`${words.unlocked}.`);
    } else {
      const node = byId.get(id);
      setAnnounced(
        node === undefined
          ? ''
          : `${words.locked} ${node.key !== undefined && node.key !== '' ? `${node.key} ${node.label}` : node.label}.`
      );
    }
    if (lockedId === undefined) setOwnLock(id);
    onLockChange?.(id);
  }

  /** The node's own graph (its drillHref, as the host rewrites it), or
      null when it has none. */
  const drillOf = (id: string): string | null => {
    const href = byId.get(id)?.drillHref;
    if (href === undefined || href === '') return null;
    return drillHrefFor === undefined ? href : drillHrefFor(href);
  };

  /** Goes to a drill-down graph: the host's navigation, else a load. */
  function follow(href: string) {
    if (onDrill !== undefined) onDrill(href);
    else window.location.assign(href);
  }

  /** Opens node `id`: the host's onSelect, else its link (its anchor is
      clicked through), else nothing (false). */
  function openNode(id: string): boolean {
    if (onSelect !== undefined) {
      onSelect(id);
      return true;
    }
    const href = byId.get(id)?.href;
    if (href === undefined || href === '') return false;
    const anchor = nodeRefs.current.get(id)?.querySelector('a');
    if (anchor === null || anchor === undefined) return false;
    passThrough.current = id;
    anchor.click();
    return true;
  }

  /** The second press on the locked node: open it, or, on a node that
      opens nothing, drop the lock. */
  function openLocked(id: string) {
    if (!openNode(id)) changeLock(null);
  }
  // The timer below runs after later renders: it opens with their props.
  const openLockedRef = useRef(openLocked);
  useIsomorphicLayoutEffect(() => {
    openLockedRef.current = openLocked;
  });

  /**
   * A press on node `id`: a click, a tap, or Enter / Space / a screen
   * reader's activation (`key`, never half of a double press). The first
   * locks it (moving the lock off any other). A second press on the locked
   * node opens it: at once from a key or when it has no graph to drill
   * into, else after the double-press window (DOUBLE_CLICK_MS for a mouse,
   * DOUBLE_PRESS_MS for a tap) unless another press comes first. A double
   * press (a double-click, or two taps within DOUBLE_PRESS_MS) follows its
   * drillHref, or, with none, opens it as a second press does.
   */
  function pressNode(
    id: string,
    press: { detail: number; touch: boolean; key: boolean }
  ) {
    const now = Date.now();
    const last = lastPress.current;
    const repeat =
      !press.key &&
      last !== null &&
      last.id === id &&
      (press.detail >= 2 || (press.touch && now - last.at <= DOUBLE_PRESS_MS));
    if (repeat) {
      // The first press opened it already, or this is a triple-click.
      if (last.did !== 'lock' && last.did !== 'wait') return;
      cancelPendingOpen();
      const href = drillOf(id);
      lastPress.current = {
        id,
        at: now,
        did: href === null ? 'open' : 'drill',
      };
      if (href !== null) follow(href);
      else openLocked(id);
      return;
    }
    if (lockedNodeId !== id) {
      changeLock(id);
      lastPress.current = { id, at: now, did: 'lock' };
      return;
    }
    cancelPendingOpen();
    if (!press.key && drillOf(id) !== null) {
      openTimer.current = setTimeout(
        () => {
          openTimer.current = null;
          if (lockRef.current === id) openLockedRef.current(id);
        },
        press.touch ? DOUBLE_PRESS_MS : DOUBLE_CLICK_MS
      );
      lastPress.current = { id, at: now, did: 'wait' };
      return;
    }
    lastPress.current = { id, at: now, did: 'open' };
    openLocked(id);
  }

  /** A click on a node (button, link or plain box): its press, unless it
      ends a pan or is openNode's own click through a link node. */
  function onNodeClick(event: ReactMouseEvent<HTMLElement>, id: string) {
    if (passThrough.current === id) {
      passThrough.current = null;
      return;
    }
    event.preventDefault();
    const touch = pendingTouch.current === id;
    pendingTouch.current = null;
    // A tap on a node that already had focus fires no focus event.
    touchFocus.current = null;
    if (panned.current) {
      panned.current = false;
      return;
    }
    pressNode(id, {
      detail: event.detail,
      touch,
      key: event.detail === 0 && !touch,
    });
  }

  // While a node is locked, a new selection from the host (a panel's
  // "Waits on" row, a drawer's link to another issue) moves the lock to
  // it, so the canvas keeps lighting what the panel shows.
  const changeLockRef = useRef(changeLock);
  useIsomorphicLayoutEffect(() => {
    changeLockRef.current = changeLock;
  });
  // Escape unlocks from anywhere on the page, not only from inside the
  // graph: a drag on the background, or a click beside the frame, leaves
  // focus on the page itself. Listened for on the window, after every
  // nearer handler (the graph's own, an open panel's or menu's on the
  // document), so a key one of them took, or one typed into a field,
  // drops nothing.
  const holdsLock = lockedNodeId !== null;
  useEffect(() => {
    if (!holdsLock) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.isComposing || isTyping(event.target)) return;
      event.preventDefault();
      changeLockRef.current(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [holdsLock]);

  const shownSelection = useRef(selectedId);
  useIsomorphicLayoutEffect(() => {
    const was = shownSelection.current;
    shownSelection.current = selectedId;
    if (selectedId === was || selectedId === null || !byId.has(selectedId)) {
      return;
    }
    if (lockRef.current === null || lockRef.current === selectedId) return;
    changeLockRef.current(selectedId);
  }, [selectedId, byId]);

  /** A click on a frame's title: a double press opens the frame's graph;
      a single one does nothing (it never unlocks: it may be half of one). */
  function onTitleClick(event: ReactMouseEvent<HTMLElement>, id: string) {
    const href = clusterDrill.get(id);
    if (href === undefined) return;
    if (panned.current) {
      panned.current = false;
      return;
    }
    const touch = titleTouch.current === id;
    titleTouch.current = null;
    const now = Date.now();
    const last = lastTitlePress.current;
    const repeat =
      event.detail >= 2 ||
      (touch &&
        last !== null &&
        last.id === id &&
        now - last.at <= DOUBLE_PRESS_MS);
    lastTitlePress.current = repeat ? null : { id, at: now };
    if (repeat) follow(href);
  }

  /** Drops the lock from the strip or the readout. From a key, focus goes
      to the box (the button goes away); a pointer leaves focus be. */
  function unlockFrom(event: ReactMouseEvent<HTMLElement>) {
    const id = lockedNodeId;
    changeLock(null);
    if (id !== null && event.detail === 0) focusNode(id, true);
  }

  // - + 0 zoom while focus is anywhere in the graph (never with ctrl/cmd,
  // which is the browser's own page zoom).
  function onFrameKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // A key press ends any touch gesture. Escape drops the walked step and
    // the lock (one Escape for the lock, so a host panel's own Escape
    // waits for the next), and with it any trace a focus left behind.
    pendingTouch.current = null;
    touchFocus.current = null;
    if (event.key === 'Escape') {
      setWalkId(null);
      if (lockedNodeId !== null) {
        const id = lockedNodeId;
        const inStrip =
          event.target instanceof Element &&
          event.target.closest('[data-graph-lock-strip]') !== null;
        event.preventDefault();
        changeLock(null);
        setFocusedId(null);
        if (inStrip) focusNode(id, true);
      }
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event.target)) return;
    if (
      (event.key === ']' || event.key === '[') &&
      highlight === 'critical' &&
      chainSteps.length > 0
    ) {
      event.preventDefault();
      const onBox =
        event.target instanceof Element &&
        event.target.closest('[data-graph-node]') !== null;
      walk(event.key === ']' ? 1 : -1, onBox);
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomAround(zoomRef.current * ZOOM_STEP);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomAround(zoomRef.current / ZOOM_STEP);
    } else if (event.key === '0') {
      event.preventDefault();
      fit();
    }
  }

  // Enter locks the node, and opens the locked one; Shift + Enter opens
  // its graph, or, on a node with none, does what a double-click does
  // there: locks it and opens it. Space does what Enter does (a button's
  // own Space click reaches onNodeClick as a key press). Arrows, Home and
  // End move.
  function onNodeKeyDown(
    event: ReactKeyboardEvent<HTMLElement>,
    node: LaidOutNode
  ) {
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === 'Enter' && plain) {
      event.preventDefault();
      if (event.shiftKey) {
        const href = drillOf(node.id);
        if (href !== null) {
          follow(href);
          return;
        }
        if (lockedNodeId !== node.id) changeLock(node.id);
        lastPress.current = { id: node.id, at: Date.now(), did: 'open' };
        openNode(node.id);
        return;
      }
      pressNode(node.id, { detail: 0, touch: false, key: true });
      return;
    }
    if (
      event.key === ' ' &&
      plain &&
      !(event.target instanceof HTMLButtonElement)
    ) {
      event.preventDefault();
      pressNode(node.id, { detail: 0, touch: false, key: true });
      return;
    }
    const next = neighbour(
      layout.nodes,
      node,
      event.key,
      horizontal,
      layout.clustered === true
    );
    if (next === null) return;
    event.preventDefault();
    focusNode(next.id);
  }

  // A tap or click on the background (not on a node, the lock's strip or
  // a frame title that drills, and not the end of a pan) drops the lock
  // and the walked step.
  function onViewportClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (panned.current) {
      panned.current = false;
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest(
        '[data-graph-node], [data-graph-lock-strip], [data-graph-drill]'
      ) !== null
    ) {
      return;
    }
    const viewport = viewportRef.current;
    if (viewport !== null && onScrollbar(viewport, event)) return;
    if (lockedNodeId !== null) changeLock(null);
    else if (walkId !== null) setWalkId(null);
  }

  // A node is the focusable element itself, or (for a link node) the
  // anchor inside its positioned wrapper. `keepScroll` when the frame was
  // already scrolled to it (a walked step), so focus moves nothing else.
  function focusNode(id: string, keepScroll = false) {
    const el = nodeRefs.current.get(id);
    if (el === undefined) return;
    const target = el.matches('a, button, [tabindex]')
      ? el
      : el.querySelector<HTMLElement>('a');
    target?.focus(keepScroll ? { preventScroll: true } : undefined);
  }

  // A table ignores width and overflow, so the visually-hidden wrapper is
  // a div. The drawing already carries the summary, so the caption names
  // the table rather than repeating it. Built once per edge list: a hover
  // re-renders the graph, and a row per edge would be diffed each time.
  const edgeTable = useMemo(
    () => (
      <div className="srOnly">
        <table>
          <caption>
            Every edge: each blocker and the node that waits on it
          </caption>
          <thead>
            <tr>
              <th scope="col">Blocker</th>
              <th scope="col">Waiting</th>
              <th scope="col">Edge</th>
              <th scope="col">Relations</th>
            </tr>
          </thead>
          <tbody>
            {layout.edges.map((edge) => (
              <tr key={edge.key}>
                <td>{byId.get(edge.from)?.label ?? edge.from}</td>
                <td>{byId.get(edge.to)?.label ?? edge.to}</td>
                <td>{EDGE_WORDS[edge.kind]}</td>
                <td>{edge.weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
    [layout.edges, byId]
  );

  // Gr8r's centred empty state: the Graph nav item's icon over the honest
  // copy, where the panel would be.
  if (nodes.length === 0) {
    return (
      <div className={cx(styles.emptyState, className)}>
        <EmptyState icon={<Network size={22} strokeWidth={1.8} />}>
          {emptyMessage}
        </EmptyState>
      </div>
    );
  }

  const percent = `${Math.round(zoom * 100)}%`;
  const frameStyle = {
    '--graph-h': `${layout.height}px`,
  } as CSSProperties;
  const linkNodes = nodes.some((n) => n.href !== undefined && n.href !== '');
  const drills =
    nodes.some((n) => n.drillHref !== undefined && n.drillHref !== '') ||
    clusterDrill.size > 0;
  const toolbarHint =
    hint !== undefined
      ? hint
      : [
          'Click to lock',
          drills ? 'Double-click to drill in' : null,
          'Drag to pan',
          'Ctrl + wheel to zoom',
        ]
          .filter((part) => part !== null)
          .join(' · ');

  // The locked box's actions, on its strip and again in the readout:
  // Open (onSelect, else its link), Open graph (its drillHref), Unlock.
  const lockedNode = lockedNodeId === null ? undefined : byId.get(lockedNodeId);
  const lockedBox =
    lockedNodeId === null
      ? undefined
      : layout.nodes.find((n) => n.id === lockedNodeId);
  const lockedName =
    lockedNode === undefined
      ? ''
      : `${words.locked} ${pathNodeName(lockedNode)}`;
  const lockActions = (where: 'strip' | 'readout'): ReactNode => {
    if (lockedNode === undefined) return null;
    const id = lockedNode.id;
    const action = cx(
      where === 'strip' ? styles.lockButton : styles.readoutAction
    );
    const primary = cx(action, styles.actionOpen);
    const drill = drillOf(id);
    const href = lockedNode.href;
    const open =
      onSelect !== undefined ? (
        <button
          type="button"
          className={primary}
          onClick={() => openNode(id)}
          data-lock-action="open"
        >
          {words.open}
        </button>
      ) : href !== undefined && href !== '' ? (
        <Link href={href} className={primary} data-lock-action="open">
          {words.open}
        </Link>
      ) : null;
    return (
      <>
        {open}
        {open !== null && where === 'readout' ? ' ' : null}
        {drill !== null ? (
          <Link
            href={drill}
            className={action}
            data-lock-action="graph"
            title={
              where === 'strip'
                ? `${words.openItsGraph} (Shift + Enter)`
                : undefined
            }
          >
            {where === 'strip' ? words.openGraph : words.openItsGraph}
          </Link>
        ) : null}
        {drill !== null && where === 'readout' ? ' ' : null}
        <button
          type="button"
          className={cx(action, where === 'strip' && styles.lockClose)}
          onClick={unlockFrom}
          aria-label={where === 'strip' ? words.unlock : undefined}
          title={`${words.unlock} (Esc)`}
          data-lock-action="unlock"
        >
          {where === 'strip' ? (
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            words.unlock
          )}
        </button>
      </>
    );
  };
  // The strip may sit beside the locked box only on a side none of its
  // own arrows use (left to right: blockers come in on the left, what it
  // holds up leaves on the right), so it never hides the start of a path.
  const beside = {
    left: !horizontal || !layout.edges.some((edge) => edge.to === lockedNodeId),
    right:
      !horizontal || !layout.edges.some((edge) => edge.from === lockedNodeId),
  };
  const lockStrip =
    lockedBox === undefined ? null : (
      <LockStrip
        box={lockedBox}
        zoom={zoom}
        reserveRef={reserveRef}
        steps={highlight === 'critical' && chainSteps.length > 0}
        beside={beside}
        label={lockedName}
      >
        {lockActions('strip')}
      </LockStrip>
    );
  const lockedHere = lockedNodeId !== null && subjectId === lockedNodeId;

  // Critical path: the step control over the canvas's bottom-left corner,
  // to walk the path shown at rest from step to step ([ and ] do the
  // same). A big graph spreads its path over the whole canvas, where Fit
  // cannot show it and no step may be in view.
  const stepCount = chainSteps.length;
  const stepControl =
    highlight === 'critical' && stepCount > 0 ? (
      <div className={styles.stepsAnchor}>
        <div
          className={styles.steps}
          role="group"
          aria-label="Critical path steps"
          data-graph-steps=""
        >
          <button
            type="button"
            className={styles.zoomButton}
            onClick={() => walk(-1, false)}
            disabled={walkStep === null || walkStep <= 1}
            aria-label="Previous step"
            aria-keyshortcuts="["
            title="Previous step ([)"
          >
            <ChevronLeft size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <output className={styles.zoomValue} aria-live="polite">
            {walkStep === null
              ? `${stepCount} steps`
              : `Step ${walkStep} of ${stepCount}`}
          </output>
          <button
            type="button"
            className={styles.zoomButton}
            onClick={() => walk(1, false)}
            disabled={walkStep !== null && walkStep >= stepCount}
            aria-label={walkStep === null ? 'Go to step 1' : 'Next step'}
            aria-keyshortcuts="]"
            title={walkStep === null ? 'Go to step 1 (])' : 'Next step (])'}
          >
            <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </div>
    ) : null;

  /**
   * A frame: a cluster's soft rounded outline (dashed grey when muted,
   * dashed when external; its title is drawn above the arrows by
   * renderClusterTitle), or a group outline with its title on the edge.
   * Decorative: each node's name says which frames it sits in.
   */
  const renderGroup = (group: LaidOutGroup): ReactNode => {
    const position = {
      left: group.x,
      top: group.y,
      width: group.width,
      height: group.height,
    };
    if (group.kind !== 'cluster') {
      return (
        <div
          key={group.id}
          className={styles.group}
          style={position}
          aria-hidden="true"
        >
          <span className={styles.groupTitle} data-graph-words="">
            {group.label}
          </span>
        </div>
      );
    }
    return (
      <div
        key={group.id}
        className={cx(
          styles.cluster,
          group.muted === true && styles.clusterMuted,
          group.external === true && styles.clusterExternal
        )}
        style={position}
        aria-hidden="true"
        data-graph-cluster={group.id}
        data-depth={group.depth}
        data-muted={group.muted === true ? '' : undefined}
        data-external={group.external === true ? '' : undefined}
      />
    );
  };

  /**
   * A cluster's sentence-case title inside its frame's top-left corner, on
   * a patch of the canvas drawn above the arrows, so an arrow running into
   * a box near the top of a frame passes behind the title instead of
   * through its letters. Decorative, like the frame (its graph is reached
   * from the keyboard through its box, one level up); a double-click on
   * the title of a frame with a drillHref opens that graph.
   */
  const renderClusterTitle = (group: LaidOutGroup): ReactNode => {
    if (group.kind !== 'cluster') return null;
    const drill = clusterDrill.has(group.id);
    return (
      <span
        key={group.id}
        className={cx(
          styles.clusterTitle,
          group.depth === 0 && styles.clusterTitleTop,
          group.muted === true && styles.clusterTitleMuted,
          drill && styles.clusterTitleDrill
        )}
        style={{
          left: group.x + CLUSTER_METRICS.titleX,
          top: group.y + CLUSTER_METRICS.titleTop,
          maxWidth: Math.max(0, group.width - CLUSTER_METRICS.titleX * 2),
        }}
        aria-hidden="true"
        data-graph-cluster-title={group.id}
        data-graph-drill={drill ? '' : undefined}
        title={
          drill
            ? `${group.label} · double-click to open its graph`
            : group.label
        }
        onPointerDown={
          drill
            ? (event) => {
                titleTouch.current =
                  event.pointerType === 'touch' ? group.id : null;
              }
            : undefined
        }
        onMouseDown={
          drill
            ? (event) => {
                // A double-click selects no text.
                if (event.detail > 1) event.preventDefault();
              }
            : undefined
        }
        onClick={drill ? (event) => onTitleClick(event, group.id) : undefined}
      >
        {group.label}
      </span>
    );
  };

  /** One edge's drawing; the overlay copy carries no data hooks. */
  const renderEdge = (
    edge: LaidOutEdge,
    state: HighlightState | undefined,
    overlay: boolean
  ): ReactNode => (
    <g
      key={edge.key}
      className={cx(
        styles.edge,
        EDGE_CLASS[edge.kind],
        state === undefined ? undefined : STATE_CLASS[state]
      )}
      data-edge={overlay ? undefined : edge.key}
      data-kind={overlay ? undefined : edge.kind}
      data-state={overlay ? undefined : state}
      data-cross={crossKeys.has(edge.key) ? '' : undefined}
    >
      <path className={styles.edgeLine} d={edge.path} />
      <path className={styles.edgeArrow} d={edge.arrow} />
      {edge.label !== null ? (
        <g className={styles.weight}>
          <rect
            x={edge.label.x + 0.5}
            y={edge.label.y + 0.5}
            width={edge.label.width - 1}
            height={edge.label.height - 1}
            rx={4}
          />
          <text
            x={edge.label.x + edge.label.width / 2}
            y={edge.label.y + edge.label.height / 2}
            dominantBaseline="central"
            textAnchor="middle"
          >
            {edge.weight}
          </text>
        </g>
      ) : null}
    </g>
  );
  // Lit, down and critical edges are drawn a second time above the rest,
  // so a path line never runs under a receding one where they cross.
  const overlayEdges = showing
    ? OVERLAY_ORDER.flatMap((state) =>
        layout.edges
          .filter((edge) => edgeState(edge.key) === state)
          .map((edge) => renderEdge(edge, state, true))
      )
    : [];

  return (
    <div
      className={cx(styles.graph, className)}
      data-highlight={highlight}
      data-locked={lockedNodeId === null ? undefined : ''}
      onKeyDown={onFrameKeyDown}
    >
      <div className={styles.toolbar}>
        {toolbar !== undefined && toolbar !== null ? (
          <div className={styles.toolbarStart}>{toolbar}</div>
        ) : null}
        {toolbarHint !== null && toolbarHint !== '' ? (
          <span className={styles.hint}>{toolbarHint}</span>
        ) : null}
        <div className={styles.zoom} role="group" aria-label="Zoom">
          <button
            type="button"
            className={styles.zoomButton}
            onClick={() => zoomAround(zoom / ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            aria-keyshortcuts="-"
            title="Zoom out (-)"
          >
            <Minus size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <output className={styles.zoomValue} aria-live="polite">
            <span className="srOnly">Zoom </span>
            {percent}
          </output>
          <button
            type="button"
            className={styles.zoomButton}
            onClick={() => zoomAround(zoom * ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            aria-keyshortcuts="+"
            title="Zoom in (+)"
          >
            <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={cx(styles.zoomButton, styles.fitButton)}
            onClick={fit}
            aria-label="Fit the graph to the frame"
            aria-keyshortcuts="0"
            title="Fit (0)"
          >
            <Maximize size={14} strokeWidth={1.8} aria-hidden="true" />
            <span aria-hidden="true">Fit</span>
          </button>
        </div>
      </div>

      {/* The pan surface: role presentation says it carries no meaning
          of its own (a click on the background only drops the lock, which
          Escape does from the keyboard). */}
      <div
        ref={viewportRef}
        role="presentation"
        className={styles.viewport}
        data-graph-viewport=""
        style={frameStyle}
        data-panning={panning ? '' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onClick={onViewportClick}
      >
        <div
          ref={canvasRef}
          className={styles.canvas}
          style={{ width: layout.width * zoom, height: layout.height * zoom }}
        >
          <div
            className={styles.stage}
            style={{
              width: layout.width,
              height: layout.height,
              transform: zoom === 1 ? undefined : `scale(${zoom})`,
            }}
          >
            {layout.groups.map((group) => renderGroup(group))}

            <svg
              className={styles.edges}
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              role="img"
              aria-label={ariaSummary}
            >
              {layout.edges.map((edge) =>
                renderEdge(edge, edgeState(edge.key), false)
              )}
              {overlayEdges.length > 0 ? (
                <g aria-hidden="true" data-overlay="">
                  {overlayEdges}
                </g>
              ) : null}
            </svg>

            {layout.groups.map((group) => renderClusterTitle(group))}

            {layout.nodes.map((box) => {
              const node = byId.get(box.id);
              if (node === undefined) return null;
              const tags = node.tags ?? [];
              // The red tint of an overdue box is Risk's; elsewhere the
              // Overdue chip carries the red on its own.
              const flood = tags.includes('Overdue') && highlight === 'risk';
              const inCycle = tags.includes('Cycle');
              const selected = box.id === selectedId;
              const focus = box.id === focusId;
              const state = nodeState(box.id);
              const readiness = node.readiness;
              const drawnTone = shownTone(node, highlight);
              // A status tone (or a host's accent) draws the 1.5px edge in
              // its hue through the data-tone hook (tokens.css); a ready
              // node under Status only a 1px edge in the green; muted
              // keeps its own quiet look.
              const tone =
                drawnTone === 'default' || drawnTone === 'muted'
                  ? undefined
                  : drawnTone;
              const edgeOnly =
                highlight === 'status' &&
                readiness !== undefined &&
                tone === 'success';
              const step = shownChain?.steps.get(box.id);
              const next = nextIds.has(box.id);
              const pointed = box.id === pointedId;
              const locked = box.id === lockedNodeId;
              const classes = cx(
                styles.node,
                tone !== undefined &&
                  (edgeOnly ? styles.toneEdge : styles.toned),
                drawnTone === 'muted' && styles.toneMuted,
                node.external === true && styles.external,
                flood && styles.overdueNode,
                inCycle && styles.cycle,
                selected && styles.selected,
                focus && styles.focus,
                state === undefined ? undefined : STATE_CLASS[state],
                pointed && styles.pointed,
                locked && styles.locked
              );
              // The readiness chip leads the chips in every highlight (the
              // layout never moves); only Status tones it (its slot carries
              // the tone as data-tone too). A node with no dependencies
              // gets none: its name and the readout say it.
              const chipWord =
                readiness?.state === 'independent'
                  ? ''
                  : (readiness?.label ?? '');
              const chipTone =
                highlight === 'status' &&
                readiness !== undefined &&
                readiness.tone !== 'default'
                  ? readiness.tone
                  : undefined;
              const chipLook = readinessChip(chipTone);
              const position: CSSProperties = {
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
              };
              // An issue's key leads its sublabel ("ENG-12 · Ana"): drawn in
              // Geist Mono, the one mono voice; the line's text is unchanged.
              const keyed =
                node.key !== undefined &&
                node.key !== '' &&
                box.sublabelLine.startsWith(`${node.key} `);
              const nameStep = nameChain?.steps.get(box.id);
              const name = nodeName(
                node,
                nameCounts.get(box.id),
                nameChain !== null && nameStep !== undefined
                  ? { k: nameStep, s: nameChain.stepCount }
                  : null,
                focus ? focusLabel : null,
                framesOf.get(box.id)
              );
              const body = (
                <>
                  {node.status !== undefined ? (
                    <span
                      className={cx(styles.glyph, styles[node.status])}
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className={styles.text} data-graph-words="">
                    <span className={styles.label}>
                      {box.labelLines.map((line, i) => (
                        <span key={i} className={styles.line}>
                          {line}
                        </span>
                      ))}
                    </span>
                    {box.sublabelLine !== '' ? (
                      <span className={styles.sublabel}>
                        {keyed ? (
                          <>
                            <span className={styles.key}>{node.key}</span>
                            {box.sublabelLine.slice(node.key?.length ?? 0)}
                          </>
                        ) : (
                          box.sublabelLine
                        )}
                      </span>
                    ) : null}
                    {chipWord !== '' || tags.length > 0 ? (
                      <span className={styles.tags}>
                        {chipWord !== '' ? (
                          <span
                            className={styles.chipSlot}
                            data-tone={chipTone}
                            data-readiness-chip=""
                          >
                            <Chip tone={chipLook.tone} filled={chipLook.filled}>
                              {chipWord}
                            </Chip>
                          </span>
                        ) : null}
                        {tags.map((tag) => {
                          const look = TAG_CHIP[tag] ?? NEUTRAL_CHIP;
                          return (
                            <Chip
                              key={tag}
                              tone={look.tone}
                              filled={look.filled}
                            >
                              {tag}
                            </Chip>
                          );
                        })}
                      </span>
                    ) : null}
                  </span>
                  {next ? (
                    <span
                      className={styles.next}
                      aria-hidden="true"
                      data-next-pill=""
                    >
                      {words.next}
                    </span>
                  ) : null}
                  {step !== undefined ? (
                    <span
                      className={styles.step}
                      aria-hidden="true"
                      data-step-badge=""
                    >
                      {step}
                    </span>
                  ) : null}
                  {locked ? (
                    <span
                      className={styles.lockMark}
                      aria-hidden="true"
                      data-lock-mark=""
                    />
                  ) : null}
                </>
              );
              const handlers = {
                'data-graph-node': box.id,
                'data-state': state,
                'data-pointed': pointed ? '' : undefined,
                'data-locked': locked ? '' : undefined,
                'data-focus': focus ? '' : undefined,
                'data-readiness': readiness?.state,
                'data-next': next ? '' : undefined,
                'data-step': step,
                ref: (el: HTMLElement | null) => {
                  if (el === null) nodeRefs.current.delete(box.id);
                  else nodeRefs.current.set(box.id, el);
                },
                onFocus: () => {
                  setRovingId(box.id);
                  // The focus a touch press gave it: the lock traces it.
                  if (touchFocus.current === box.id) {
                    touchFocus.current = null;
                    return;
                  }
                  setFocusedId(box.id);
                },
                onBlur: () =>
                  setFocusedId((current) =>
                    current === box.id ? null : current
                  ),
                onPointerEnter: (event: ReactPointerEvent) => {
                  if (event.pointerType === 'touch') return;
                  hoverRef.current = box.id;
                  // While locked, pointing re-renders nothing (CSS draws
                  // the faint hover outline).
                  if (lockedNodeId === null) setHoverId(box.id);
                },
                onPointerLeave: () => {
                  if (hoverRef.current === box.id) hoverRef.current = null;
                  setHoverId((current) =>
                    current === box.id ? null : current
                  );
                },
                onPointerDown: (event: ReactPointerEvent) => {
                  const touch = event.pointerType === 'touch';
                  pendingTouch.current = touch ? box.id : null;
                  touchFocus.current = touch ? box.id : null;
                },
                onPointerCancel: () => {
                  pendingTouch.current = null;
                  touchFocus.current = null;
                },
                // A double-click selects no text, and a pan that starts on
                // a link node drags no link.
                onMouseDown: (event: ReactMouseEvent) => {
                  if (event.detail > 1) event.preventDefault();
                },
                onDragStart: (event: ReactMouseEvent) => event.preventDefault(),
              };
              // Beside the pointer handlers on every node shape, so each
              // element shows its own keyboard path.
              const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) =>
                onNodeKeyDown(event, box);
              if (onSelect !== undefined) {
                return (
                  <button
                    key={box.id}
                    type="button"
                    className={classes}
                    data-tone={tone}
                    style={position}
                    tabIndex={box.id === tabStop ? 0 : -1}
                    aria-pressed={locked}
                    aria-label={name}
                    aria-describedby={helpId}
                    title={node.label}
                    onClick={(event) => onNodeClick(event, box.id)}
                    onKeyDown={onKeyDown}
                    {...handlers}
                  >
                    {body}
                  </button>
                );
              }
              if (node.href !== undefined && node.href !== '') {
                return (
                  <span
                    key={box.id}
                    className={styles.linkWrap}
                    style={position}
                    onKeyDown={onKeyDown}
                    {...handlers}
                  >
                    <Link
                      href={node.href}
                      className={classes}
                      data-tone={tone}
                      aria-label={name}
                      title={node.label}
                      onClick={(event) => onNodeClick(event, box.id)}
                    >
                      {body}
                    </Link>
                  </span>
                );
              }
              return (
                <div
                  key={box.id}
                  className={classes}
                  data-tone={tone}
                  style={position}
                  tabIndex={box.id === tabStop ? 0 : -1}
                  role="group"
                  aria-label={name}
                  aria-current={locked ? 'true' : undefined}
                  aria-describedby={helpId}
                  title={node.label}
                  onClick={(event) => onNodeClick(event, box.id)}
                  onKeyDown={onKeyDown}
                  {...handlers}
                >
                  {body}
                </div>
              );
            })}
          </div>
          {lockStrip}
        </div>
      </div>
      {stepControl}

      {/* What the reader is tracing, in words: the lit node's paths, else
          the host's summary for this highlight and how to trace a node.
          While a box is locked it leads with "Locked on" and the box's
          actions. Plain text, not a live region: it would chatter on
          hover (the lock is announced once, below). */}
      {readout !== null ? (
        <p
          className={styles.readout}
          data-graph-readout=""
          data-locked={lockedHere ? '' : undefined}
        >
          {readoutLine !== null ? (
            <>
              {lockedHere ? (
                <>
                  <span className={styles.readoutLocked}>
                    {words.locked}
                  </span>{' '}
                </>
              ) : null}
              <span className={styles.readoutSubject}>
                {readoutLine.subject}
              </span>
              {lockedHere ? (
                <>
                  {' '}
                  <span className={styles.readoutActions}>
                    {lockActions('readout')}
                  </span>
                </>
              ) : null}
              {readoutLine.parts.map((part, i) => (
                <Fragment key={i}>
                  {lockedHere && i === 0 ? (
                    // A rule, not a " · ", between the lock's buttons and
                    // the facts, so "Unlock" never reads as the first fact.
                    <span className={styles.readoutBreak} aria-hidden="true">
                      {' '}
                    </span>
                  ) : (
                    <span className={styles.readoutSep}> · </span>
                  )}
                  <span>{part}</span>
                </Fragment>
              ))}
            </>
          ) : (
            <>
              {readout !== undefined && readout !== '' ? (
                <>
                  <span className={styles.readoutIdle}>{readout}</span>{' '}
                </>
              ) : null}
              <span className={styles.readoutHint}>
                <span className={styles.hintHover}>
                  {highlight === 'critical' ? words.hintCritical : words.hint}
                </span>
                <span className={styles.hintTap}>
                  {highlight === 'critical'
                    ? words.tapHintCritical
                    : words.tapHint}
                </span>
              </span>
            </>
          )}
        </p>
      ) : null}

      {/* Key help every node points at (aria-describedby). */}
      <p id={helpId} className="srOnly">
        {keyHelp(onSelect !== undefined || linkNodes, drills, stepCount > 0)}
      </p>
      {/* The lock, said once when it changes (not on hover or focus). */}
      <p className="srOnly" role="status" data-graph-lock-status="">
        {announced}
      </p>

      {edgeTable}
    </div>
  );
}
