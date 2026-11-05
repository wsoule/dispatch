import { layout as dagreLayout, graphlib } from '@dagrejs/dagre';

import { gridColumns, packGrid, packShelves, shelfWidth } from './pack';
import type {
  GraphClusterData,
  GraphDirection,
  GraphEdgeData,
  GraphEdgeKind,
  GraphLayout,
  GraphLayoutOptions,
  GraphNodeData,
  LaidOutEdge,
  LaidOutGroup,
  LaidOutNode,
} from './types';

// Pure layout for the dependency graph: node boxes sized from Geist text
// metrics (a per-character width table, below), positions and edge routes
// from dagre (rankdir LR by default), or, given clusters, nested labelled
// frames whose linked items flow by dagre and whose unlinked boxes pack
// into grids (layoutClustered). No DOM, no React, no randomness: the same
// input gives the same output on the server and the client, so the SVG
// hydrates without a diff.

/**
 * Box metrics shared with dependency-graph.module.css (Gr8r's card: 10px
 * by 12px padding, a 13.5px medium title on 18px lines, a 12px quiet line,
 * Chip atoms under it). Text widths come from GEIST_500 below. Change a
 * size here and in the CSS together.
 */
export const GRAPH_METRICS = {
  /** The node's 1px border, counted inside its box. */
  border: 1,
  padX: 12,
  padY: 10,
  /** The status diamond's 12px slot and the gap after it. */
  glyph: 12,
  glyphGap: 8,
  /** Label: --fs (13.5px) Geist 500 on 18px lines. */
  labelSize: 13.5,
  labelLine: 18,
  /** Sublabel: --fs-xs (12px) Geist on a 16px line, 2px under the label
      (an issue key in it is drawn in Geist Mono, which runs narrower). */
  subSize: 12,
  subLine: 16,
  subGap: 2,
  /** Chips: the Chip atom (12px Geist 500, 7px padding, a 1px border,
      20px tall), 4px apart, 8px under the text. */
  tagSize: 12,
  tagPadX: 7,
  tagHeight: 20,
  tagGap: 4,
  tagsGap: 8,
  /** The 6px dot leading a dot pill (a status chip that is not filled:
      Ready, Clear, Overdue, No lead) and the gap after it. */
  readyDot: 6,
  readyDotGap: 5,
  minWidth: 176,
  maxWidth: 264,
  /** Weight pill: 11px Geist 500 tabular figures (0.62em each). */
  weightAdvance: 11 * 0.62,
  weightPadX: 5,
  weightHeight: 16,
} as const;

/**
 * Geist's advance widths at weight 500, in thousandths of an em, for the
 * printable ASCII characters (space to tilde), measured in the browser with
 * the body's `ss01` / `cv11` features. Weight 400 runs about 2% narrower,
 * so the same table sizes the 400 sublabel safely.
 */
const GEIST_500: readonly number[] = [
  243, 228, 361, 515, 643, 810, 649, 186, 290, 290, 427, 562, 213, 418, 213,
  391, 683, 368, 630, 625, 629, 641, 604, 550, 624, 606, 302, 302, 546, 544,
  546, 570, 925, 689, 680, 713, 711, 602, 578, 713, 699, 263, 582, 638, 556,
  873, 728, 751, 638, 745, 680, 654, 578, 696, 679, 959, 633, 613, 561, 361,
  367, 361, 438, 558, 258, 564, 599, 554, 599, 567, 337, 598, 585, 239, 269,
  562, 273, 868, 574, 579, 599, 599, 360, 528, 350, 586, 560, 829, 567, 553,
  535, 395, 274, 395, 523,
];

/** A few common characters outside ASCII, same units. */
const GEIST_500_EXTRA: Readonly<Record<string, number>> = {
  '…': 612,
  '·': 213,
  '‘': 218,
  '’': 218,
  '“': 399,
  '”': 399,
  '—': 908,
  '–': 592,
  '›': 348,
  '→': 954,
};

/** Anything else (accented letters, other scripts): a wide-ish guess. */
const FALLBACK_ADVANCE = 640;

/** Headroom for rounding and the fallback face before Geist loads. */
const WIDTH_SAFETY = 1.04;

/** Semibold (600, the frame titles) runs about 3% wider than the table. */
const SEMIBOLD = 1.03;

/**
 * The rendered width in px of `text` set in Geist at `size` px: the sum of
 * each character's advance (no kerning), with a little headroom. Exact
 * enough to wrap and clip labels on the server; CSS still ellipsizes a
 * line that comes out wider.
 */
export function textWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    units +=
      code >= 32 && code < 127
        ? (GEIST_500[code - 32] ?? FALLBACK_ADVANCE)
        : (GEIST_500_EXTRA[ch] ?? FALLBACK_ADVANCE);
  }
  return (units * size * WIDTH_SAFETY) / 1000;
}

const M = GRAPH_METRICS;

/**
 * Cluster frame metrics shared with dependency-graph.module.css (.cluster,
 * .clusterTitle): the title is sentence-case Geist at --fs-xs (12px), 600,
 * on a 16px line, `titleTop` below the frame's top edge and `titleX` in
 * from its left; the frame's content starts `padTop` down and `padX` in.
 * The gaps space a frame's flow, grid and shelves, and the grid's cells.
 */
export const CLUSTER_METRICS = {
  padX: 12,
  padTop: 32,
  padBottom: 12,
  titleTop: 8,
  titleX: 10,
  titleSize: 12,
  titleLine: 16,
  /** Title characters a frame widens for (a longer title is cut). */
  titleMaxChars: 40,
  /** Between a frame's flow, grid and shelves, and between shelved frames. */
  gap: 20,
  gridGapX: 16,
  gridGapY: 12,
  /** A grid of unlinked boxes aims at this width-to-height ratio. */
  gridAspect: 3,
  /** Shelves of unlinked frames aim at this width-to-height ratio. */
  shelfAspect: 1.8,
  /** How far an arrow between frames leaves and enters a box straight. */
  lead: 28,
  /**
   * The least empty band above a flow's first rank that liftOpening
   * closes: about a box's height. A thinner one is left, since moving
   * ranks bends the arrows between them and can put one behind a box.
   */
  liftMin: 64,
  /**
   * A flow holding frames may run this long along the direction, or
   * flowSpread times the width its frames would take on shelves, before
   * its frames go onto shelves instead (layoutFrame).
   */
  flowMax: 2400,
  flowSpread: 1.25,
  /**
   * A flow over more items or links than these ranks with dagre's
   * tight-tree instead of network-simplex: network-simplex costs grow
   * fastest with a large, dense flow (one big milestone: about 5 s for
   * 500 boxes and 800 arrows, against 0.5 s), and below these sizes it
   * keeps its tighter ranks.
   */
  simplexItems: 120,
  simplexLinks: 180,
} as const;

const C = CLUSTER_METRICS;
const MARGIN = 24;
const MAX_LABEL_LINES = 2;
const ELLIPSIS = '…';
const GROUP_PREFIX = '__group__:';
const ARROW_LENGTH = 6;
const ARROW_HALF_WIDTH = 3;

// Paint order: faint lines underneath, the status hues (amber risk, red
// cycle) on top so a risk chain is never hidden under an ordinary edge
// where they cross.
const KIND_ORDER: Record<GraphEdgeKind, number> = {
  resolved: 0,
  default: 1,
  cross: 2,
  risk: 3,
  cycle: 4,
};

export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

/** Cuts `text` to `max` characters, ending in an ellipsis when cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return ELLIPSIS;
  return `${text.slice(0, max - 1).trimEnd()}${ELLIPSIS}`;
}

/**
 * Cuts `text` to fit `maxWidth` px in Geist at `size`, ending in an
 * ellipsis when cut (the longest prefix that still fits with it).
 */
export function clipText(text: string, maxWidth: number, size: number): string {
  if (textWidth(text, size) <= maxWidth) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  // Binary search on the prefix length: the width grows with it.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join('').trimEnd()}${ELLIPSIS}`;
    if (textWidth(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0
    ? ELLIPSIS
    : `${chars.slice(0, lo).join('').trimEnd()}${ELLIPSIS}`;
}

/** The longest prefix of `word` (at least one character) that fits. */
function fittingPrefix(word: string, maxWidth: number, size: number): string {
  const chars = Array.from(word);
  let n = 1;
  while (
    n < chars.length &&
    textWidth(chars.slice(0, n + 1).join(''), size) <= maxWidth
  ) {
    n += 1;
  }
  return chars.slice(0, n).join('');
}

/**
 * Greedy word wrap by character count (exact for a mono face): at most
 * `maxLines` lines of `maxChars`; a word longer than a line is broken, and
 * whatever does not fit ends the last line with an ellipsis. The boxes
 * wrap by measured Geist width instead (wrapText); this stays for hosts
 * that draw in a mono face.
 */
export function wrapMono(
  text: string,
  maxChars: number,
  maxLines: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    const word = words[index];
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      index += 1;
    } else if (current === '') {
      // A single word wider than the line: hard-break it.
      lines.push(word.slice(0, maxChars));
      words[index] = word.slice(maxChars);
    } else {
      lines.push(current);
      current = '';
    }
  }
  if (current !== '' && lines.length < maxLines) {
    lines.push(current);
  }
  if (index < words.length || (lines.length === maxLines && current !== '')) {
    // Text remains: the last line carries the ellipsis.
    const rest = [lines[lines.length - 1] ?? '', ...words.slice(index)]
      .join(' ')
      .trim();
    lines[lines.length - 1] = clip(rest, maxChars);
  }
  return lines.length > 0 ? lines : [''];
}

/**
 * Greedy word wrap by measured Geist width: at most `maxLines` lines no
 * wider than `maxWidth` px at `size`; a word wider than a line is broken,
 * and whatever does not fit ends the last line with an ellipsis.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  maxLines: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    const word = words[index];
    const candidate = current === '' ? word : `${current} ${word}`;
    if (textWidth(candidate, size) <= maxWidth) {
      current = candidate;
      index += 1;
    } else if (current === '') {
      // A single word wider than the line: hard-break it.
      const head = fittingPrefix(word, maxWidth, size);
      lines.push(head);
      words[index] = word.slice(head.length);
    } else {
      lines.push(current);
      current = '';
    }
  }
  if (current !== '' && lines.length < maxLines) {
    lines.push(current);
  }
  if (index < words.length || (lines.length === maxLines && current !== '')) {
    // Text remains: the last line carries the ellipsis.
    const rest = [lines[lines.length - 1] ?? '', ...words.slice(index)]
      .join(' ')
      .trim();
    lines[lines.length - 1] = clipText(rest, maxWidth, size);
  }
  return lines.length > 0 ? lines : [''];
}

/**
 * A frame title's drawn width in px: sentence-case Geist at the title
 * size, semibold, cut at `titleMaxChars` characters (a longer title is
 * ellipsized by the CSS inside the frame).
 */
export function clusterTitleWidth(label: string): number {
  return textWidth(clip(label, C.titleMaxChars), C.titleSize) * SEMIBOLD;
}

/**
 * The tag words drawn as a dot pill (a status Chip that is not filled), so
 * their chip leads with a 6px dot: see DependencyGraph's tagChip. Any
 * other tag is a badge (tinted, neutral or plain) with no dot.
 */
const DOT_TAGS: ReadonlySet<string> = new Set(['Overdue', 'No lead']);

/** Width of one Chip (border included), plus its dot when it has one. */
function tagWidth(tag: string, dot = false): number {
  return Math.ceil(
    textWidth(tag, M.tagSize) +
      M.tagPadX * 2 +
      2 +
      (dot ? M.readyDot + M.readyDotGap : 0)
  );
}

/**
 * The widths of a node's chips in drawing order: the readiness chip first
 * (when it has a word and is not independent, whose word is said but not
 * drawn), then its tags. The chip is drawn under every highlight, a dot
 * pill under Status when it is ready (success) or informs (info), so its
 * dot's room is always kept and one layout fits all.
 */
function chipWidths(node: GraphNodeData): number[] {
  const widths: number[] = [];
  const readiness = node.readiness;
  if (
    readiness !== undefined &&
    readiness.label !== '' &&
    readiness.state !== 'independent'
  ) {
    const dot = readiness.tone === 'success' || readiness.tone === 'info';
    widths.push(tagWidth(readiness.label, dot));
  }
  for (const tag of node.tags ?? []) {
    widths.push(tagWidth(tag, DOT_TAGS.has(tag)));
  }
  return widths;
}

/** Rows a flowed set of chips (their widths) needs inside `width`. */
function tagRows(widths: readonly number[], width: number): number {
  if (widths.length === 0) return 0;
  let rows = 1;
  let used = 0;
  for (const width0 of widths) {
    const w = Math.min(width0, width);
    const next = used === 0 ? w : used + M.tagGap + w;
    if (next > width && used > 0) {
      rows += 1;
      used = w;
    } else {
      used = next;
    }
  }
  return rows;
}

export interface NodeMeasure {
  width: number;
  height: number;
  labelLines: string[];
  sublabelLine: string;
}

/**
 * The box a node needs: wide enough for its label on one line (clamped to
 * the min/max width), the label wrapped to two lines beyond that, one line
 * of sublabel, and the chips (readiness, then tags) flowed under it. The
 * highlight never enters: every mode draws the same chips.
 */
export function measureNode(node: GraphNodeData): NodeMeasure {
  const lead = node.status !== undefined ? M.glyph + M.glyphGap : 0;
  const chrome = (M.padX + M.border) * 2 + lead;
  const chips = chipWidths(node);
  const sublabel = node.sublabel ?? '';
  let tagsRow = 0;
  for (const w of chips) {
    tagsRow += (tagsRow === 0 ? 0 : M.tagGap) + w;
  }
  const natural = Math.max(
    textWidth(node.label, M.labelSize),
    textWidth(sublabel, M.subSize),
    tagsRow
  );
  const width = Math.ceil(
    Math.min(M.maxWidth, Math.max(M.minWidth, natural + chrome))
  );
  const inner = width - chrome;
  const labelLines = wrapText(node.label, inner, M.labelSize, MAX_LABEL_LINES);
  const sublabelLine =
    sublabel === '' ? '' : clipText(sublabel, inner, M.subSize);
  const rows = tagRows(chips, inner);
  const height =
    (M.padY + M.border) * 2 +
    labelLines.length * M.labelLine +
    (sublabel === '' ? 0 : M.subGap + M.subLine) +
    (rows === 0 ? 0 : M.tagsGap + rows * M.tagHeight + (rows - 1) * M.tagGap);
  return { width, height: Math.ceil(height), labelLines, sublabelLine };
}

type Point = { x: number; y: number };

/** Rounds to a tenth of a pixel so output is stable and compact. */
function r(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * SVG path for a uniform cubic B-spline through `points` (d3's curveBasis,
 * the curve dagre's routes are meant for): passes through both ends,
 * smooths the corners between, and leaves tangent to the last segment, so
 * the arrowhead lines up with it.
 */
export function basisPath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  const [first] = points;
  if (points.length === 1) return `M${r(first.x)},${r(first.y)}`;
  if (points.length === 2) {
    const [, last] = points;
    return `M${r(first.x)},${r(first.y)}L${r(last.x)},${r(last.y)}`;
  }
  let d = `M${r(first.x)},${r(first.y)}`;
  const curve = (a: Point, b: Point, c: Point) => {
    d +=
      `C${r((2 * a.x + b.x) / 3)},${r((2 * a.y + b.y) / 3)}` +
      ` ${r((a.x + 2 * b.x) / 3)},${r((a.y + 2 * b.y) / 3)}` +
      ` ${r((a.x + 4 * b.x + c.x) / 6)},${r((a.y + 4 * b.y + c.y) / 6)}`;
  };
  const [, second] = points;
  d += `L${r((5 * first.x + second.x) / 6)},${r((5 * first.y + second.y) / 6)}`;
  for (let i = 2; i < points.length; i += 1) {
    curve(points[i - 2], points[i - 1], points[i]);
  }
  const a = points[points.length - 2];
  const b = points[points.length - 1];
  curve(a, b, b);
  d += `L${r(b.x)},${r(b.y)}`;
  return d;
}

/** A filled triangle whose tip sits on `tip`, pointing away from `from`. */
export function arrowPath(from: Point, tip: Point): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const hypot = Math.hypot(dx, dy);
  const len = hypot === 0 ? 1 : hypot;
  const ux = dx / len;
  const uy = dy / len;
  const bx = tip.x - ux * ARROW_LENGTH;
  const by = tip.y - uy * ARROW_LENGTH;
  const px = -uy * ARROW_HALF_WIDTH;
  const py = ux * ARROW_HALF_WIDTH;
  return (
    `M${r(tip.x)},${r(tip.y)}` +
    `L${r(bx + px)},${r(by + py)}` +
    `L${r(bx - px)},${r(by - py)}Z`
  );
}

/**
 * Where the drawn curve passes the point dagre reserved for an edge label.
 * A B-spline does not run through its control points: near point i it
 * passes (p[i-1] + 4·p[i] + p[i+1]) / 6, so the label is moved there to sit
 * on the line rather than beside it.
 */
function onCurve(points: readonly Point[], target: Point): Point {
  if (points.length < 3) {
    const [a, b] = points;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  let best = 1;
  let bestDistance = Infinity;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = Math.hypot(points[i].x - target.x, points[i].y - target.y);
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  }
  const [a, b, c] = [points[best - 1], points[best], points[best + 1]];
  return { x: (a.x + 4 * b.x + c.x) / 6, y: (a.y + 4 * b.y + c.y) / 6 };
}

interface DagreNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DagreEdge {
  points?: Point[];
  x?: number;
  y?: number;
}

/**
 * Lays the graph out left to right (or top to bottom): blockers before the
 * nodes that wait on them. Edges whose ends are not both in `nodes` are
 * dropped, as are repeats of the same blocker → waiting pair (the first
 * wins). Returns top-left boxes, curved edge paths with arrowheads, weight
 * label boxes, group frames and the overall size, all in CSS pixels.
 */
export function layoutGraph(
  nodes: readonly GraphNodeData[],
  edges: readonly GraphEdgeData[],
  options: GraphLayoutOptions = {}
): GraphLayout {
  const direction: GraphDirection = options.direction ?? 'LR';
  if (options.clusters !== undefined) {
    return layoutClustered(nodes, edges, direction, options.clusters);
  }
  const horizontal = direction === 'LR';
  const hasGroups = nodes.some(
    (node) => node.group !== undefined && node.group !== ''
  );
  const cluster = options.cluster === true && hasGroups;

  if (nodes.length === 0) {
    return { width: 0, height: 0, direction, nodes: [], edges: [], groups: [] };
  }

  const g = new graphlib.Graph({ compound: cluster, multigraph: false });
  g.setGraph({
    rankdir: direction,
    // Across ranks: room for a curve, an arrowhead and a weight label.
    ranksep: horizontal ? 64 : 52,
    // Within a rank: boxes breathe but stay a column.
    nodesep: horizontal ? 22 : 28,
    edgesep: 14,
    marginx: 24,
    // Group titles sit on the frame's top rule; give them headroom.
    marginy: cluster ? 30 : 24,
    ranker: 'network-simplex',
  });
  g.setDefaultEdgeLabel(() => ({}));

  const measures = new Map<string, NodeMeasure>();
  const groupLabels = new Map<string, string>();
  for (const node of nodes) {
    if (measures.has(node.id)) continue;
    const measure = measureNode(node);
    measures.set(node.id, measure);
    g.setNode(node.id, { width: measure.width, height: measure.height });
    if (cluster && node.group !== undefined && node.group !== '') {
      const groupId = `${GROUP_PREFIX}${node.group}`;
      if (!groupLabels.has(groupId)) {
        groupLabels.set(groupId, node.group);
        g.setNode(groupId, {});
      }
      g.setParent(node.id, groupId);
    }
  }

  const kept: { edge: GraphEdgeData; key: string }[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!measures.has(edge.from) || !measures.has(edge.to)) continue;
    const key = edgeKey(edge.from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ edge, key });
    const weight = edge.weight ?? 1;
    const text = weight > 1 ? String(weight) : '';
    g.setEdge(edge.from, edge.to, {
      // Accent chains pull straighter: dagre shortens heavier edges first.
      weight: edge.kind === 'risk' || edge.kind === 'cycle' ? 2 : 1,
      minlen: 1,
      width:
        text === ''
          ? 0
          : Math.ceil(text.length * M.weightAdvance + M.weightPadX * 2),
      height: text === '' ? 0 : M.weightHeight,
      labelpos: 'c',
    });
  }

  dagreLayout(g);

  // Boxes: dagre reports centres; snap the top-left corner to whole pixels
  // so 1px borders stay crisp.
  const placed: (LaidOutNode & { cx: number; cy: number })[] = [];
  for (const [id, measure] of measures) {
    const box = g.node(id) as DagreNode;
    placed.push({
      id,
      x: Math.round(box.x - measure.width / 2),
      y: Math.round(box.y - measure.height / 2),
      width: measure.width,
      height: measure.height,
      rank: 0,
      labelLines: measure.labelLines,
      sublabelLine: measure.sublabelLine,
      cx: r(box.x),
      cy: r(box.y),
    });
  }

  // Ranks share a centre on the rank axis; number the distinct centres.
  const rankAxis = (n: { cx: number; cy: number }) =>
    horizontal ? n.cx : n.cy;
  const crossAxis = (n: { cx: number; cy: number }) =>
    horizontal ? n.cy : n.cx;
  const centres = [...new Set(placed.map((n) => Math.round(rankAxis(n))))].sort(
    (a, b) => a - b
  );
  const rankOf = new Map(centres.map((c, i) => [c, i]));
  for (const n of placed) n.rank = rankOf.get(Math.round(rankAxis(n))) ?? 0;
  placed.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const across = crossAxis(a) - crossAxis(b);
    if (across !== 0) return across;
    return a.id < b.id ? -1 : 1;
  });

  const laidEdges: LaidOutEdge[] = [];
  for (const { edge, key } of kept) {
    const route = g.edge(edge.from, edge.to) as DagreEdge | undefined;
    const points = (route?.points ?? []).map((p) => ({ x: r(p.x), y: r(p.y) }));
    if (points.length < 2) continue;
    const weight = edge.weight ?? 1;
    const tip = points[points.length - 1];
    const before = points[points.length - 2];
    const labelWidth = Math.ceil(
      String(weight).length * M.weightAdvance + M.weightPadX * 2
    );
    const at =
      weight > 1
        ? onCurve(points, {
            x: route?.x ?? points[0].x,
            y: route?.y ?? points[0].y,
          })
        : null;
    laidEdges.push({
      key,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      weight,
      points,
      path: basisPath(points),
      arrow: arrowPath(before, tip),
      label:
        at !== null
          ? {
              x: Math.round(at.x - labelWidth / 2),
              y: Math.round(at.y - M.weightHeight / 2),
              width: labelWidth,
              height: M.weightHeight,
            }
          : null,
    });
  }
  // Array sort is stable, so edges of one kind keep their input order.
  laidEdges.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const groups: LaidOutGroup[] = [];
  for (const [groupId, label] of groupLabels) {
    const box = g.node(groupId) as DagreNode | undefined;
    if (box === undefined || !Number.isFinite(box.x)) continue;
    groups.push({
      id: label,
      label,
      x: Math.round(box.x - box.width / 2),
      y: Math.round(box.y - box.height / 2),
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
  }
  groups.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  // The canvas covers everything drawn, plus the margin on the far sides.
  const graph = g.graph() as { width?: number; height?: number };
  let width = graph.width ?? 0;
  let height = graph.height ?? 0;
  for (const n of placed) {
    width = Math.max(width, n.x + n.width + 24);
    height = Math.max(height, n.y + n.height + 24);
  }
  for (const grp of groups) {
    width = Math.max(width, grp.x + grp.width + 24);
    height = Math.max(height, grp.y + grp.height + 24);
  }
  for (const e of laidEdges) {
    for (const p of e.points) {
      width = Math.max(width, p.x + 24);
      height = Math.max(height, p.y + 24);
    }
  }

  return {
    width: Math.ceil(width),
    height: Math.ceil(height),
    direction,
    nodes: placed.map(({ cx: _cx, cy: _cy, ...node }) => node),
    edges: laidEdges,
    groups,
  };
}

/* ---- clustered layout ------------------------------------------------------- */

// Item keys inside a frame: a node or a child frame (NUL-separated so no
// id can collide with the other kind).
const NODE_ITEM = 'n\u0000';
const FRAME_ITEM = 'f\u0000';
// A frame's ports: where edges leaving or entering it attach in its own
// dagre run, so what they connect drifts to the frame's far or near side.
const PORT_OUT = '\u0000out';
const PORT_IN = '\u0000in';
/**
 * dagre edge weights in a frame's flow, all whole numbers: a link pulls
 * LINK_PULL per edge it lays out (twice that for a risk or cycle edge), an
 * item's edge to its frame's port LINK_PULL, and the edges that only rank
 * a port beyond the flow PORT_PULL, a hundredth of a link. dagre's
 * network-simplex ranker pivots while a cut value is below zero, and a sum
 * of fractional weights can leave one at -2e-16 that never reaches zero,
 * so a fraction here can loop forever (a 9-issue project did, blocking the
 * server's render); whole weights keep every cut value exact.
 */
const LINK_PULL = 100;
const PORT_PULL = 1;

const nodeItem = (id: string): string => `${NODE_ITEM}${id}`;
const frameItem = (id: string): string => `${FRAME_ITEM}${id}`;
const isNodeItem = (key: string): boolean => key.startsWith(NODE_ITEM);

/** Item pairs that one frame's dagre run lays out an edge between. */
interface FrameLink {
  from: string;
  to: string;
  /**
   * How hard it pulls, in edges laid out (a risk or cycle edge counts
   * twice); dagre's weight is this times LINK_PULL.
   */
  pull: number;
  /** The node edge's weight label ('' between frames or for weight 1). */
  text: string;
}

/**
 * One cluster frame, or the top level (`id` null), while laying out:
 * what it holds, the links its own dagre run lays out (edges whose
 * lowest common frame it is) and the items holding an end of an edge
 * that leaves or enters it; then, bottom-up, its size and where each of
 * its items sits inside its content box.
 */
interface Frame {
  id: string | null;
  data: GraphClusterData | null;
  /** Position in the given clusters (the top level: -1), for order. */
  index: number;
  parent: Frame | null;
  /** 0 for a top-level frame; the top level itself is -1. */
  depth: number;
  children: Frame[];
  nodes: string[];
  links: Map<string, FrameLink>;
  outs: Set<string>;
  ins: Set<string>;
  width: number;
  height: number;
  /** Item key → its top-left inside the content box. */
  at: Map<string, { x: number; y: number }>;
  /** Link key → its dagre route (and label point) inside the content box. */
  routes: Map<string, { points: Point[]; label: Point | null }>;
  /** Item key → its dagre routes to the out port and from the in port. */
  ports: Map<string, PortRoutes>;
  /** Items in reading order: the flow by rank, the grid, the shelves. */
  sequence: string[];
  /** The content box's absolute top-left, once placed. */
  originX: number;
  originY: number;
}

function newFrame(
  id: string | null,
  data: GraphClusterData | null,
  index: number,
  parent: Frame | null
): Frame {
  return {
    id,
    data,
    index,
    parent,
    depth: parent === null ? -1 : parent.depth + 1,
    children: [],
    nodes: [],
    links: new Map(),
    outs: new Set(),
    ins: new Set(),
    width: 0,
    height: 0,
    at: new Map(),
    routes: new Map(),
    ports: new Map(),
    sequence: [],
    originX: 0,
    originY: 0,
  };
}

/**
 * The frame tree for `clusters`: `frameOf(id)` gives a cluster's frame,
 * creating it and its ancestors on first use, so only clusters that hold
 * a node become frames. An unknown id, a missing parent or a parent chain
 * that loops back ends at the top level.
 */
function frameTree(clusters: readonly GraphClusterData[]): {
  top: Frame;
  frameOf: (id: string | undefined) => Frame;
} {
  const top = newFrame(null, null, -1, null);
  const indexOf = new Map<string, number>();
  clusters.forEach((cluster, i) => {
    if (!indexOf.has(cluster.id)) indexOf.set(cluster.id, i);
  });
  const frames = new Map<string, Frame>();
  const frameOf = (id: string | undefined): Frame => {
    if (id === undefined) return top;
    const known = frames.get(id);
    if (known !== undefined) return known;
    if (!indexOf.has(id)) return top;
    // The chain of not-yet-made frames from `id` up to a made one.
    const chain: number[] = [];
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (
      current !== undefined &&
      indexOf.has(current) &&
      !frames.has(current) &&
      !seen.has(current)
    ) {
      seen.add(current);
      const index: number = indexOf.get(current) ?? 0;
      chain.push(index);
      current = clusters[index]?.parent;
    }
    let parent =
      current !== undefined && !seen.has(current)
        ? (frames.get(current) ?? top)
        : top;
    for (let k = chain.length - 1; k >= 0; k -= 1) {
      const index = chain[k];
      const data = clusters[index];
      const frame = newFrame(data.id, data, index, parent);
      parent.children.push(frame);
      frames.set(data.id, frame);
      parent = frame;
    }
    return frames.get(id) ?? top;
  };
  return { top, frameOf };
}

/** The lowest frame holding both `a` and `b`. */
function commonFrame(a: Frame, b: Frame): Frame {
  let x = a;
  let y = b;
  while (x.depth > y.depth && x.parent !== null) x = x.parent;
  while (y.depth > x.depth && y.parent !== null) y = y.parent;
  while (x !== y && x.parent !== null && y.parent !== null) {
    x = x.parent;
    y = y.parent;
  }
  return x;
}

/**
 * Walks from a node's own frame up to (not into) `stop`, calling `visit`
 * with each frame and the item of that frame that holds the node (the
 * node itself in its own frame, then the child frame it is inside).
 */
function climb(
  home: Frame,
  nodeId: string,
  stop: Frame,
  visit: (frame: Frame, item: string) => void
): string {
  let frame = home;
  let item = nodeItem(nodeId);
  while (frame !== stop && frame.parent !== null) {
    visit(frame, item);
    item = frameItem(frame.id ?? '');
    frame = frame.parent;
  }
  return item;
}

/**
 * The dagre routes of an item's edges to its frame's out port and from its
 * in port (content-box coordinates, so they may run past the content box
 * where the port sits a rank beyond it). An arrow between frames follows
 * them out of and into each frame it crosses, so it runs round the other
 * items there the way dagre routed it, not behind them.
 */
interface PortRoutes {
  out: Point[] | null;
  in: Point[] | null;
}

/** One frame's flow: dagre over some of its items, normalised to 0,0. */
interface Flow {
  at: Map<string, { x: number; y: number }>;
  routes: Map<string, { points: Point[]; label: Point | null }>;
  ports: Map<string, PortRoutes>;
  width: number;
  height: number;
  /** The items by rank (their centre along the direction), then across. */
  order: string[];
  /**
   * The flow was not laid out: its longest chain alone is longer than
   * runFlow's `maxLength` (flowChain). Nothing is placed, the size along
   * the direction is that chain's length, and `order` is the items by the
   * chain's ranks.
   */
  tooLong: boolean;
}

/**
 * A lower bound on how long dagre lays the items of `g` out along the
 * direction, and the items in the order of their ranks. dagre's acyclic
 * step reverses the edges a depth-first walk finds closing a cycle (from
 * the sources first, then from every node, out-edges in insertion order:
 * @dagrejs/dagre 3's dfs acyclicer, mirrored here so the chains are the
 * ones it ranks); every item on a chain of the result gets a rank of its
 * own, and ranks sit `ranksep` apart, so the flow is at least as long as
 * its longest chain's item sizes plus the gaps. The port nodes only start
 * or end chains and are left out. O(V + E), against dagre's run, which
 * on a workspace frame over many project frames took seconds only to be
 * discarded for shelves (layoutFrame).
 */
function flowChain(
  g: InstanceType<typeof graphlib.Graph>,
  items: readonly string[],
  sizeOf: (key: string) => { width: number; height: number },
  horizontal: boolean,
  ranksep: number
): { length: number; order: string[] } {
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const reversed = new Set<string>();
  const edgeId = (v: string, w: string) => `${v}\u0001${w}`;
  const walk = (start: string): void => {
    if (visited.has(start)) return;
    visited.add(start);
    onStack.add(start);
    const stack: { v: string; out: { v: string; w: string }[]; i: number }[] = [
      { v: start, out: g.outEdges(start) ?? [], i: 0 },
    ];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.i >= top.out.length) {
        onStack.delete(top.v);
        stack.pop();
        continue;
      }
      const edge = top.out[top.i];
      top.i += 1;
      if (onStack.has(edge.w)) {
        reversed.add(edgeId(edge.v, edge.w));
      } else if (!visited.has(edge.w)) {
        visited.add(edge.w);
        onStack.add(edge.w);
        stack.push({ v: edge.w, out: g.outEdges(edge.w) ?? [], i: 0 });
      }
    }
  };
  for (const v of g.sources()) walk(v);
  for (const v of g.nodes()) walk(v);

  const isItem = new Set(items);
  const preds = new Map<string, string[]>();
  const indegree = new Map<string, number>(items.map((key) => [key, 0]));
  for (const edge of g.edges()) {
    if (!isItem.has(edge.v) || !isItem.has(edge.w) || edge.v === edge.w) {
      continue;
    }
    const back = reversed.has(edgeId(edge.v, edge.w));
    const from = back ? edge.w : edge.v;
    const to = back ? edge.v : edge.w;
    const list = preds.get(to) ?? [];
    list.push(from);
    preds.set(to, list);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const succs = new Map<string, string[]>();
  for (const [to, list] of preds) {
    for (const from of list) {
      const next = succs.get(from) ?? [];
      next.push(to);
      succs.set(from, next);
    }
  }
  // Kahn's order, sources in item order.
  const queue = items.filter((key) => (indegree.get(key) ?? 0) === 0);
  const length = new Map<string, number>();
  const rank = new Map<string, number>();
  let longest = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const key = queue[head];
    const size = sizeOf(key);
    let before = -ranksep;
    let rk = 0;
    for (const from of preds.get(key) ?? []) {
      before = Math.max(before, length.get(from) ?? 0);
      rk = Math.max(rk, (rank.get(from) ?? 0) + 1);
    }
    const own = before + ranksep + (horizontal ? size.width : size.height);
    length.set(key, own);
    rank.set(key, rk);
    longest = Math.max(longest, own);
    for (const to of succs.get(key) ?? []) {
      const left = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, left);
      if (left === 0) queue.push(to);
    }
  }
  const index = new Map(items.map((key, i) => [key, i]));
  const order = [...items].sort((a, b) => {
    const byRank = (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
    return byRank !== 0 ? byRank : (index.get(a) ?? 0) - (index.get(b) ?? 0);
  });
  return { length: longest, order };
}

/**
 * Moves the first ranks of a laid-out flow up into its top corner (left,
 * for LR). dagre centres each rank on its neighbours, so when a later rank
 * stacks higher than the first ones (a tall frame or several boxes at the
 * far end) everything before it hangs below an empty band, and reading
 * starts in blank space: about 130px above the workspace issue level's
 * first box. When that band is at least C.liftMin (about a box) tall, each
 * rank rises by the space that lies above it and above every rank before
 * it (its items' and the arrows' points counted), so the band goes and the
 * ranks from the first to the highest one keep their places relative to
 * each other; nothing rises past an arrow or a box, and the ranks from the
 * highest one on stay put. A thinner band is left: moving ranks bends the
 * arrows between them, which can put one behind a box.
 *
 * A rank moves as one piece with the arrow points in its stretch (from
 * the end of the rank before it to its own far edge, so a point in the
 * gap between two ranks goes with the later one): items keep their order
 * across the direction and an arrow its slot between them, and only the
 * curves between two ranks that rise by different amounts get steeper.
 * The routes to and from the frame's ports move the same way. A route's
 * end on the side of its box that faces along the direction moves with
 * the box; one on another side is found again from the risen points.
 * Mutates dagre's output in place.
 */
function liftOpening(
  g: InstanceType<typeof graphlib.Graph>,
  items: readonly string[],
  links: readonly [string, FrameLink][],
  outs: ReadonlySet<string>,
  ins: ReadonlySet<string>,
  sizeOf: (key: string) => { width: number; height: number },
  horizontal: boolean
): void {
  const along = (p: Point) => (horizontal ? p.x : p.y);
  const across = (p: Point) => (horizontal ? p.y : p.x);
  // Ranks by their centre along the direction (dagre gives every item of a
  // rank the same one): where the rank's far edge is and its top.
  const byCentre = new Map<number, { end: number; top: number }>();
  for (const key of items) {
    const box = g.node(key) as DagreNode;
    const size = sizeOf(key);
    const centre = Math.round(along(box));
    const end = along(box) + (horizontal ? size.width : size.height) / 2;
    const top = across(box) - (horizontal ? size.height : size.width) / 2;
    const known = byCentre.get(centre);
    byCentre.set(centre, {
      end: Math.max(known?.end ?? end, end),
      top: Math.min(known?.top ?? top, top),
    });
  }
  if (byCentre.size < 2) return;
  const ranks = [...byCentre.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, rank]) => rank);
  const stretchOf = (value: number): number => {
    let k = 0;
    while (k + 1 < ranks.length && ranks[k].end < value) k += 1;
    return k;
  };
  const drawn = links.map(
    ([, link]) => g.edge(link.from, link.to) as DagreEdge | undefined
  );
  const highest = ranks.map((rank) => rank.top);
  for (const route of drawn) {
    for (const p of route?.points ?? []) {
      const k = stretchOf(along(p));
      highest[k] = Math.min(highest[k], across(p));
    }
  }
  const top = Math.min(...highest);
  let floor = Infinity;
  const lift = highest.map((value) => {
    floor = Math.min(floor, value);
    return floor - top;
  });
  if (lift[0] < C.liftMin) return;
  const raise = (p: Point) => {
    const by = lift[stretchOf(along(p))];
    if (horizontal) p.y -= by;
    else p.x -= by;
  };
  const raiseRoute = (route: DagreEdge | undefined) => {
    if (route === undefined) return;
    // The label point first: it is read where the route was.
    if (route.x !== undefined && route.y !== undefined) {
      const label = { x: route.x, y: route.y };
      raise(label);
      route.x = label.x;
      route.y = label.y;
    }
    for (const p of route.points ?? []) raise(p);
  };
  // dagre ends a route where the line from the box's centre to the next
  // point leaves the box. An end on the side facing along the direction
  // (where most arrows leave and enter) rises with its box and stays; one
  // on another side is found again from the risen points, since its box
  // may now sit level with the curve (a route that moved as one piece gets
  // the same end back).
  const node = (key: string) => g.node(key) as DagreNode;
  const facing = (box: DagreNode, p: Point, end: 'out' | 'in'): boolean => {
    const half = (horizontal ? box.width : box.height) / 2;
    const side = along(box) + (end === 'out' ? half : -half);
    return Math.abs(along(p) - side) < 0.5;
  };
  const ends: {
    points: Point[];
    from: DagreNode | null;
    to: DagreNode | null;
  }[] = [];
  links.forEach(([, link], i) => {
    const points = drawn[i]?.points;
    if (points === undefined || points.length < 2 || link.from === link.to) {
      return;
    }
    const from = node(link.from);
    const to = node(link.to);
    ends.push({
      points,
      from: facing(from, points[0], 'out') ? null : from,
      to: facing(to, points[points.length - 1], 'in') ? null : to,
    });
  });
  for (const key of outs) {
    const points = (g.edge(key, PORT_OUT) as DagreEdge | undefined)?.points;
    if (points !== undefined && points.length >= 2) {
      const box = node(key);
      ends.push({
        points,
        from: facing(box, points[0], 'out') ? null : box,
        to: null,
      });
    }
  }
  for (const key of ins) {
    const points = (g.edge(PORT_IN, key) as DagreEdge | undefined)?.points;
    if (points !== undefined && points.length >= 2) {
      const box = node(key);
      ends.push({
        points,
        from: null,
        to: facing(box, points[points.length - 1], 'in') ? null : box,
      });
    }
  }
  for (const key of items) raise(g.node(key) as DagreNode);
  for (const route of drawn) raiseRoute(route);
  for (const key of outs) {
    raiseRoute(g.edge(key, PORT_OUT) as DagreEdge | undefined);
  }
  for (const key of ins) {
    raiseRoute(g.edge(PORT_IN, key) as DagreEdge | undefined);
  }
  for (const { points, from, to } of ends) {
    const last = points.length - 1;
    if (from !== null) points[0] = boxExit(from, points[1]);
    if (to !== null) points[last] = boxExit(to, points[last - 1]);
  }
}

/**
 * Where the line from `box`'s centre toward `toward` crosses its border
 * (dagre's own rule for a route's ends). A point at the centre gives the
 * centre back.
 */
function boxExit(box: DagreNode, toward: Point): Point {
  const dx = toward.x - box.x;
  const dy = toward.y - box.y;
  const halfW = box.width / 2;
  const halfH = box.height / 2;
  if (dx === 0 && dy === 0) return { x: box.x, y: box.y };
  if (Math.abs(dy) * halfW > Math.abs(dx) * halfH) {
    const h = dy < 0 ? -halfH : halfH;
    return { x: box.x + (h * dx) / dy, y: box.y + h };
  }
  const w = dx < 0 ? -halfW : halfW;
  return { x: box.x + w, y: box.y + (w * dy) / dx };
}

/**
 * Runs dagre over `items` (keys with their sizes) and the `links` between
 * them, with a zero-size port after the `outs` and one before the `ins`
 * (so what connects out of the frame drifts to its far side and what
 * connects in to its near side; the ports themselves are not kept).
 * Positions and routes come back shifted so the items' box starts at 0,0.
 * When the flow's longest chain alone (flowChain) is longer than
 * `maxLength` along the direction, dagre is not run and the flow comes
 * back `tooLong`.
 */
function runFlow(
  items: readonly string[],
  links: readonly [string, FrameLink][],
  outs: ReadonlySet<string>,
  ins: ReadonlySet<string>,
  sizeOf: (key: string) => { width: number; height: number },
  direction: GraphDirection,
  maxLength = Infinity
): Flow {
  const flow: Flow = {
    at: new Map(),
    routes: new Map(),
    ports: new Map(),
    width: 0,
    height: 0,
    order: [],
    tooLong: false,
  };
  if (items.length === 0) return flow;
  const horizontal = direction === 'LR';
  const g = new graphlib.Graph({ multigraph: false });
  const simplex =
    items.length <= C.simplexItems && links.length <= C.simplexLinks;
  const ranksep = horizontal ? 64 : 52;
  g.setGraph({
    rankdir: direction,
    ranksep,
    nodesep: horizontal ? 22 : 28,
    edgesep: 14,
    marginx: 0,
    marginy: 0,
    ranker: simplex ? 'network-simplex' : 'tight-tree',
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const key of items) g.setNode(key, sizeOf(key));
  for (const [, link] of links) {
    g.setEdge(link.from, link.to, {
      weight: link.pull * LINK_PULL,
      minlen: 1,
      width:
        link.text === ''
          ? 0
          : Math.ceil(link.text.length * M.weightAdvance + M.weightPadX * 2),
      height: link.text === '' ? 0 : M.weightHeight,
      labelpos: 'c',
    });
  }
  const port = { width: 1, height: 1 };
  // Every item that leads nowhere else in the flow also gets a feather-
  // weight edge to the out port, and every item nothing in the flow leads
  // to one from the in port: that ranks the ports beyond the whole flow
  // (not merely beside their own items), so the routes dagre gives the
  // arrows leaving or entering the frame run round every item in it. The
  // tiny weight keeps those edges from pulling items along the direction.
  // Only in a flow small enough for network-simplex: in a big one they
  // add an edge per item and dagre's crossing pass then costs most of a
  // second more (600 boxes and 850 arrows in one milestone: 0.86 s
  // against 0.5 s), so there the ports sit beside their own items.
  const feathered = simplex;
  const hasOut = new Set<string>();
  const hasIn = new Set<string>();
  for (const [, link] of links) {
    hasOut.add(link.from);
    hasIn.add(link.to);
  }
  const feather = { weight: PORT_PULL, minlen: 1, width: 0, height: 0 };
  if (outs.size > 0) {
    g.setNode(PORT_OUT, port);
    for (const key of outs) {
      g.setEdge(key, PORT_OUT, {
        weight: LINK_PULL,
        minlen: 1,
        width: 0,
        height: 0,
      });
    }
    for (const key of items) {
      if (feathered && !outs.has(key) && !hasOut.has(key)) {
        g.setEdge(key, PORT_OUT, feather);
      }
    }
  }
  if (ins.size > 0) {
    g.setNode(PORT_IN, port);
    for (const key of ins) {
      g.setEdge(PORT_IN, key, {
        weight: LINK_PULL,
        minlen: 1,
        width: 0,
        height: 0,
      });
    }
    for (const key of items) {
      if (feathered && !ins.has(key) && !hasIn.has(key)) {
        g.setEdge(PORT_IN, key, feather);
      }
    }
  }
  if (Number.isFinite(maxLength)) {
    const chain = flowChain(g, items, sizeOf, horizontal, ranksep);
    if (chain.length > maxLength) {
      flow.tooLong = true;
      flow.order = chain.order;
      if (horizontal) flow.width = Math.ceil(chain.length);
      else flow.height = Math.ceil(chain.length);
      return flow;
    }
  }
  dagreLayout(g);
  liftOpening(g, items, links, outs, ins, sizeOf, horizontal);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const boxes = new Map<
    string,
    { x: number; y: number; cx: number; cy: number }
  >();
  for (const key of items) {
    const box = g.node(key) as DagreNode;
    const size = sizeOf(key);
    const x = Math.round(box.x - size.width / 2);
    const y = Math.round(box.y - size.height / 2);
    boxes.set(key, { x, y, cx: box.x, cy: box.y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + size.width);
    maxY = Math.max(maxY, y + size.height);
  }
  const raw = new Map<string, DagreEdge | undefined>();
  for (const [key, link] of links) {
    const route = g.edge(link.from, link.to) as DagreEdge | undefined;
    raw.set(key, route);
    for (const p of route?.points ?? []) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  const shiftX = Math.floor(minX);
  const shiftY = Math.floor(minY);
  for (const [key, box] of boxes) {
    flow.at.set(key, { x: box.x - shiftX, y: box.y - shiftY });
  }
  for (const [key, route] of raw) {
    flow.routes.set(key, {
      points: (route?.points ?? []).map((p) => ({
        x: r(p.x - shiftX),
        y: r(p.y - shiftY),
      })),
      label:
        route?.x === undefined || route.y === undefined
          ? null
          : { x: route.x - shiftX, y: route.y - shiftY },
    });
  }
  const shifted = (route: DagreEdge | undefined): Point[] | null =>
    route === undefined
      ? null
      : (route.points ?? []).map((p) => ({
          x: r(p.x - shiftX),
          y: r(p.y - shiftY),
        }));
  for (const key of outs) {
    if (!boxes.has(key)) continue;
    const route = g.edge(key, PORT_OUT) as DagreEdge | undefined;
    flow.ports.set(key, { out: shifted(route), in: null });
  }
  for (const key of ins) {
    if (!boxes.has(key)) continue;
    const route = g.edge(PORT_IN, key) as DagreEdge | undefined;
    const known = flow.ports.get(key);
    flow.ports.set(key, { out: known?.out ?? null, in: shifted(route) });
  }
  flow.width = Math.ceil(maxX - shiftX);
  flow.height = Math.ceil(maxY - shiftY);
  const along = (b: { cx: number; cy: number }) =>
    Math.round(horizontal ? b.cx : b.cy);
  const across = (b: { cx: number; cy: number }) => (horizontal ? b.cy : b.cx);
  flow.order = [...boxes.entries()]
    .sort(([ka, a], [kb, b]) => {
      if (along(a) !== along(b)) return along(a) - along(b);
      if (across(a) !== across(b)) return across(a) - across(b);
      return ka < kb ? -1 : 1;
    })
    .map(([key]) => key);
  return flow;
}

/**
 * Lays one frame's own items out (its child frames already have their
 * sizes): the items on a link or a port flow by dagre along `direction`,
 * the remaining nodes pack into a grid under the flow (open ones first,
 * done and empty ones last, otherwise in input order) and the remaining frames onto
 * shelves under that. When frames in the flow would make it longer along
 * the direction than C.flowMax or C.flowSpread times what the frames
 * would take on shelves (many arrows between frames chain them into one
 * very long row), every child frame goes onto the shelves instead, the
 * linked ones first in their flow order, and only the frame's own nodes
 * flow; arrows between those frames are then drawn without a dagre
 * route. Sets the frame's size (with its border, title strip and padding
 * for a cluster), item positions, routes and reading order.
 */
function layoutFrame(
  frame: Frame,
  measures: ReadonlyMap<string, NodeMeasure>,
  done: ReadonlySet<string>,
  direction: GraphDirection
): void {
  const horizontal = direction === 'LR';
  const childOf = new Map(
    frame.children.map((child) => [frameItem(child.id ?? ''), child])
  );
  const sizeOf = (key: string): { width: number; height: number } => {
    if (isNodeItem(key)) {
      const measure = measures.get(key.slice(NODE_ITEM.length));
      return { width: measure?.width ?? 0, height: measure?.height ?? 0 };
    }
    const child = childOf.get(key);
    return { width: child?.width ?? 0, height: child?.height ?? 0 };
  };
  const items = [...frame.nodes.map(nodeItem), ...childOf.keys()];
  const linked = new Set<string>([...frame.outs, ...frame.ins]);
  for (const link of frame.links.values()) {
    linked.add(link.from);
    linked.add(link.to);
  }

  // The flow: dagre over the linked items, unless that chains frames
  // into a row too long to read, when only the nodes flow. A flow whose
  // longest chain alone already passes the cap is never laid out: dagre
  // would spend seconds on a workspace frame over many project frames
  // for a drawing the cap then throws away.
  const flowItems = items.filter((key) => linked.has(key));
  const links = [...frame.links];
  const frameSizes = frame.children.map((child) => ({
    width: child.width,
    height: child.height,
  }));
  const cap = Math.max(
    C.flowMax,
    shelfWidth(frameSizes, C.shelfAspect) * C.flowSpread
  );
  const flowsFrames = flowItems.some((key) => !isNodeItem(key));
  let flow = runFlow(
    flowItems,
    links,
    frame.outs,
    frame.ins,
    sizeOf,
    direction,
    flowsFrames ? cap : Infinity
  );
  let shelvedLinked: string[] = [];
  if (
    flowsFrames &&
    (flow.tooLong || (horizontal ? flow.width : flow.height) > cap)
  ) {
    shelvedLinked = flow.order.filter((key) => !isNodeItem(key));
    const outs = new Set([...frame.outs].filter(isNodeItem));
    const ins = new Set([...frame.ins].filter(isNodeItem));
    for (const [, link] of links) {
      const fromNode = isNodeItem(link.from);
      const toNode = isNodeItem(link.to);
      if (fromNode && !toNode) outs.add(link.from);
      if (!fromNode && toNode) ins.add(link.to);
    }
    flow = runFlow(
      flowItems.filter(isNodeItem),
      links.filter(([, link]) => isNodeItem(link.from) && isNodeItem(link.to)),
      outs,
      ins,
      sizeOf,
      direction
    );
  }
  for (const [key, at] of flow.at) frame.at.set(key, at);
  for (const [key, route] of flow.routes) frame.routes.set(key, route);
  for (const [key, ports] of flow.ports) frame.ports.set(key, ports);

  // The grid: the nodes on no link, open before done (and empty).
  const loose = frame.nodes.map(nodeItem).filter((key) => !linked.has(key));
  const gridKeys = [
    ...loose.filter((key) => !done.has(key.slice(NODE_ITEM.length))),
    ...loose.filter((key) => done.has(key.slice(NODE_ITEM.length))),
  ];
  const gridSizes = gridKeys.map(sizeOf);
  const mean = {
    width:
      gridSizes.reduce((sum, size) => sum + size.width, 0) /
      Math.max(1, gridSizes.length),
    height:
      gridSizes.reduce((sum, size) => sum + size.height, 0) /
      Math.max(1, gridSizes.length),
  };
  const grid = packGrid(
    gridSizes,
    gridColumns(gridSizes.length, mean, C.gridGapX, C.gridAspect, flow.width),
    C.gridGapX,
    C.gridGapY
  );

  // The shelves: the child frames on no link (after any linked ones the
  // flow gave up on, in their flow order).
  const shelfKeys = [
    ...shelvedLinked,
    ...[...childOf.keys()].filter((key) => !linked.has(key)),
  ];
  const shelfSizes = shelfKeys.map(sizeOf);
  const shelves = packShelves(
    shelfSizes,
    shelfWidth(shelfSizes, C.shelfAspect, Math.max(flow.width, grid.width)),
    C.gap,
    C.gap
  );

  // Flow, grid and shelves stacked, each a gap below the one before.
  let y = flow.height;
  const below = (height: number, count: number): number => {
    if (count === 0) return y;
    const top = y > 0 ? y + C.gap : 0;
    y = top + height;
    return top;
  };
  const gridTop = below(grid.height, gridKeys.length);
  gridKeys.forEach((key, i) => {
    const at = grid.positions[i];
    frame.at.set(key, { x: at.x, y: gridTop + at.y });
  });
  const shelfTop = below(shelves.height, shelfKeys.length);
  shelfKeys.forEach((key, i) => {
    const at = shelves.positions[i];
    frame.at.set(key, { x: at.x, y: shelfTop + at.y });
  });
  frame.sequence = [...flow.order, ...gridKeys, ...shelfKeys];

  const contentWidth = Math.max(flow.width, grid.width, shelves.width);
  if (frame.data === null) {
    frame.width = contentWidth;
    frame.height = y;
    return;
  }
  const title = Math.ceil(clusterTitleWidth(frame.data.label) + C.titleX * 2);
  frame.width = Math.max(contentWidth + C.padX * 2, title);
  frame.height = y + C.padTop + C.padBottom;
}

/** A box's top-left corner and size. */
type Box = { x: number; y: number; width: number; height: number };

/** Room a rerouted arrow keeps from a box it turns around: half a grid
    row's gap, so a run between two rows of boxes sits in its middle. */
const AVOID_PAD = C.gridGapY / 2;
/** The most control points a rerouted arrow may grow to. */
const AVOID_MAX_POINTS = 128;
/** The side of the cells the obstacles are bucketed in. */
const AVOID_CELL = 240;

/** What a rerouted arrow keeps clear of, bucketed by AVOID_CELL px cells
    so a run looks only at the obstacles near it. */
interface Obstacles {
  buckets: Map<number, Box[]>;
}

const cellKey = (cx: number, cy: number): number => cx * 65536 + cy;

/** `boxes` (the laid-out boxes, frame title patches) as Obstacles. */
function obstaclesOf(boxes: readonly Box[]): Obstacles {
  const buckets = new Map<number, Box[]>();
  for (const box of boxes) {
    const x0 = Math.floor((box.x - AVOID_PAD) / AVOID_CELL);
    const x1 = Math.floor((box.x + box.width + AVOID_PAD) / AVOID_CELL);
    const y0 = Math.floor((box.y - AVOID_PAD) / AVOID_CELL);
    const y1 = Math.floor((box.y + box.height + AVOID_PAD) / AVOID_CELL);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = cellKey(cx, cy);
        const bucket = buckets.get(key);
        if (bucket === undefined) buckets.set(key, [box]);
        else bucket.push(box);
      }
    }
  }
  return { buckets };
}

/**
 * Where the straight run from `a` to `b` first enters `box` grown by
 * `pad` on every side, as a fraction of the run (Liang-Barsky), or null
 * when it misses it, or starts or ends inside it (an arrow cannot turn
 * round a box it is already in).
 */
function entersAt(a: Point, b: Point, box: Box, pad: number): number | null {
  const left = box.x - pad;
  const right = box.x + box.width + pad;
  const top = box.y - pad;
  const bottom = box.y + box.height + pad;
  const inside = (p: Point) =>
    p.x > left && p.x < right && p.y > top && p.y < bottom;
  if (inside(a) || inside(b)) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a.x - left],
    [dx, right - a.x],
    [-dy, a.y - top],
    [dy, bottom - a.y],
  ] as const) {
    if (p === 0) {
      if (q <= 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return null;
  }
  return t0;
}

/**
 * The cells the run from `a` to `b` passes through, in order (a grid walk,
 * Amanatides and Woo): a long diagonal run looks at the cells along it,
 * not at every cell of its bounding box.
 */
function cellsAlong(a: Point, b: Point): number[] {
  let cx = Math.floor(a.x / AVOID_CELL);
  let cy = Math.floor(a.y / AVOID_CELL);
  const endX = Math.floor(b.x / AVOID_CELL);
  const endY = Math.floor(b.y / AVOID_CELL);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const deltaX = dx === 0 ? Infinity : AVOID_CELL / Math.abs(dx);
  const deltaY = dy === 0 ? Infinity : AVOID_CELL / Math.abs(dy);
  let nextX =
    dx === 0
      ? Infinity
      : (stepX > 0 ? (cx + 1) * AVOID_CELL - a.x : a.x - cx * AVOID_CELL) /
        Math.abs(dx);
  let nextY =
    dy === 0
      ? Infinity
      : (stepY > 0 ? (cy + 1) * AVOID_CELL - a.y : a.y - cy * AVOID_CELL) /
        Math.abs(dy);
  const cells = [cellKey(cx, cy)];
  const most = Math.abs(endX - cx) + Math.abs(endY - cy);
  for (let i = 0; i < most && (cx !== endX || cy !== endY); i += 1) {
    if (nextX < nextY) {
      cx += stepX;
      nextX += deltaX;
    } else {
      cy += stepY;
      nextY += deltaY;
    }
    cells.push(cellKey(cx, cy));
  }
  return cells;
}

/** The obstacle the run from `a` to `b` enters first, other than `own`. */
function firstObstacle(
  a: Point,
  b: Point,
  obstacles: Obstacles,
  own: ReadonlySet<Box>
): Box | null {
  let best: Box | null = null;
  let bestAt = Infinity;
  for (const cell of cellsAlong(a, b)) {
    for (const box of obstacles.buckets.get(cell) ?? []) {
      if (own.has(box)) continue;
      // One px inside the detour's own lane, so a run along it is clear.
      const at = entersAt(a, b, box, AVOID_PAD - 1);
      if (at !== null && at < bestAt) {
        best = box;
        bestAt = at;
      }
    }
  }
  return best;
}

/**
 * The two corners a run from `a` to `b` turns round `box` by, AVOID_PAD
 * out from it: over or under a run that is mostly along x, beside one
 * that is mostly along y, on the side the run already passes nearer to
 * the box's centre, and never past either end of the run.
 */
function turnRound(a: Point, b: Point, box: Box): [Point, Point] {
  const left = box.x - AVOID_PAD;
  const right = box.x + box.width + AVOID_PAD;
  const top = box.y - AVOID_PAD;
  const bottom = box.y + box.height + AVOID_PAD;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clamp = (v: number, p: number, q: number) =>
    Math.min(Math.max(p, q), Math.max(Math.min(p, q), v));
  if (Math.abs(dx) >= Math.abs(dy)) {
    const t = Math.min(1, Math.max(0, (box.x + box.width / 2 - a.x) / dx));
    const side = a.y + dy * t <= box.y + box.height / 2 ? top : bottom;
    const [first, second] = dx >= 0 ? [left, right] : [right, left];
    return [
      { x: r(clamp(first, a.x, b.x)), y: r(side) },
      { x: r(clamp(second, a.x, b.x)), y: r(side) },
    ];
  }
  const t = Math.min(1, Math.max(0, (box.y + box.height / 2 - a.y) / dy));
  const side = a.x + dx * t <= box.x + box.width / 2 ? left : right;
  const [first, second] = dy >= 0 ? [top, bottom] : [bottom, top];
  return [
    { x: r(side), y: r(clamp(first, a.y, b.y)) },
    { x: r(side), y: r(clamp(second, a.y, b.y)) },
  ];
}

/**
 * An arrow between frames, kept off the boxes it would run behind (and
 * the frame titles' patches, which hide what runs under them).
 * Between its lead-out and lead-in points each straight run of its
 * control polygon that enters another box turns round it by its nearer
 * side (turnRound), so it runs along the gap beside the box; the new
 * runs are checked in turn, up to AVOID_MAX_POINTS points. Its two ends are kept, and with `leads` the
 * straight lead from each (an arrow between frames), so it still leaves
 * and enters its own boxes straight. On the
 * showcase's 406-box issue level, 67 of 247 arrows ran behind some box
 * before this (2026-10-23 review); dagre routes only inside one frame.
 */
function avoidObstacles(
  points: readonly Point[],
  obstacles: Obstacles,
  own: ReadonlySet<Box>,
  leads: boolean
): Point[] {
  if (points.length < (leads ? 4 : 2)) return [...points];
  const path = leads ? points.slice(1, -1) : [...points];
  const out: Point[] = [path[0]];
  // The points still to reach, the next one last; each run is checked
  // once, and a run that turns round a box is replaced by its three.
  const ahead = path.slice(1).reverse();
  let room = AVOID_MAX_POINTS - path.length;
  while (ahead.length > 0) {
    const b = ahead.pop() as Point;
    const a = out[out.length - 1];
    if (a.x === b.x && a.y === b.y) continue;
    const hit = room >= 2 ? firstObstacle(a, b, obstacles, own) : null;
    if (hit !== null) {
      const [first, second] = turnRound(a, b, hit);
      ahead.push(b, second, first);
      room -= 2;
      continue;
    }
    out.push(b);
  }
  return leads ? [points[0], ...out, points[points.length - 1]] : out;
}

/**
 * `points` kept off `boxes` other than `own` (steerClear), as
 * layoutClustered draws an arrow: with `leads`, the first and last runs
 * (an arrow between frames' straight leads out of and into its boxes) are
 * kept as they are. Exported for the tests; the layout builds its
 * obstacles once per graph.
 */
export function routeAround(
  points: readonly Point[],
  boxes: readonly Box[],
  own: readonly Box[],
  leads: boolean
): Point[] {
  return steerClear(points, obstaclesOf(boxes), new Set(own), leads);
}

/** How far from each bend of a rerouted arrow its curve starts to turn. */
const BEND = 14;

/**
 * The control polygon with a point BEND px from each end of every run
 * longer than two bends: a B-spline runs straight through three points
 * in a line, so the drawn curve then follows each run and rounds only
 * its bends, instead of cutting across the boxes beside a long run.
 */
function hugRuns(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points];
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > BEND * 2) {
      const ux = (b.x - a.x) / length;
      const uy = (b.y - a.y) / length;
      out.push({ x: r(a.x + ux * BEND), y: r(a.y + uy * BEND) });
      out.push({ x: r(b.x - ux * BEND), y: r(b.y - uy * BEND) });
    }
    out.push(b);
  }
  return out;
}

/**
 * Points along the curve basisPath draws through `points`, `per` on each
 * of its pieces: the same cubic pieces, sampled instead of written out.
 */
function basisSamples(points: readonly Point[], per: number): Point[] {
  if (points.length < 3) return [...points];
  const out: Point[] = [points[0]];
  let at: Point = {
    x: (5 * points[0].x + points[1].x) / 6,
    y: (5 * points[0].y + points[1].y) / 6,
  };
  out.push(at);
  const piece = (a: Point, b: Point, c: Point) => {
    const c1 = { x: (2 * a.x + b.x) / 3, y: (2 * a.y + b.y) / 3 };
    const c2 = { x: (a.x + 2 * b.x) / 3, y: (a.y + 2 * b.y) / 3 };
    const to = { x: (a.x + 4 * b.x + c.x) / 6, y: (a.y + 4 * b.y + c.y) / 6 };
    for (let k = 1; k <= per; k += 1) {
      const t = k / per;
      const u = 1 - t;
      const mix = (p0: number, p1: number, p2: number, p3: number) =>
        u * u * u * p0 +
        3 * u * u * t * p1 +
        3 * u * t * t * p2 +
        t * t * t * p3;
      out.push({
        x: mix(at.x, c1.x, c2.x, to.x),
        y: mix(at.y, c1.y, c2.y, to.y),
      });
    }
    at = to;
  };
  for (let i = 2; i < points.length; i += 1) {
    piece(points[i - 2], points[i - 1], points[i]);
  }
  const last = points[points.length - 1];
  piece(points[points.length - 2], last, last);
  out.push(last);
  return out;
}

/** Whether the curve basisPath draws through `points` runs inside an
    obstacle other than `own` (2px in from its edges). */
function curveCrosses(
  points: readonly Point[],
  obstacles: Obstacles,
  own: ReadonlySet<Box>
): boolean {
  return basisSamples(points, 24).some((p) => {
    const cell = cellKey(
      Math.floor(p.x / AVOID_CELL),
      Math.floor(p.y / AVOID_CELL)
    );
    return (obstacles.buckets.get(cell) ?? []).some(
      (box) =>
        !own.has(box) &&
        p.x > box.x + 2 &&
        p.x < box.x + box.width - 2 &&
        p.y > box.y + 2 &&
        p.y < box.y + box.height - 2
    );
  });
}

/**
 * An arrow's control points kept off the boxes it does not join: rerouted
 * round them (avoidObstacles), then, only where the smooth curve through
 * the result would still cut behind a box, eased into straight runs
 * (hugRuns). An arrow with nothing in its way keeps its smooth curve.
 */
function steerClear(
  points: readonly Point[],
  obstacles: Obstacles,
  own: ReadonlySet<Box>,
  leads: boolean
): Point[] {
  const routed = avoidObstacles(points, obstacles, own, leads);
  return curveCrosses(routed, obstacles, own) ? hugRuns(routed) : routed;
}

/**
 * A point on a box's side for an arrow between frames: `out` the side
 * facing along the direction (where a blocker's arrow leaves), `in` the
 * side facing back (where a waiting box's arrow enters); and the point
 * `C.lead` further out, so the curve leaves and enters straight like a
 * dagre route does.
 */
function anchor(
  box: Box,
  end: 'out' | 'in',
  horizontal: boolean
): [Point, Point] {
  const sign = end === 'out' ? 1 : -1;
  if (horizontal) {
    const x = end === 'out' ? box.x + box.width : box.x;
    const y = box.y + box.height / 2;
    return [
      { x: r(x), y: r(y) },
      { x: r(x + sign * C.lead), y: r(y) },
    ];
  }
  const x = box.x + box.width / 2;
  const y = end === 'out' ? box.y + box.height : box.y;
  return [
    { x: r(x), y: r(y) },
    { x: r(x), y: r(y + sign * C.lead) },
  ];
}

/**
 * The points of `middle` that keep a forward arrow moving on along the
 * direction between `first` and `last`; one that would turn it back (a
 * port waypoint behind the lead-out point, say) would kink the curve.
 */
function onward(
  first: Point,
  middle: readonly Point[],
  last: Point,
  horizontal: boolean
): Point[] {
  const along = (p: Point) => (horizontal ? p.x : p.y);
  const kept: Point[] = [];
  let previous = along(first);
  for (const p of middle) {
    if (along(p) > previous && along(p) < along(last)) {
      kept.push(p);
      previous = along(p);
    }
  }
  return kept;
}

/**
 * The clustered layout (GraphLayoutOptions.clusters): frames laid out
 * bottom-up, each over its own items only (layoutFrame), then placed
 * top-down from the margin. An edge between two nodes of one frame keeps
 * its dagre route; one between frames is a curve from its blocker's far
 * side through the route its two frames got in their lowest common
 * frame's run into the waiting node's near side. Nodes come in reading
 * order, frames parents first. Deterministic like layoutGraph.
 */
function layoutClustered(
  nodes: readonly GraphNodeData[],
  edges: readonly GraphEdgeData[],
  direction: GraphDirection,
  clusters: readonly GraphClusterData[]
): GraphLayout {
  const horizontal = direction === 'LR';
  if (nodes.length === 0) {
    return {
      width: 0,
      height: 0,
      direction,
      nodes: [],
      edges: [],
      groups: [],
      clustered: true,
    };
  }
  const { top, frameOf } = frameTree(clusters);
  const measures = new Map<string, NodeMeasure>();
  const home = new Map<string, Frame>();
  const done = new Set<string>();
  for (const node of nodes) {
    if (measures.has(node.id)) continue;
    measures.set(node.id, measureNode(node));
    const frame = frameOf(node.cluster);
    frame.nodes.push(node.id);
    home.set(node.id, frame);
    const state = node.readiness?.state;
    if (state === 'done' || state === 'empty') done.add(node.id);
  }

  // Each kept edge's lowest common frame and link there, plus the ports
  // of every frame it leaves or enters on the way.
  const kept: {
    edge: GraphEdgeData;
    key: string;
    frame: Frame;
    link: string;
    /** The frames it leaves (innermost first) and the item it leaves from. */
    outWay: { frame: Frame; item: string }[];
    /** The frames it enters (innermost first) and the item it enters. */
    inWay: { frame: Frame; item: string }[];
  }[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const fromHome = home.get(edge.from);
    const toHome = home.get(edge.to);
    if (fromHome === undefined || toHome === undefined) continue;
    const key = edgeKey(edge.from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    const common = commonFrame(fromHome, toHome);
    const outWay: { frame: Frame; item: string }[] = [];
    const inWay: { frame: Frame; item: string }[] = [];
    const from = climb(fromHome, edge.from, common, (frame, item) => {
      frame.outs.add(item);
      outWay.push({ frame, item });
    });
    const to = climb(toHome, edge.to, common, (frame, item) => {
      frame.ins.add(item);
      inWay.push({ frame, item });
    });
    const linkKey = `${from}\u0001${to}`;
    const pull = edge.kind === 'risk' || edge.kind === 'cycle' ? 2 : 1;
    const link = common.links.get(linkKey);
    const weight = edge.weight ?? 1;
    if (link === undefined) {
      common.links.set(linkKey, {
        from,
        to,
        pull,
        text:
          isNodeItem(from) && isNodeItem(to) && weight > 1
            ? String(weight)
            : '',
      });
    } else {
      link.pull += pull;
    }
    kept.push({ edge, key, frame: common, link: linkKey, outWay, inWay });
  }

  // Bottom-up sizes (children in cluster order), then top-down places.
  const sizeUp = (frame: Frame): void => {
    frame.children.sort((a, b) => a.index - b.index);
    for (const child of frame.children) sizeUp(child);
    layoutFrame(frame, measures, done, direction);
  };
  sizeUp(top);
  const boxes = new Map<string, { x: number; y: number }>();
  const framed = new Map<Frame, LaidOutGroup>();
  const groups: LaidOutGroup[] = [];
  const order: string[] = [];
  const place = (frame: Frame, originX: number, originY: number): void => {
    frame.originX = originX;
    frame.originY = originY;
    for (const key of frame.sequence) {
      const at = frame.at.get(key) ?? { x: 0, y: 0 };
      const x = originX + at.x;
      const y = originY + at.y;
      if (isNodeItem(key)) {
        const id = key.slice(NODE_ITEM.length);
        boxes.set(id, { x, y });
        order.push(id);
        continue;
      }
      const child = frame.children.find(
        (c) => c.id === key.slice(FRAME_ITEM.length)
      );
      if (child === undefined || child.data === null) continue;
      framed.set(child, {
        id: child.data.id,
        label: child.data.label,
        x,
        y,
        width: child.width,
        height: child.height,
        kind: 'cluster',
        depth: child.depth,
        muted: child.data.muted === true,
        external: child.data.external === true,
      });
      place(child, x + C.padX, y + C.padTop);
    }
  };
  place(top, MARGIN, MARGIN);
  // Frames in cluster order, each before the frames inside it (children
  // are already sorted by cluster order).
  const collect = (frame: Frame): void => {
    for (const child of frame.children) {
      const group = framed.get(child);
      if (group !== undefined) groups.push(group);
      collect(child);
    }
  };
  collect(top);

  const placed: LaidOutNode[] = order.map((id) => {
    const measure = measures.get(id);
    const at = boxes.get(id) ?? { x: 0, y: 0 };
    return {
      id,
      x: at.x,
      y: at.y,
      width: measure?.width ?? 0,
      height: measure?.height ?? 0,
      rank: 0,
      labelLines: measure?.labelLines ?? [''],
      sublabelLine: measure?.sublabelLine ?? '',
    };
  });
  // Ranks: the distinct centres along the direction, numbered.
  const along = (n: LaidOutNode) =>
    Math.round(horizontal ? n.x + n.width / 2 : n.y + n.height / 2);
  const centres = [...new Set(placed.map(along))].sort((a, b) => a - b);
  const rankOf = new Map(centres.map((c, i) => [c, i]));
  for (const n of placed) n.rank = rankOf.get(along(n)) ?? 0;
  const byId = new Map(placed.map((n) => [n.id, n]));

  // A port route's points in page coordinates, held inside the frame's
  // border (2px in from it): a port ranked beyond the content (it is
  // ranked after the whole flow, runFlow) then sits in the frame's padding,
  // so the arrow runs out to it in the port's free lane, clear of the last
  // boxes' corners, and never out through the border or into a neighbour.
  const portWay = (frame: Frame, route: Point[] | null): Point[] => {
    if (route === null || frame.data === null) return [];
    const left = 2 - C.padX;
    const right = frame.width - C.padX - 2;
    const top = 2 - C.padTop;
    const bottom = frame.height - C.padTop - 2;
    return route.map((p) => ({
      x: r(frame.originX + Math.min(right, Math.max(left, p.x))),
      y: r(frame.originY + Math.min(bottom, Math.max(top, p.y))),
    }));
  };
  // Where an arrow crosses a frame's far side (leaving) or near side
  // (entering), 2px inside its border, level with the point beside it.
  // A frame's grid and shelves sit under its flow and are often wider, so
  // an arrow that left its port route straight for the next frame's route
  // cut across them; running out level to the side first keeps it in the
  // flow's lane (when that run passes no box: clearRun).
  const frameSide = (
    frame: Frame,
    end: 'out' | 'in',
    beside: Point
  ): Point | null => {
    if (frame.data === null) return null;
    const left = frame.originX - C.padX + 2;
    const right = frame.originX - C.padX + frame.width - 2;
    const top = frame.originY - C.padTop + 2;
    const bottom = frame.originY - C.padTop + frame.height - 2;
    if (horizontal) {
      return {
        x: r(end === 'out' ? right : left),
        y: r(Math.min(bottom, Math.max(top, beside.y))),
      };
    }
    return {
      x: r(Math.min(right, Math.max(left, beside.x))),
      y: r(end === 'out' ? bottom : top),
    };
  };
  // The straight run from a to b passes no box but the arrow's own two.
  const clearRun = (a: Point, b: Point, own1: Box, own2: Box): boolean =>
    placed.every((n) => {
      if (n === own1 || n === own2) return true;
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      return (
        x1 < n.x - 1 ||
        x0 > n.x + n.width + 1 ||
        y1 < n.y - 1 ||
        y0 > n.y + n.height + 1
      );
    });
  // What an arrow between frames keeps clear of: every box, and each
  // frame title's patch in the canvas colour (drawn over the arrows, it
  // hides them).
  const obstacles = obstaclesOf([
    ...placed,
    ...groups.map((group) => ({
      x: group.x + C.titleX - 3,
      y: group.y + C.titleTop,
      width:
        Math.min(
          Math.max(0, group.width - C.titleX * 2),
          clusterTitleWidth(group.label)
        ) + 6,
      height: C.titleLine,
    })),
  ]);
  const laidEdges: LaidOutEdge[] = [];
  for (const { edge, key, frame, link, outWay, inWay } of kept) {
    const route = frame.routes.get(link);
    const shift = (p: Point): Point => ({
      x: r(p.x + frame.originX),
      y: r(p.y + frame.originY),
    });
    const routed = (route?.points ?? []).map(shift);
    const weight = edge.weight ?? 1;
    const fromBox = byId.get(edge.from);
    const toBox = byId.get(edge.to);
    if (fromBox === undefined || toBox === undefined) continue;
    const exact = home.get(edge.from) === frame && home.get(edge.to) === frame;
    let points: Point[];
    if (exact) {
      // dagre's own route inside one frame; rerouted only where it would
      // run behind a box (a frame's grid sits under its flow).
      points = steerClear(routed, obstacles, new Set([fromBox, toBox]), false);
    } else {
      // A backward arrow (its waiting box lies before its blocker along
      // the direction: a cycle between frames, or shelved frames) leaves
      // the blocker's near side and enters the waiting box's far side, as
      // dagre draws a reversed edge, instead of looping round both boxes.
      const along = (b: Box) =>
        horizontal ? b.x + b.width / 2 : b.y + b.height / 2;
      const backward = along(toBox) < along(fromBox);
      const [start, leave] = anchor(
        fromBox,
        backward ? 'in' : 'out',
        horizontal
      );
      const [end, enter] = anchor(toBox, backward ? 'out' : 'in', horizontal);
      // A forward arrow follows dagre's route to the out port of each frame
      // it leaves (innermost first) and from the in port of each it enters
      // (outermost first), so it passes the other boxes and frames in them
      // instead of cutting straight behind them; the route's end on the
      // item itself is left out (the anchors replace it).
      if (backward) {
        points = [start, leave, ...routed.slice(1, -1), enter, end];
      } else {
        const out: Point[] = [];
        let last = leave;
        for (const { frame: f, item } of outWay) {
          const way = portWay(f, f.ports.get(item)?.out?.slice(1, -1) ?? null);
          out.push(...way);
          last = way.at(-1) ?? last;
          const side = frameSide(f, 'out', last);
          if (side !== null && clearRun(last, side, fromBox, toBox)) {
            out.push(side);
            last = side;
          }
        }
        const into: Point[] = [];
        let next = enter;
        for (const { frame: f, item } of inWay) {
          const way = portWay(f, f.ports.get(item)?.in?.slice(1, -1) ?? null);
          next = way[0] ?? next;
          const side = frameSide(f, 'in', next);
          if (side !== null && clearRun(side, next, fromBox, toBox)) {
            into.unshift(side, ...way);
            next = side;
          } else {
            into.unshift(...way);
          }
        }
        const middle = [...out, ...routed.slice(1, -1), ...into];
        points = [
          start,
          leave,
          ...onward(leave, middle, enter, horizontal),
          enter,
          end,
        ];
      }
      points = steerClear(points, obstacles, new Set([fromBox, toBox]), true);
    }
    if (points.length < 2) continue;
    const tip = points[points.length - 1];
    const before = points[points.length - 2];
    const labelWidth = Math.ceil(
      String(weight).length * M.weightAdvance + M.weightPadX * 2
    );
    let at: Point | null = null;
    if (weight > 1) {
      const labelPoint =
        exact && route?.label !== null && route?.label !== undefined
          ? shift(route.label)
          : points[Math.floor(points.length / 2)];
      at = onCurve(points, labelPoint);
    }
    laidEdges.push({
      key,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      weight,
      points,
      path: basisPath(points),
      arrow: arrowPath(before, tip),
      label:
        at !== null
          ? {
              x: Math.round(at.x - labelWidth / 2),
              y: Math.round(at.y - M.weightHeight / 2),
              width: labelWidth,
              height: M.weightHeight,
            }
          : null,
    });
  }
  laidEdges.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  // The canvas covers everything drawn, plus the margin on the far sides.
  let width = top.width + MARGIN * 2;
  let height = top.height + MARGIN * 2;
  for (const n of placed) {
    width = Math.max(width, n.x + n.width + MARGIN);
    height = Math.max(height, n.y + n.height + MARGIN);
  }
  for (const grp of groups) {
    width = Math.max(width, grp.x + grp.width + MARGIN);
    height = Math.max(height, grp.y + grp.height + MARGIN);
  }
  for (const e of laidEdges) {
    for (const p of e.points) {
      width = Math.max(width, p.x + MARGIN);
      height = Math.max(height, p.y + MARGIN);
    }
  }
  return {
    width: Math.ceil(width),
    height: Math.ceil(height),
    direction,
    nodes: placed,
    edges: laidEdges,
    groups,
    clustered: true,
  };
}
