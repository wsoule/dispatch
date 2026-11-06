import type {
  ELK,
  ElkExtendedEdge,
  ElkNode,
  LayoutOptions,
} from 'elkjs/lib/elk.bundled.js';

interface ChartNodeSpec {
  id: string;
  width: number;
  height: number;
  /** Group box this node sits in, if any. */
  group?: string | null;
}

interface ChartGroupSpec {
  id: string;
  label: string;
}

interface ChartEdgeSpec {
  id: string;
  from: string;
  to: string;
}

/** Nodes in model order (the order they should read in when the layout has a free choice). */
export interface ChartSpec {
  nodes: readonly ChartNodeSpec[];
  edges: readonly ChartEdgeSpec[];
  groups?: readonly ChartGroupSpec[];
}

export interface Point {
  x: number;
  y: number;
}

export interface PlacedBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PlacedGroup extends PlacedBox {
  label: string;
}

interface PlacedEdge {
  id: string;
  from: string;
  to: string;
  /** Orthogonal polyline in root coordinates, start to end. */
  points: Point[];
  /** Midpoint of the polyline's longest segment, where a count label sits. */
  labelAt: Point;
}

export interface ChartLayout {
  nodes: ReadonlyMap<string, PlacedBox>;
  groups: readonly PlacedGroup[];
  edges: readonly PlacedEdge[];
  width: number;
  height: number;
}

export const EMPTY_LAYOUT: ChartLayout = {
  nodes: new Map(),
  groups: [],
  edges: [],
  width: 0,
  height: 0,
};

// Gaps shared by the root and every group box: room between boxes in a column, wider room
// between columns for an edge's bends and count label, and lanes so parallel edges stay apart.
const SPACING: LayoutOptions = {
  'elk.spacing.nodeNode': '18',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.spacing.edgeNode': '12',
  'elk.spacing.edgeEdge': '8',
  'elk.layered.spacing.edgeNodeBetweenLayers': '16',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '8',
};

// Layered left to right with right-angle edges, honouring the caller's node and edge order
// where ELK has a free choice. The two json.* options make ELK report every shape and edge
// point in root coordinates, rather than relative to each box's parent and each edge's
// container, so nothing downstream has to re-add group offsets.
const ROOT_OPTIONS: LayoutOptions = {
  ...SPACING,
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.separateConnectedComponents': 'false',
  'elk.padding': '[top=30,left=30,bottom=30,right=30]',
  'org.eclipse.elk.json.shapeCoords': 'ROOT',
  'org.eclipse.elk.json.edgeCoords': 'ROOT',
};

// Lets edges cross group boxes in one layout pass instead of each group laying out alone.
const GROUPED_ROOT_OPTIONS: LayoutOptions = {
  ...ROOT_OPTIONS,
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
};

// The extra top padding is the group label's band.
const GROUP_OPTIONS: LayoutOptions = {
  ...SPACING,
  'elk.padding': '[top=40,left=14,bottom=14,right=14]',
};

// Enough for flipping between a handful of views (filters, grouping on and off) and back.
const CACHE_LIMIT = 12;

// Points closer than this are one point, so a route never carries a zero-length segment.
const SAME_POINT = 0.01;

// A segment straying less than this from horizontal or vertical is squared onto that axis.
// ELK's jogs at group borders are at most half a pixel; anything further off is left alone.
const SNAP = 1;

/** The spec after input hygiene: every reference resolves, so ELK never sees a dangling id. */
interface CleanSpec {
  nodes: { id: string; width: number; height: number; group: string | null }[];
  edges: ChartEdgeSpec[];
  groups: ChartGroupSpec[];
}

/**
 * Drops what ELK would reject or draw wrong: repeated node ids (first wins), self-loops,
 * edges naming a missing node, and repeated (from, to) pairs (first id wins). A node naming
 * an unknown group sits at the root, and a group no node lands in is left out, so no empty
 * labelled box is drawn.
 */
function cleanSpec(spec: ChartSpec): CleanSpec {
  const labels = new Map<string, string>();
  for (const group of spec.groups ?? []) {
    if (!labels.has(group.id)) labels.set(group.id, group.label);
  }

  const nodes: CleanSpec['nodes'] = [];
  const nodeIds = new Set<string>();
  const usedGroups = new Set<string>();
  for (const node of spec.nodes) {
    if (nodeIds.has(node.id)) continue;
    nodeIds.add(node.id);
    const wanted = node.group ?? null;
    const group = wanted !== null && labels.has(wanted) ? wanted : null;
    if (group !== null) usedGroups.add(group);
    nodes.push({ id: node.id, width: node.width, height: node.height, group });
  }

  const groups: ChartGroupSpec[] = [];
  for (const [id, label] of labels) {
    if (usedGroups.has(id)) groups.push({ id, label });
  }

  const edges: ChartEdgeSpec[] = [];
  const pairs = new Set<string>();
  for (const edge of spec.edges) {
    if (edge.from === edge.to) continue;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    const pair = `${edge.from}\u0000${edge.to}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    edges.push({ id: edge.id, from: edge.from, to: edge.to });
  }
  return { nodes, edges, groups };
}

// Everything in the cleaned spec that reaches the output, so equal keys mean equal layouts.
function cacheKey(spec: CleanSpec): string {
  return JSON.stringify([
    spec.nodes.map((n) => [n.id, n.width, n.height, n.group]),
    spec.edges.map((e) => [e.id, e.from, e.to]),
    spec.groups.map((g) => [g.id, g.label]),
  ]);
}

/**
 * The ELK graph for a cleaned spec. ELK ids are positional (`n3`, `g1`, `e7`) rather than
 * the caller's, so a node and a group sharing an id, or a node called `root`, cannot collide
 * inside ELK; `readLayout` maps them back by the same positions. A group joins the root's
 * children where its first node appears, keeping the model order the caller gave.
 */
function toElkGraph(spec: CleanSpec): ElkNode {
  const groupIndex = new Map(spec.groups.map((g, i) => [g.id, i]));
  const members: ElkNode[][] = spec.groups.map(() => []);
  const nodeIndex = new Map<string, number>();
  const children: ElkNode[] = [];

  spec.nodes.forEach((node, i) => {
    nodeIndex.set(node.id, i);
    const box: ElkNode = {
      id: `n${i}`,
      width: node.width,
      height: node.height,
    };
    const g = node.group === null ? undefined : groupIndex.get(node.group);
    if (g === undefined) {
      children.push(box);
      return;
    }
    if (members[g].length === 0) {
      children.push({
        id: `g${g}`,
        layoutOptions: GROUP_OPTIONS,
        children: members[g],
      });
    }
    members[g].push(box);
  });

  const edges: ElkExtendedEdge[] = spec.edges.map((edge, i) => ({
    id: `e${i}`,
    sources: [`n${nodeIndex.get(edge.from)}`],
    targets: [`n${nodeIndex.get(edge.to)}`],
  }));

  return {
    id: 'root',
    layoutOptions: spec.groups.length > 0 ? GROUPED_ROOT_OPTIONS : ROOT_OPTIONS,
    children,
    edges,
  };
}

type Axis = 'horizontal' | 'vertical';

// Which axis the segment a-b runs along, or null when it is too far off both to square.
function axisOf(a: Point, b: Point): Axis | null {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  if (dy <= SNAP && dy <= dx) return 'horizontal';
  if (dx <= SNAP && dx < dy) return 'vertical';
  return null;
}

// True when b sits on the straight line from a to c and the line carries on past b in the
// same direction, so b is not a bend and can be dropped.
function passesStraightThrough(a: Point, b: Point, c: Point): boolean {
  if (a.y === b.y && b.y === c.y) return (b.x - a.x) * (c.x - b.x) > 0;
  if (a.x === b.x && b.x === c.x) return (b.y - a.y) * (c.y - b.y) > 0;
  return false;
}

/**
 * Squares a route onto exact horizontals and verticals. With groups, ELK routes an edge in
 * pieces, one per box it crosses, and joins them at each group border with a jog of up to
 * half a pixel, so a run that reads as one horizontal line drifts between its points (and
 * float noise leaves 104.00000000000003 beside 104). Each maximal run of near-horizontal
 * segments is put on one y and each near-vertical run on one x; a run takes that coordinate
 * from the route's first or last point when it holds one, so endpoints stay on their boxes.
 * Points a straight run no longer bends at are then dropped, so the longest segment (where
 * the count label sits) is the longest line actually drawn.
 */
function squareRoute(route: readonly Point[]): Point[] {
  const points = route.map((p) => ({ x: p.x, y: p.y }));
  const last = points.length - 1;
  const axes = points.slice(1).map((p, i) => axisOf(points[i], p));

  let start = 0;
  while (start < last) {
    const axis = axes[start];
    let end = start + 1;
    while (end < last && axes[end] === axis) end++;
    if (axis !== null) {
      const key = axis === 'horizontal' ? 'y' : 'x';
      const value =
        start === 0
          ? points[0][key]
          : end === last
            ? points[last][key]
            : points[start][key];
      for (let i = start; i <= end; i++) points[i][key] = value;
    }
    start = end;
  }

  const squared: Point[] = [];
  for (const p of points) {
    const n = squared.length;
    const prev = n > 0 ? squared[n - 1] : null;
    if (prev !== null && prev.x === p.x && prev.y === p.y) continue;
    if (n >= 2 && passesStraightThrough(squared[n - 2], squared[n - 1], p)) {
      squared[n - 1] = p;
      continue;
    }
    squared.push(p);
  }
  return squared;
}

// An ELK edge's route as one polyline: its sections joined start to end, repeats dropped.
function edgePoints(edge: ElkExtendedEdge): Point[] {
  const points: Point[] = [];
  for (const section of edge.sections ?? []) {
    const route = [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ];
    for (const p of route) {
      const last = points.length > 0 ? points[points.length - 1] : null;
      if (
        last !== null &&
        Math.abs(last.x - p.x) < SAME_POINT &&
        Math.abs(last.y - p.y) < SAME_POINT
      ) {
        continue;
      }
      points.push({ x: p.x, y: p.y });
    }
  }
  return points;
}

// Where an edge's count label sits: the middle of its longest run, the first on a tie.
function longestSegmentMidpoint(points: readonly Point[]): Point {
  let best = -1;
  let at = points[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > best) {
      best = length;
      at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return { x: at.x, y: at.y };
}

/**
 * Turns ELK's laid-out graph back into the caller's ids. Shapes and edges are collected from
 * the whole tree (ELK may file an edge under the group that contains it) and then read in
 * the cleaned spec's order, so `nodes`, `groups` and `edges` keep model order. Coordinates
 * are already root-relative (see `ROOT_OPTIONS`); routes are squared (see `squareRoute`).
 * An edge ELK returned no route for is left out rather than drawn as a guess.
 */
function readLayout(spec: CleanSpec, root: ElkNode): ChartLayout {
  const shapes = new Map<string, ElkNode>();
  const routes = new Map<string, ElkExtendedEdge>();
  const walk = (node: ElkNode): void => {
    for (const edge of node.edges ?? []) routes.set(edge.id, edge);
    for (const child of node.children ?? []) {
      shapes.set(child.id, child);
      walk(child);
    }
  };
  walk(root);

  const boxOf = (elkId: string, id: string): PlacedBox => {
    const shape = shapes.get(elkId);
    return {
      id,
      x: shape?.x ?? 0,
      y: shape?.y ?? 0,
      width: shape?.width ?? 0,
      height: shape?.height ?? 0,
    };
  };

  const nodes = new Map<string, PlacedBox>();
  spec.nodes.forEach((node, i) => {
    nodes.set(node.id, boxOf(`n${i}`, node.id));
  });

  const groups: PlacedGroup[] = spec.groups.map((group, i) => ({
    ...boxOf(`g${i}`, group.id),
    label: group.label,
  }));

  const edges: PlacedEdge[] = [];
  spec.edges.forEach((edge, i) => {
    const route = routes.get(`e${i}`);
    const points = route === undefined ? [] : squareRoute(edgePoints(route));
    if (points.length < 2) return;
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      points,
      labelAt: longestSegmentMidpoint(points),
    });
  });

  return {
    nodes,
    groups,
    edges,
    width: root.width ?? 0,
    height: root.height ?? 0,
  };
}

let engine: Promise<ELK> | null = null;

/**
 * The one shared ELK instance, imported on first use so the ~1.5MB engine is its own chunk
 * and the app only pays for it when a chart renders. The bundled build runs ELK in-thread
 * (no Web Worker). Its CommonJS export arrives as the namespace's `default` under both Vite
 * and Bun. A failed import, such as a chunk that did not load, is forgotten so the next
 * layout tries again.
 */
function loadEngine(): Promise<ELK> {
  if (engine === null) {
    const pending = import('elkjs/lib/elk.bundled.js').then(
      (mod) => new mod.default()
    );
    pending.catch(() => {
      if (engine === pending) engine = null;
    });
    engine = pending;
  }
  return engine;
}

// Most recently used last; Map keeps insertion order, so the first key is the stalest.
const cache = new Map<string, Promise<ChartLayout>>();

/**
 * Lays the chart out left to right with elkjs (lazy-loaded once via dynamic
 * import('elkjs/lib/elk.bundled.js'), so the ~1.5MB engine is its own chunk and only loads
 * when a chart first renders). Results are cached by the spec's content (a small LRU, ~12
 * entries) so toggling back to a previous view is instant.
 *
 * The cache holds the pending promise, so identical specs requested together share one
 * layout run and resolve to the same object; a run that fails is evicted so it can be retried.
 */
export function layoutChart(spec: ChartSpec): Promise<ChartLayout> {
  const clean = cleanSpec(spec);
  if (clean.nodes.length === 0) return Promise.resolve(EMPTY_LAYOUT);

  const key = cacheKey(clean);
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const pending = loadEngine()
    .then((elk) => elk.layout(toElkGraph(clean)))
    .then((root) => readLayout(clean, root));
  cache.set(key, pending);
  if (cache.size > CACHE_LIMIT) {
    const stalest = cache.keys().next();
    if (stalest.done !== true) cache.delete(stalest.value);
  }
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

// Two decimals is finer than a device pixel and keeps long path strings out of the DOM.
function coord(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * SVG path data for an orthogonal polyline with corners rounded by 'radius' (default 6), each
 * corner's radius capped at half of either adjacent segment (port the reference template's
 * pathOf). One or two points → straight 'M..L..'.
 *
 * Each interior corner becomes a line to `radius` short of the corner and a quadratic curve,
 * controlled by the corner itself, to `radius` past it. The half-segment cap keeps two
 * corners on one short segment from overlapping; a zero radius leaves the corner sharp.
 */
export function roundedPath(points: readonly Point[], radius = 6): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  let d = `M${coord(first.x)} ${coord(first.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const p = points[i];
    const next = points[i + 1];
    const inLength = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLength = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (!(r > 0)) {
      d += `L${coord(p.x)} ${coord(p.y)}`;
      continue;
    }
    const ax = p.x - ((p.x - prev.x) / inLength) * r;
    const ay = p.y - ((p.y - prev.y) / inLength) * r;
    const bx = p.x + ((next.x - p.x) / outLength) * r;
    const by = p.y + ((next.y - p.y) / outLength) * r;
    d += `L${coord(ax)} ${coord(ay)}Q${coord(p.x)} ${coord(p.y)} ${coord(bx)} ${coord(by)}`;
  }
  return `${d}L${coord(last.x)} ${coord(last.y)}`;
}
