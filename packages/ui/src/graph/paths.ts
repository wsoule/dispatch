import {
  type BlockerIndex,
  blockerIndex,
  type DownstreamChain,
  downstreamChain,
  upstreamChain,
  waiterIndex,
} from './chain';
import { edgeKey } from './layout';
import type {
  GraphEdgeData,
  GraphHighlight,
  GraphNodeReadiness,
  GraphPathWords,
  UpstreamChain,
} from './types';

// The path walks behind the graph highlights (architecture §2.10, §8.4
// Graph): for one node, what it waits on (upstream), what it holds up
// (downstream), where to start, what finishing it alone would free; for
// the whole drawing, the critical path (the longest chain of blocking
// edges, a cycle counted as one step). Everything here is pure and works
// over what is drawn: the nodes given and the edges between them. The
// host's readiness facts (counted over all of its data, not only the
// drawn part) come in as plain values on each node, and the difference
// between the two is what the copy calls "not drawn".

/** A node as the path walks read it. GraphNodeData fits as it is. */
export interface PathNode {
  id: string;
  /** The name: a milestone or issue title. */
  label: string;
  /** A short identifier ("ENG-23"); copy names the node by it when set. */
  key?: string;
  /** Human wording of its status ("Done"); the readout's word for done. */
  statusLabel?: string;
  /** The host's readiness facts; without them the walks use drawn edges. */
  readiness?: GraphNodeReadiness;
}

/**
 * The default readout words. `{n}`, `{names}`, `{k}`, `{s}` and `{unit}`
 * are filled in; a host replaces any entry through `pathWords`.
 */
export const defaultGraphPathWords: GraphPathWords = {
  unit: ['box', 'boxes'],
  waitsOn: 'Waits on {n} open',
  startWith: 'start with {names}',
  waitsOnNone: 'Nothing open blocks it',
  waitsOnOutside: 'Waits on {n} outside this graph',
  startsOutside: 'it starts outside this graph',
  selfLoop: 'Blocks itself',
  blockersDone: 'Blockers done: {names}',
  holdsUp: 'Holds up {n}',
  holdsUpNone: 'Nothing here waits on it',
  unblock: 'Done would unblock {n}: {names}',
  next: 'Ready next',
  notDrawn: '{n} not drawn',
  done: 'Done',
  empty: 'No issues',
  noLongerBlocks: 'No longer blocks {names}',
  step: 'Step {k} of {s}',
  through: 'Longest chain through it: {n} {unit}: {names}',
  offChain: 'Not on an open chain',
  locked: 'Locked on',
  unlocked: 'Unlocked',
  open: 'Open',
  openGraph: 'Open graph',
  openItsGraph: 'Open its graph',
  unlock: 'Unlock',
  hint: 'Point at or focus a box to trace what it waits on and holds up; click it to lock the trace.',
  tapHint:
    'Tap a box to lock the trace of what it waits on and holds up; tap it again to open it.',
  hintCritical:
    'Point at or focus a box to show the longest chain through it; click it to lock it.',
  tapHintCritical:
    'Tap a box to lock the longest chain through it; tap it again to open it.',
  more: '+{n} more',
};

/** Names listed in copy before "+k more". */
export const PATH_NAME_CAP = 3;

/** Chain steps listed in copy before "…" and the last step. */
export const PATH_GROUP_CAP = 6;

/** Longest label a name in copy keeps before it is cut with "…". */
const NAME_CLIP = 32;

/**
 * Most walk steps (`V × (V + E)`, V the drawn nodes on a blocking edge:
 * a node on none walks nothing) the accessible names may spend on
 * transitive counts; above it they fall back to direct counts, so a host
 * with no draw limit never runs a quadratic walk in render (architecture
 * §8.4 Graph).
 */
export const PATH_NAME_BUDGET = 250_000;

/** One blocking drawn edge, as the critical path keeps it. */
export interface ChainEdge {
  /** `${from}->${to}`, as edgeKey builds it. */
  key: string;
  from: string;
  to: string;
}

/**
 * Every node's place on the longest chains of blocking drawn edges
 * (longestChains). Groups are the strongly connected components (a node,
 * or a whole cycle) in topological order: every group comes after the
 * groups that block it. The per-group arrays are indexed like `groups`.
 */
export interface LongestChains {
  /** Step groups, members in node order. */
  groups: readonly (readonly string[])[];
  /** Node id → its group. */
  groupOf: ReadonlyMap<string, number>;
  /** Nodes on the longest chain ending at the group, the group included. */
  depth: readonly number[];
  /** Nodes on the longest chain starting at the group, the group included. */
  height: readonly number[];
  /** The group before it on its longest chain in (null: it starts one). */
  prev: readonly (number | null)[];
  /** The group after it on its longest chain out (null: it ends one). */
  next: readonly (number | null)[];
  /** The first edge (input order) from `prev` into the group. */
  prevEdge: readonly (ChainEdge | null)[];
  /** The first edge (input order) from the group into `next`. */
  nextEdge: readonly (ChainEdge | null)[];
  /** Blocking drawn edges with both ends in the group, in input order. */
  inner: readonly (readonly ChainEdge[])[];
  /** A cycle: two or more members, or one with a blocking self-loop. */
  cyclic: readonly boolean[];
  /** The group the graph-wide longest chain ends at; null when empty. */
  end: number | null;
}

/** One chain of blocking edges, as shown (the critical path). */
export interface OpenChain {
  /** Blocker first; a cycle's members together, in node order. */
  nodeIds: string[];
  /** Node id → 1-based step (a cycle's members share one). */
  steps: ReadonlyMap<string, number>;
  /** Number of steps (groups). */
  stepCount: number;
  /** Open nodes on it (every cycle member counts). */
  length: number;
  edgeKeys: ReadonlySet<string>;
  /** Its edges in path order, each group's inner edges first. */
  edges: readonly { from: string; to: string }[];
  /** The groups, for copy ("ENG-70 + ENG-71 → ENG-72"). */
  groups: readonly (readonly string[])[];
  /** It holds a group of two or more, or a node that blocks itself. */
  throughCycle: boolean;
}

/**
 * The drawn graph indexed once per node and edge list, for nodePaths,
 * describePaths, pathNameCounts and the critical path.
 */
export interface PathContext<N extends PathNode = PathNode> {
  /** Drawn nodes by id; the first of a repeated id wins (layoutGraph's rule). */
  nodes: ReadonlyMap<string, N>;
  /** Their ids in input (display) order. */
  order: readonly string[];
  /**
   * Blocking drawn edges: both ends drawn, the first of a repeated
   * blocker → waiting pair (layoutGraph's rule), and not resolved.
   */
  blocking: readonly GraphEdgeData[];
  /** Resolved drawn edges: one end is done, so it no longer blocks. */
  resolved: readonly GraphEdgeData[];
  /** Blocking drawn edges by waiting node (their count: the in-degree). */
  blockers: BlockerIndex;
  /** Blocking drawn edges by blocker (their count: the out-degree). */
  waiters: BlockerIndex;
  /** Resolved drawn edges by waiting node. */
  resolvedBlockers: BlockerIndex;
  /** Resolved drawn edges by blocker. */
  resolvedWaiters: BlockerIndex;
  chains: LongestChains;
}

/** Both paths of one node and what the readout says about them. */
export interface NodePaths {
  id: string;
  /** What it transitively waits on, nearest first. */
  upstream: UpstreamChain;
  /** What transitively waits on it, nearest first. */
  downstream: DownstreamChain;
  /** Upstream nodes, drawn "lit". A cycle partner of `id` is one. */
  upIds: ReadonlySet<string>;
  /** Downstream nodes that are not upstream too, drawn "down". */
  downIds: ReadonlySet<string>;
  /** Edges walked upstream, drawn as the upstream path. */
  upEdgeKeys: ReadonlySet<string>;
  /** Edges walked downstream only, drawn as the downstream path. */
  downEdgeKeys: ReadonlySet<string>;
  /** Upstream nodes where work can start now, in upstream order. */
  startWith: string[];
  /**
   * No upstream node can start, but the subject or an upstream node has
   * a blocker that is not drawn: the chain starts outside the graph.
   */
  startsOutside: boolean;
  /** Drawn nodes that finishing `id` alone would unblock ("Ready next"). */
  next: string[];
  /** Open blockers of `id` the host counts but the graph does not draw. */
  blockersNotDrawn: number;
  /** What finishing `id` would unblock that the graph does not draw. */
  unblocksNotDrawn: number;
  /** Drawn ends of its resolved in-edges, for an open subject only. */
  blockersDone: string[];
  /** Drawn ends of its resolved out-edges. */
  noLongerBlocks: string[];
  /** It has a blocking self-loop. */
  selfLoop: boolean;
}

/** The readout line: the subject's name, then its parts (joined by " · "). */
export interface PathReadout {
  subject: string;
  parts: string[];
}

/** How many nodes an accessible name says a node waits on and holds up. */
export interface PathNameCounts {
  /**
   * True: `waitsOn` and `holdsUp` are transitive (the drawn graph is
   * within PATH_NAME_BUDGET). False: direct blocking in- and out-edges.
   */
  transitive: boolean;
  waitsOn: number;
  holdsUp: number;
  /** Done would unblock this many (the host's count when it gives one). */
  unblocks: number;
  /**
   * The host counts something about the node that is not drawn: an open
   * blocker beyond its drawn in-edges, or a node finishing it would
   * unblock. The name then scopes its counts to the drawn graph, so
   * "holds up 0" never sits beside "done would unblock 1" unexplained.
   */
  outside?: boolean;
  /** Of `unblocks`, the ones not drawn. */
  unblocksNotDrawn?: number;
}

/* ---- the drawn graph -------------------------------------------------------- */

/**
 * The edges the graph draws: both ends among the drawn nodes, and the
 * first of a repeated blocker → waiting pair (the rule layoutGraph uses,
 * so the walks see exactly what is on screen).
 */
function drawnEdges(
  nodes: ReadonlyMap<string, unknown>,
  edges: readonly GraphEdgeData[]
): GraphEdgeData[] {
  const kept: GraphEdgeData[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const key = edgeKey(edge.from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(edge);
  }
  return kept;
}

/** Nodes by id, the first of a repeated id winning, plus their order. */
function nodeMap<N extends { id: string }>(
  nodes: readonly N[]
): { byId: Map<string, N>; order: string[] } {
  const byId = new Map<string, N>();
  const order: string[] = [];
  for (const node of nodes) {
    if (byId.has(node.id)) continue;
    byId.set(node.id, node);
    order.push(node.id);
  }
  return { byId, order };
}

/**
 * Indexes the drawn graph once: the drawn edges split into blocking and
 * resolved, both indexed each way, and the critical-path facts. O(V + E).
 */
export function pathContext<N extends PathNode>(
  nodes: readonly N[],
  edges: readonly GraphEdgeData[]
): PathContext<N> {
  const { byId, order } = nodeMap(nodes);
  const drawn = drawnEdges(byId, edges);
  const blocking = drawn.filter((edge) => edge.kind !== 'resolved');
  const resolved = drawn.filter((edge) => edge.kind === 'resolved');
  const all = { includeResolved: true };
  return {
    nodes: byId,
    order,
    blocking,
    resolved,
    blockers: blockerIndex(blocking),
    waiters: waiterIndex(blocking),
    resolvedBlockers: blockerIndex(resolved, all),
    resolvedWaiters: waiterIndex(resolved, all),
    chains: chainsOf(order, blocking),
  };
}

/* ---- one node's paths --------------------------------------------------------- */

/** Blocking drawn edges into `id` (a self-loop counts). */
function blockingIn(ctx: PathContext, id: string): number {
  return ctx.blockers.get(id)?.length ?? 0;
}

/** Open blockers of `id` the host counts beyond the drawn in-edges. */
function blockersNotDrawnOf(ctx: PathContext, id: string): number {
  const readiness = ctx.nodes.get(id)?.readiness;
  if (readiness === undefined) return 0;
  return Math.max(0, readiness.blockedBy - blockingIn(ctx, id));
}

/**
 * Whether work can start at `id` now: ready by the host's facts (and not
 * a box where nothing can start), or, without them, no blocking drawn
 * edge into it.
 */
function canStartAt(ctx: PathContext, id: string): boolean {
  const readiness = ctx.nodes.get(id)?.readiness;
  if (readiness === undefined) return blockingIn(ctx, id) === 0;
  return readiness.state === 'ready' && readiness.canStart !== false;
}

/**
 * The drawn nodes finishing `id` alone would unblock: every other open
 * target of a blocking edge from `id` whose only open blocker that edge
 * is (the host's `blockedBy`, else its blocking drawn in-degree, is 1).
 * In edge order.
 */
function nextOf(ctx: PathContext, id: string): string[] {
  const next: string[] = [];
  for (const edge of ctx.waiters.get(id) ?? []) {
    const target = edge.to;
    if (target === id) continue;
    const readiness = ctx.nodes.get(target)?.readiness;
    if (readiness?.state === 'done' || readiness?.state === 'empty') continue;
    const blockers = readiness?.blockedBy ?? blockingIn(ctx, target);
    if (blockers === 1) next.push(target);
  }
  return next;
}

/** "Done would unblock K": the drawn ones plus any the host counts beyond. */
function unblockCount(ctx: PathContext, id: string, drawn: number): number {
  const readiness = ctx.nodes.get(id)?.readiness;
  return readiness === undefined ? drawn : Math.max(readiness.unblocks, drawn);
}

/** The other ends of `id`'s edges in `index`, never `id` itself. */
function otherEnds(
  index: BlockerIndex,
  id: string,
  end: 'from' | 'to'
): string[] {
  const ends: string[] = [];
  for (const edge of index.get(id) ?? []) {
    if (edge[end] !== id) ends.push(edge[end]);
  }
  return ends;
}

/**
 * Both paths of `id` over the drawn graph and every fact the readout and
 * the "Ready next" tags need; null when `id` is not drawn. O(V + E).
 */
export function nodePaths(id: string, ctx: PathContext): NodePaths | null {
  const node = ctx.nodes.get(id);
  if (node === undefined) return null;
  const upstream = upstreamChain(id, ctx.blockers);
  const downstream = downstreamChain(id, ctx.waiters);
  const upIds = new Set(upstream.nodeIds);
  const downIds = new Set(downstream.nodeIds.filter((n) => !upIds.has(n)));
  const downEdgeKeys = new Set<string>();
  for (const key of downstream.edgeKeys) {
    if (!upstream.edgeKeys.has(key)) downEdgeKeys.add(key);
  }
  const startWith = upstream.nodeIds.filter((n) => canStartAt(ctx, n));
  const blockersNotDrawn = blockersNotDrawnOf(ctx, id);
  const startsOutside =
    startWith.length === 0 &&
    (blockersNotDrawn > 0 ||
      upstream.nodeIds.some((n) => blockersNotDrawnOf(ctx, n) > 0));
  const next = nextOf(ctx, id);
  const unblocksNotDrawn = unblockCount(ctx, id, next.length) - next.length;
  // After a done waiting end turns an edge resolved, a done node's
  // resolved in-edge may come from an open blocker: "Blockers done" is
  // only true of an open subject. Without readiness, resolved always
  // means the blocker is closed.
  const closed =
    node.readiness?.state === 'done' || node.readiness?.state === 'empty';
  const blockersDone = closed
    ? []
    : otherEnds(ctx.resolvedBlockers, id, 'from');
  return {
    id,
    upstream,
    downstream,
    upIds,
    downIds,
    upEdgeKeys: upstream.edgeKeys,
    downEdgeKeys,
    startWith,
    startsOutside,
    next,
    blockersNotDrawn,
    unblocksNotDrawn,
    blockersDone,
    noLongerBlocks: otherEnds(ctx.resolvedWaiters, id, 'to'),
    selfLoop: (ctx.blockers.get(id) ?? []).some((edge) => edge.from === id),
  };
}

/* ---- the critical path ---------------------------------------------------------- */

/**
 * Tarjan's strongly connected components over node indexes 0…n−1, with
 * successors in edge order, iteratively (a 150-issue chain must not
 * overflow the call stack). Emits sinks first; members are sorted. The
 * same algorithm as core's stronglyConnectedComponents, which this
 * portable package cannot import.
 */
function tarjan(n: number, successors: readonly (readonly number[])[]) {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const cursor = new Int32Array(n);
  const stack: number[] = [];
  const calls: number[] = [];
  const groups: number[][] = [];
  let counter = 0;
  const enter = (v: number) => {
    index[v] = counter;
    low[v] = counter;
    counter += 1;
    stack.push(v);
    onStack[v] = 1;
    calls.push(v);
  };
  for (let root = 0; root < n; root += 1) {
    if (index[root] !== -1) continue;
    enter(root);
    while (calls.length > 0) {
      const v = calls[calls.length - 1];
      const out = successors[v];
      if (cursor[v] < out.length) {
        const w = out[cursor[v]];
        cursor[v] += 1;
        if (index[w] === -1) enter(w);
        else if (onStack[w] === 1) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      calls.pop();
      if (calls.length > 0) {
        const parent = calls[calls.length - 1];
        low[parent] = Math.min(low[parent], low[v]);
      }
      if (low[v] !== index[v]) continue;
      const group: number[] = [];
      let w: number;
      do {
        w = stack.pop() ?? v;
        onStack[w] = 0;
        group.push(w);
      } while (w !== v);
      groups.push(group.sort((a, b) => a - b));
    }
  }
  return groups;
}

/**
 * The strongly connected components of `edges` over `nodeIds` (edges
 * with an end outside `nodeIds` are ignored; pass blocking edges only),
 * members in node order, every group after the groups that point into it.
 */
export function sccGroups(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[]
): string[][] {
  const { order } = nodeMap(nodeIds.map((id) => ({ id })));
  const at = new Map(order.map((id, i) => [id, i]));
  const successors: number[][] = order.map(() => []);
  for (const edge of edges) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from !== undefined && to !== undefined) successors[from].push(to);
  }
  return tarjan(order.length, successors)
    .reverse()
    .map((group) => group.map((i) => order[i]));
}

/**
 * The critical-path facts over `order` and its blocking edges (already
 * drawn and deduplicated): cycles condensed into weighted step groups,
 * then the longest chain into and out of every group, ties going to the
 * group whose first member comes first. O(V + E).
 */
function chainsOf(
  order: readonly string[],
  blocking: readonly GraphEdgeData[]
): LongestChains {
  const at = new Map(order.map((id, i) => [id, i]));
  const links: { edge: ChainEdge; from: number; to: number }[] = [];
  const successors: number[][] = order.map(() => []);
  const selfLoop = new Uint8Array(order.length);
  for (const { from, to } of blocking) {
    const u = at.get(from);
    const v = at.get(to);
    if (u === undefined || v === undefined) continue;
    links.push({ edge: { key: edgeKey(from, to), from, to }, from: u, to: v });
    if (u === v) selfLoop[u] = 1;
    else successors[u].push(v);
  }
  // Tarjan emits sinks first, so the reverse is topological.
  const members = tarjan(order.length, successors).reverse();
  const count = members.length;
  const groupOfIndex = new Int32Array(order.length);
  members.forEach((group, g) => {
    for (const i of group) groupOfIndex[i] = g;
  });
  const first = members.map((group) => group[0]);
  const ins: ChainEdge[][] = members.map(() => []);
  const outs: ChainEdge[][] = members.map(() => []);
  const inner: ChainEdge[][] = members.map(() => []);
  const insFrom: number[][] = members.map(() => []);
  const outsTo: number[][] = members.map(() => []);
  for (const link of links) {
    const a = groupOfIndex[link.from];
    const b = groupOfIndex[link.to];
    if (a === b) {
      inner[a].push(link.edge);
      continue;
    }
    outs[a].push(link.edge);
    outsTo[a].push(b);
    ins[b].push(link.edge);
    insFrom[b].push(a);
  }

  /**
   * The best neighbour group by `score` (higher wins, then the earlier
   * first member), with the first edge in input order that reaches it.
   */
  const best = (
    groups: readonly number[],
    edges: readonly ChainEdge[],
    score: readonly number[]
  ): { group: number | null; edge: ChainEdge | null; score: number } => {
    let group: number | null = null;
    let edge: ChainEdge | null = null;
    let top = 0;
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i];
      if (
        group === null ||
        score[g] > top ||
        (score[g] === top && first[g] < first[group])
      ) {
        group = g;
        edge = edges[i];
        top = score[g];
      }
    }
    return { group, edge, score: top };
  };

  const depth = new Array<number>(count).fill(0);
  const height = new Array<number>(count).fill(0);
  const prev = new Array<number | null>(count).fill(null);
  const next = new Array<number | null>(count).fill(null);
  const prevEdge = new Array<ChainEdge | null>(count).fill(null);
  const nextEdge = new Array<ChainEdge | null>(count).fill(null);
  for (let g = 0; g < count; g += 1) {
    const pick = best(insFrom[g], ins[g], depth);
    depth[g] = members[g].length + pick.score;
    prev[g] = pick.group;
    prevEdge[g] = pick.edge;
  }
  for (let g = count - 1; g >= 0; g -= 1) {
    const pick = best(outsTo[g], outs[g], height);
    height[g] = members[g].length + pick.score;
    next[g] = pick.group;
    nextEdge[g] = pick.edge;
  }
  let end: number | null = null;
  for (let g = 0; g < count; g += 1) {
    if (
      end === null ||
      depth[g] > depth[end] ||
      (depth[g] === depth[end] && first[g] < first[end])
    ) {
      end = g;
    }
  }
  const groupOf = new Map<string, number>();
  members.forEach((group, g) => {
    for (const i of group) groupOf.set(order[i], g);
  });
  return {
    groups: members.map((group) => group.map((i) => order[i])),
    groupOf,
    depth,
    height,
    prev,
    next,
    prevEdge,
    nextEdge,
    inner,
    cyclic: members.map(
      (group) => group.length > 1 || selfLoop[group[0]] === 1
    ),
    end,
  };
}

/**
 * Every node's place on the longest chains of blocking edges among
 * `nodes` (resolved edges, edges to undrawn nodes and repeated pairs left
 * out, as drawn). A cycle is one step group weighted by its member count.
 */
export function longestChains(
  nodes: readonly { id: string }[],
  edges: readonly GraphEdgeData[]
): LongestChains {
  const { byId, order } = nodeMap(nodes);
  const blocking = drawnEdges(byId, edges).filter(
    (edge) => edge.kind !== 'resolved'
  );
  return chainsOf(order, blocking);
}

/**
 * The graph-wide critical path (the longest chain, ending at the deepest
 * group), or with `throughId` the longest chain through that node: the
 * longest chain into its group joined to the longest one out. Null when
 * it holds fewer than 2 nodes, or `throughId` is not drawn.
 */
export function longestChain(
  chains: LongestChains,
  throughId: string | null = null
): OpenChain | null {
  const at =
    throughId === null ? chains.end : (chains.groupOf.get(throughId) ?? null);
  if (at === null) return null;
  const back: number[] = [];
  for (let g = chains.prev[at]; g !== null; g = chains.prev[g]) back.push(g);
  const path = back.reverse();
  const pivot = path.length;
  path.push(at);
  if (throughId !== null) {
    for (let g = chains.next[at]; g !== null; g = chains.next[g]) path.push(g);
  }
  let length = 0;
  for (const g of path) length += chains.groups[g].length;
  if (length < 2) return null;

  const nodeIds: string[] = [];
  const steps = new Map<string, number>();
  const edges: ChainEdge[] = [];
  path.forEach((g, i) => {
    for (const id of chains.groups[g]) {
      nodeIds.push(id);
      steps.set(id, i + 1);
    }
    edges.push(...chains.inner[g]);
    if (i + 1 >= path.length) return;
    // Before the pivot the path was found walking back (prev links),
    // from it on walking forward (next links).
    const link = i < pivot ? chains.prevEdge[path[i + 1]] : chains.nextEdge[g];
    if (link !== null) edges.push(link);
  });
  return {
    nodeIds,
    steps,
    stepCount: path.length,
    length,
    edgeKeys: new Set(edges.map((edge) => edge.key)),
    edges: edges.map(({ from, to }) => ({ from, to })),
    groups: path.map((g) => chains.groups[g]),
    throughCycle: path.some((g) => chains.cyclic[g]),
  };
}

/* ---- copy ----------------------------------------------------------------------- */

/** The default words with the host's overrides (undefined ones ignored). */
export function resolvePathWords(
  words: Partial<GraphPathWords> = {}
): GraphPathWords {
  const given: Partial<GraphPathWords> = {};
  for (const [name, value] of Object.entries(words)) {
    if (value !== undefined) Object.assign(given, { [name]: value });
  }
  return { ...defaultGraphPathWords, ...given };
}

/** Fills `{name}` placeholders; unknown ones are left as written. */
function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match
  );
}

/** "box" or "boxes" for `n`. */
function unitWord(words: GraphPathWords, n: number): string {
  return words.unit[n === 1 ? 0 : 1];
}

/** A node's name in copy: its key, else its label cut to 32 characters. */
export function pathNodeName(node: PathNode): string {
  if (node.key !== undefined && node.key !== '') return node.key;
  if (node.label.length <= NAME_CLIP) return node.label;
  return `${node.label.slice(0, NAME_CLIP - 1).trimEnd()}…`;
}

/** "A, B, C +2 more": at most PATH_NAME_CAP names. */
export function nameList(
  names: readonly string[],
  words: Pick<GraphPathWords, 'more'> = defaultGraphPathWords,
  separator = ', '
): string {
  const shown = names.slice(0, PATH_NAME_CAP).join(separator);
  const extra = names.length - PATH_NAME_CAP;
  return extra > 0 ? `${shown} ${fill(words.more, { n: extra })}` : shown;
}

/**
 * A chain's groups as copy: members of one group joined with " + " (at
 * most PATH_NAME_CAP), groups with `separator`; past PATH_GROUP_CAP + 1
 * groups, the first PATH_GROUP_CAP, then "…", then the last.
 */
export function chainPhrase(
  groups: readonly (readonly string[])[],
  words: Pick<GraphPathWords, 'more'> = defaultGraphPathWords,
  separator = ' → '
): string {
  const parts = groups.map((group) => nameList(group, words, ' + '));
  if (parts.length <= PATH_GROUP_CAP + 1) return parts.join(separator);
  return [...parts.slice(0, PATH_GROUP_CAP), '…', parts[parts.length - 1]].join(
    separator
  );
}

/** The names of drawn node ids, in copy form. */
function namesOf(ctx: PathContext, ids: readonly string[]): string[] {
  return ids.map((id) => {
    const node = ctx.nodes.get(id);
    return node === undefined ? id : pathNodeName(node);
  });
}

/**
 * The "waits" part of the readout: what is upstream (with where to
 * start), else why nothing drawn is: blockers outside the graph, a
 * self-loop, blockers already done, or nothing open at all.
 */
function waitsPart(
  ctx: PathContext,
  paths: NodePaths,
  words: GraphPathWords
): string {
  const upstream = paths.upstream.nodeIds;
  if (upstream.length > 0) {
    const waits = fill(words.waitsOn, { n: upstream.length });
    if (paths.startWith.length > 0) {
      const names = nameList(namesOf(ctx, paths.startWith), words);
      return `${waits}, ${fill(words.startWith, { names })}`;
    }
    return paths.startsOutside ? `${waits}, ${words.startsOutside}` : waits;
  }
  if (paths.blockersNotDrawn > 0) {
    return fill(words.waitsOnOutside, { n: paths.blockersNotDrawn });
  }
  if (paths.selfLoop) return words.selfLoop;
  if (paths.blockersDone.length > 0) {
    const names = nameList(namesOf(ctx, paths.blockersDone), words);
    return fill(words.blockersDone, { names });
  }
  return words.waitsOnNone;
}

/**
 * The readout line for `id` (null when it is not drawn). Status and Risk:
 * its readiness word, what it waits on and where to start, what it holds
 * up, and what finishing it alone would unblock, with what is counted but
 * not drawn. Critical: its step on the longest chain through it, from
 * `chain` when the caller has it, else worked out here. The graph leads
 * the line with `words.locked` and the locked box's actions while the box
 * is locked.
 */
export function describePaths(
  id: string,
  ctx: PathContext,
  words: Partial<GraphPathWords> = {},
  highlight: GraphHighlight = 'risk',
  chain?: OpenChain | null
): PathReadout | null {
  const node = ctx.nodes.get(id);
  if (node === undefined) return null;
  const w = resolvePathWords(words);
  const subject = pathNodeName(node);

  if (highlight === 'critical') {
    const shown = chain === undefined ? longestChain(ctx.chains, id) : chain;
    const step = shown?.steps.get(id);
    if (shown === null || step === undefined) {
      return { subject, parts: [w.offChain] };
    }
    const names = chainPhrase(
      shown.groups.map((group) => namesOf(ctx, group)),
      w
    );
    return {
      subject,
      parts: [
        fill(w.step, { k: step, s: shown.stepCount }),
        fill(w.through, {
          n: shown.length,
          unit: unitWord(w, shown.length),
          names,
        }),
      ],
    };
  }

  const paths = nodePaths(id, ctx);
  if (paths === null) return null;
  const readiness = node.readiness;
  const parts: string[] = [];
  const noLongerBlocks =
    paths.noLongerBlocks.length === 0
      ? null
      : fill(w.noLongerBlocks, {
          names: nameList(namesOf(ctx, paths.noLongerBlocks), w),
        });

  if (readiness?.state === 'done' || readiness?.state === 'empty') {
    const label = node.statusLabel;
    const word = readiness.state === 'done' ? w.done : w.empty;
    parts.push(label !== undefined && label !== '' ? label : word);
    if (noLongerBlocks !== null) parts.push(noLongerBlocks);
    return { subject, parts };
  }

  // Neither blocks nor waits on anything: the word is the whole story.
  if (readiness?.state === 'independent' && readiness.label !== '') {
    return { subject, parts: [readiness.label] };
  }

  if (readiness !== undefined && readiness.label !== '') {
    parts.push(
      paths.blockersNotDrawn > 0
        ? `${readiness.label} (${fill(w.notDrawn, { n: paths.blockersNotDrawn })})`
        : readiness.label
    );
  }
  parts.push(waitsPart(ctx, paths, w));
  const held = paths.downstream.nodeIds.length;
  parts.push(held > 0 ? fill(w.holdsUp, { n: held }) : w.holdsUpNone);
  const unblocks = paths.next.length + paths.unblocksNotDrawn;
  if (unblocks > 0) {
    const notDrawn = fill(w.notDrawn, { n: paths.unblocksNotDrawn });
    const drawn = nameList(namesOf(ctx, paths.next), w);
    let names = drawn;
    if (paths.unblocksNotDrawn > 0) {
      names = drawn === '' ? notDrawn : `${drawn} (+${notDrawn})`;
    }
    parts.push(fill(w.unblock, { n: unblocks, names }));
  }
  if (noLongerBlocks !== null) parts.push(noLongerBlocks);
  return { subject, parts };
}

/** The readout as one line of text: "ENG-12 · Ready · …". */
export function readoutText(readout: PathReadout): string {
  return [readout.subject, ...readout.parts].join(' · ');
}

/* ---- accessible names ------------------------------------------------------------ */

/** How many nodes a walk from `id` reaches (never `id`), without edge keys. */
function reachCount(
  id: string,
  index: BlockerIndex,
  end: 'from' | 'to'
): number {
  const visited = new Set<string>([id]);
  const queue: string[] = [id];
  for (let head = 0; head < queue.length; head += 1) {
    for (const edge of index.get(queue[head]) ?? []) {
      const other = edge[end];
      if (visited.has(other)) continue;
      visited.add(other);
      queue.push(other);
    }
  }
  return queue.length - 1;
}

/**
 * The counts every drawn node's accessible name carries. Within
 * PATH_NAME_BUDGET (`V × (V + E)` walk steps, V the nodes on a blocking
 * edge, since a node on none walks nothing) they are transitive, one walk
 * up and one down per node; above it the direct blocking in- and
 * out-edges, so the cost stays O(V + E) in a host with no draw limit.
 */
export function pathNameCounts(
  ctx: PathContext
): ReadonlyMap<string, PathNameCounts> {
  const ends = new Set<string>();
  for (const edge of ctx.blocking) {
    ends.add(edge.from);
    ends.add(edge.to);
  }
  const v = ends.size;
  const transitive = v * (v + ctx.blocking.length) <= PATH_NAME_BUDGET;
  const counts = new Map<string, PathNameCounts>();
  for (const id of ctx.order) {
    const drawnNext = nextOf(ctx, id).length;
    const unblocks = unblockCount(ctx, id, drawnNext);
    const unblocksNotDrawn = unblocks - drawnNext;
    counts.set(id, {
      transitive,
      waitsOn: transitive
        ? reachCount(id, ctx.blockers, 'from')
        : blockingIn(ctx, id),
      holdsUp: transitive
        ? reachCount(id, ctx.waiters, 'to')
        : (ctx.waiters.get(id)?.length ?? 0),
      unblocks,
      outside: unblocksNotDrawn > 0 || blockersNotDrawnOf(ctx, id) > 0,
      unblocksNotDrawn,
    });
  }
  return counts;
}

/**
 * The counts as name words: "waits on 1, holds up 3; done would unblock
 * 2", or over the budget the direct "waits on 1, blocks 2". When the host
 * counts something about the node that is not drawn, the counts are
 * scoped to the drawn graph and the outside part said: "waits on 1, holds
 * up 0 in this graph; done would unblock 1 (1 not drawn)".
 */
export function pathNamePhrase(counts: PathNameCounts): string {
  const holds = counts.transitive ? 'holds up' : 'blocks';
  const scope = counts.outside === true ? ' in this graph' : '';
  const base = `waits on ${counts.waitsOn}, ${holds} ${counts.holdsUp}${scope}`;
  if (counts.unblocks <= 0) return base;
  const notDrawn = counts.unblocksNotDrawn ?? 0;
  const tail = notDrawn > 0 ? ` (${notDrawn} not drawn)` : '';
  return `${base}; done would unblock ${counts.unblocks}${tail}`;
}
