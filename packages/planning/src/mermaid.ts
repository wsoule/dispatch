// Mermaid text for a dependency graph (§2.10), for "Copy Mermaid" and docs.

import { findCycles } from './graph';
import { countLabel } from './labels';
import type {
  DependencyGraph,
  GraphCluster,
  GraphEdge,
  GraphHighlight,
  GraphNode,
} from './types';

// Characters that could end a quoted label, open markup, or be read as
// Mermaid syntax, replaced by Mermaid's `#<code>;` entity escapes.
const MERMAID_ESCAPES: Record<string, string> = {
  '"': '#34;',
  '#': '#35;',
  '%': '#37;',
  '&': '#38;',
  '(': '#40;',
  ')': '#41;',
  '<': '#60;',
  '>': '#62;',
  '[': '#91;',
  ']': '#93;',
  '`': '#96;',
  '{': '#123;',
  '|': '#124;',
  '}': '#125;',
};

/**
 * Makes text safe inside a quoted Mermaid label: one pass replaces each
 * special character with its entity (so `#` is never escaped twice) and
 * line breaks become spaces.
 */
export function escapeMermaidLabel(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/["#%&()<>[\]`{|}]/g, (ch) => MERMAID_ESCAPES[ch] ?? ch);
}

/**
 * The status hues of the Mermaid export: the status hues of packages/ui's
 * tokens.css (`--red`, `--amber`, `--green`, architecture §8.2 "Status
 * colours") at a mid tone, since pasted Mermaid cannot read CSS variables
 * and renders in either theme (a core test reads that file and keeps each
 * the same hue as its token). Each
 * holds 3:1 or more as a stroke on white, on Mermaid's default node fills
 * (light #ececff, dark #1f2020) and on GitHub's dark page (#0d1117). In
 * the status highlight a hue only repeats the label's readiness word.
 * The purple accent is not a status and never appears in the export.
 */
export const MERMAID_HUES: {
  readonly red: string;
  readonly amber: string;
  readonly green: string;
} = {
  red: '#d92d20',
  amber: '#bd790a',
  green: '#16853c',
};

/**
 * Whether a node is drawn overdue (the `overdue` class, the red status
 * hue), as the planner's canvas floods it red (nodeTone's danger): it is
 * overdue itself in an active project, or, for a project or an initiative,
 * its status is overdue. Checked before isRiskNode, so an overdue node is
 * red and never also classed amber.
 */
export function isOverdueNode(node: GraphNode): boolean {
  if (!node.active) return false;
  switch (node.kind) {
    case 'issue':
    case 'milestone':
      return node.overdue;
    case 'project':
    case 'initiative':
      return node.overdue || node.status === 'overdue';
    default: {
      const unreachable: never = node.kind;
      return unreachable;
    }
  }
}

/**
 * Whether a node is drawn as a risk (the `risk` class). Only in an active
 * project: a quiet, inactive project's work is never loud (§2.8), as
 * isOverdueNode and the canvas's muted box say. An issue or a milestone:
 * it is unassigned/overdue itself or waits on such an issue (wider than
 * the canvas's amber rule, which shows the waiting on the risk-chain
 * edges). A project or an initiative: it is overdue, or its status is at
 * risk.
 */
export function isRiskNode(node: GraphNode): boolean {
  if (!node.active) return false;
  switch (node.kind) {
    case 'issue':
    case 'milestone':
      return (
        node.unassigned ||
        node.overdue ||
        node.waitsOnUnassigned ||
        node.waitsOnOverdue
      );
    case 'project':
    case 'initiative':
      return node.overdue || node.status === 'at_risk';
    default: {
      const unreachable: never = node.kind;
      return unreachable;
    }
  }
}

/**
 * The word of a node's readiness (§2.10 "Readiness"): '' when done or
 * empty (its status shows that); 'No dependencies' when independent (neither blocks
 * nor waits on anything; hosts say it in names and readouts, not as a
 * chip on every unconnected box); an issue 'Ready' or 'Blocked by N';
 * above the issue level 'Clear', 'None ready' (clear, but every open issue
 * in it waits on another inside) or 'Waiting on N'.
 */
export function readinessLabel(node: GraphNode): string {
  if (node.readiness === 'done' || node.readiness === 'empty') return '';
  if (node.readiness === 'independent') return 'No dependencies';
  if (node.kind === 'issue') {
    return node.readiness === 'blocked'
      ? `Blocked by ${node.blockedBy}`
      : 'Ready';
  }
  if (node.readiness === 'blocked') return `Waiting on ${node.blockedBy}`;
  return node.readyIssues === 0 ? 'None ready' : 'Clear';
}

/**
 * The status highlight's class (§2.10 "Readiness"), shared by the
 * planner's tones and the Mermaid export: quiet (done, a box with no
 * issues, or inactive work: §2.8, never loud), stuck (an issue on an open cycle; a box none of whose
 * open issues is ready, with a cycle inside, whether it waits or not),
 * blocked, independent (no dependencies: neutral, so a graph of every
 * issue is not a sea of green), ready (in the blocking flow, nothing open
 * holds it up). Mirror-wide: it never reads `inCycle`, which depends on
 * what is drawn, so a box reads the same in every graph that draws it.
 */
export function readinessClass(
  node: GraphNode
): 'ready' | 'blocked' | 'stuck' | 'independent' | 'quiet' {
  if (node.readiness === 'done' || node.readiness === 'empty') return 'quiet';
  if (!node.active) return 'quiet';
  const stuck =
    node.kind === 'issue'
      ? node.readiness === 'blocked' && node.holdsCycle
      : node.readyIssues === 0 && node.holdsCycle;
  if (stuck) return 'stuck';
  if (node.readiness === 'blocked') return 'blocked';
  return node.readiness === 'independent' ? 'independent' : 'ready';
}

/**
 * One chain of blocking edges to draw as the critical path in the
 * export (the ui's `longestChain` result fits as it is). Core does not
 * compute it: the critical path is a walk over what is drawn (§2.10
 * "Mermaid"), so the host passes it in as plain data.
 */
export interface MermaidChain {
  /** Graph node ids, blocker first; a cycle's members next to each other. */
  nodeIds: readonly string[];
  /** Its blocking edges (blocker → waiting), a cycle's inner ones included. */
  edges: readonly { from: string; to: string }[];
}

/**
 * The Mermaid text of a graph in parts: the body (header, nodes, edges,
 * the chain-cut comment) is the same in every highlight, and `styles`
 * holds what each highlight appends to it (its classDefs, class lines,
 * link styles and, for the critical path, a comment).
 */
export interface MermaidParts {
  body: string;
  styles: Record<GraphHighlight, string>;
}

/** The highlight `toMermaid` writes when none is asked for. */
const DEFAULT_MERMAID_HIGHLIGHT: GraphHighlight = 'status';

/** Dashed and faded: a node outside the graph's container, in every mode. */
const EXTERNAL_CLASS = '  classDef external stroke-dasharray:3 3,opacity:0.7';
/** A chain's focus, in every mode. */
const FOCUS_CLASS = '  classDef focus stroke-width:3px';

/** An edge as written in the body: its graph edge and its link index. */
interface WrittenEdge {
  edge: GraphEdge;
  index: number;
}

/**
 * Builds the Mermaid text of a graph as a body plus one style block per
 * highlight (§2.10 "Mermaid"). The body is `flowchart LR` with positional
 * node ids (`n0`, `n1`, … so they never depend on Linear ids), quoted and
 * escaped labels whose second line ends in the readiness word ("Ready",
 * "Blocked by 1", "Waiting on 2"; none when done or independent, so the
 * export never says a state by colour alone and an unconnected box stays
 * quiet), each node written inside its cluster's `subgraph` (positional
 * ids `c0`, `c1`, … in cluster order, nested as the clusters are; a
 * cluster with none of the given nodes is left out), `-->` for a blocking
 * edge and `-.->` for one that no longer blocks, a `|n|` count on an edge
 * summarising more than one relation, and the chain-cut comment. The
 * styles:
 * - status: readinessClass's ready (green), blocked (2px amber), stuck
 *   (2px dashed red) and quiet (faded), and the unblocked edges in green;
 * - risk: the overdue (2px red), risk (2px amber) and cycle (dashed red)
 *   classes, and the risk-chain edges in amber;
 * - critical: `critical` is drawn 3px wide in the theme's own stroke (no
 *   hue, so it reads on light and dark Mermaid themes), with a comment
 *   listing it; nothing but the external and focus classes without one.
 * Every mode classes the externals and, in a chain, the focus. Linear in
 * the nodes, edges and the chain.
 */
export function mermaidParts(
  graph: DependencyGraph,
  options: { critical?: MermaidChain | null } = {}
): MermaidParts {
  const lines: string[] = ['flowchart LR'];
  const idOf = new Map<string, string>();
  graph.nodes.forEach((node, i) => idOf.set(node.id, `n${i}`));

  lines.push(...clusteredNodeLines(graph));

  const written: WrittenEdge[] = [];
  for (const edge of graph.edges) {
    const from = idOf.get(edge.from);
    const to = idOf.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const arrow = edge.blocking ? '-->' : '-.->';
    const count = edge.weight > 1 ? `|${edge.weight}|` : '';
    lines.push(`  ${from} ${arrow}${count} ${to}`);
    written.push({ edge, index: written.length });
  }

  const chain = graph.chain;
  if (chain !== null && chain.hidden > 0) {
    const kept = graph.nodes.length;
    lines.push(
      `  %% Showing the nearest ${kept} of ${kept + chain.hidden} issues on this chain`
    );
  }

  return {
    body: `${lines.join('\n')}\n`,
    styles: {
      status: styleBlock(statusStyles(graph, written)),
      risk: styleBlock(riskStyles(graph, written)),
      critical: styleBlock(
        criticalStyles(graph, idOf, written, options.critical ?? null)
      ),
    },
  };
}

/**
 * Renders the graph as Mermaid in one highlight: mermaidParts' body
 * followed by that highlight's styles (`status` when none is given).
 * `critical` is the chain the critical highlight draws (see
 * MermaidChain); the other highlights ignore it.
 */
export function toMermaid(
  graph: DependencyGraph,
  options: { highlight?: GraphHighlight; critical?: MermaidChain | null } = {}
): string {
  const parts = mermaidParts(graph, { critical: options.critical ?? null });
  return (
    parts.body + parts.styles[options.highlight ?? DEFAULT_MERMAID_HIGHLIGHT]
  );
}

/** One node's line, `n0["Label<br/>sublabel · word"]`, unindented. */
function nodeLine(node: GraphNode, i: number): string {
  const label = escapeMermaidLabel(node.label);
  // An independent node's word stays out of the export as it stays off
  // the canvas's chips: a graph of every issue would repeat it on most.
  const word = node.readiness === 'independent' ? '' : readinessLabel(node);
  const second = [node.sublabel, word]
    .filter((part) => part !== '')
    .map(escapeMermaidLabel)
    .join(' · ');
  const text = second === '' ? label : `${label}<br/>${second}`;
  return `n${i}["${text}"]`;
}

/**
 * The node lines of the body, each inside its cluster's subgraph block:
 * the clusters as a tree (graph.clusters order among siblings; a cluster
 * whose parent is missing goes to the top), each opened with
 * `subgraph c<k>["Label"]` and closed with `end`, two spaces deeper per
 * level, its nodes in node order before its child clusters. Clusters with
 * none of the graph's nodes in their subtree are left out (a host may
 * pass fewer nodes than were built), and nodes with no known cluster come
 * first, at the top level. Linear in nodes plus clusters.
 */
function clusteredNodeLines(graph: DependencyGraph): string[] {
  const clusters = graph.clusters;
  const indexOf = new Map<string, number>();
  clusters.forEach((cluster, k) => indexOf.set(cluster.id, k));
  const members = new Map<string | null, number[]>();
  graph.nodes.forEach((node, i) => {
    const key =
      node.clusterId !== null && indexOf.has(node.clusterId)
        ? node.clusterId
        : null;
    const list = members.get(key);
    if (list === undefined) members.set(key, [i]);
    else list.push(i);
  });
  const children = new Map<string | null, GraphCluster[]>();
  for (const cluster of clusters) {
    const parent =
      cluster.parentId !== null && indexOf.has(cluster.parentId)
        ? cluster.parentId
        : null;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [cluster]);
    else list.push(cluster);
  }
  // Whether a cluster's subtree holds a node (memoised; ids are unique,
  // and a parent chain that loops back is cut by `seen`).
  const filled = new Map<string, boolean>();
  const hasNodes = (cluster: GraphCluster, seen: Set<string>): boolean => {
    const known = filled.get(cluster.id);
    if (known !== undefined) return known;
    if (seen.has(cluster.id)) return false;
    seen.add(cluster.id);
    const result =
      (members.get(cluster.id)?.length ?? 0) > 0 ||
      (children.get(cluster.id) ?? []).some((child) => hasNodes(child, seen));
    filled.set(cluster.id, result);
    return result;
  };
  const lines: string[] = [];
  const written = new Set<string>();
  const write = (parent: string | null, depth: number): void => {
    const pad = '  '.repeat(depth);
    for (const i of members.get(parent) ?? []) {
      const node = graph.nodes[i];
      if (node !== undefined) lines.push(`${pad}${nodeLine(node, i)}`);
    }
    for (const cluster of children.get(parent) ?? []) {
      if (written.has(cluster.id) || !hasNodes(cluster, new Set())) continue;
      written.add(cluster.id);
      const k = indexOf.get(cluster.id) ?? 0;
      lines.push(
        `${pad}subgraph c${k}["${escapeMermaidLabel(cluster.label)}"]`
      );
      write(cluster.id, depth + 1);
      lines.push(`${pad}end`);
    }
  };
  write(null, 1);
  return lines;
}

/** Style lines joined as a block that ends in a line break ('' when none). */
function styleBlock(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('');
}

/**
 * One `class n0,n3 name` line per class that applies to a node, in the
 * order given, and none for a class no node has. Ids follow node order.
 */
function classLines(
  graph: DependencyGraph,
  classes: readonly (readonly [string, (node: GraphNode) => boolean])[]
): string[] {
  const lines: string[] = [];
  for (const [name, applies] of classes) {
    const ids = graph.nodes.flatMap((node, i) =>
      applies(node) ? [`n${i}`] : []
    );
    if (ids.length > 0) lines.push(`  class ${ids.join(',')} ${name}`);
  }
  return lines;
}

/** `linkStyle 0,2 <style>` for the written edges that match, or nothing. */
function linkStyleLines(
  written: readonly WrittenEdge[],
  applies: (edge: GraphEdge) => boolean,
  style: string
): string[] {
  const indexes = written.flatMap(({ edge, index }) =>
    applies(edge) ? [index] : []
  );
  return indexes.length > 0
    ? [`  linkStyle ${indexes.join(',')} ${style}`]
    : [];
}

/** The external class, plus the focus class and line in a chain graph. */
function frameStyles(graph: DependencyGraph): {
  defs: string[];
  classes: [string, (node: GraphNode) => boolean][];
} {
  const chain = graph.chain;
  const defs = [EXTERNAL_CLASS];
  const classes: [string, (node: GraphNode) => boolean][] = [
    ['external', (node) => node.external],
  ];
  if (chain !== null) {
    defs.push(FOCUS_CLASS);
    classes.push(['focus', (node) => node.id === chain.focusId]);
  }
  return { defs, classes };
}

/**
 * The status highlight (the default): each node in its readinessClass
 * (ready a 1px green edge, blocked 2px amber, stuck 2px dashed red, quiet
 * faded), and the edges that no longer block in green.
 */
function statusStyles(
  graph: DependencyGraph,
  written: readonly WrittenEdge[]
): string[] {
  const frame = frameStyles(graph);
  const { red, amber, green } = MERMAID_HUES;
  return [
    `  classDef ready stroke:${green}`,
    `  classDef blocked stroke:${amber},stroke-width:2px`,
    `  classDef stuck stroke:${red},stroke-width:2px,stroke-dasharray:5 3`,
    '  classDef quiet opacity:0.6',
    ...frame.defs,
    ...classLines(graph, [
      ...(['ready', 'blocked', 'stuck', 'quiet'] as const).map(
        (name) =>
          [name, (node: GraphNode) => readinessClass(node) === name] as const
      ),
      ...frame.classes,
    ]),
    ...linkStyleLines(written, (edge) => !edge.blocking, `stroke:${green}`),
  ];
}

/**
 * The risk highlight (the earlier export): overdue nodes a 2px red edge
 * (isOverdueNode, checked first, so such a node is never also risk),
 * risk nodes 2px amber (isRiskNode), drawn cycles dashed red, and the
 * risk-chain edges amber.
 */
function riskStyles(
  graph: DependencyGraph,
  written: readonly WrittenEdge[]
): string[] {
  const frame = frameStyles(graph);
  const { red, amber } = MERMAID_HUES;
  return [
    `  classDef overdue stroke:${red},stroke-width:2px`,
    `  classDef risk stroke:${amber},stroke-width:2px`,
    `  classDef cycle stroke:${red},stroke-dasharray:5 3`,
    ...frame.defs,
    ...classLines(graph, [
      ['overdue', isOverdueNode],
      ['risk', (node) => isRiskNode(node) && !isOverdueNode(node)],
      ['cycle', (node) => node.inCycle],
      ...frame.classes,
    ]),
    ...linkStyleLines(written, (edge) => edge.onRiskChain, `stroke:${amber}`),
  ];
}

/**
 * The critical highlight: a comment naming the chain in order (a cycle's
 * members joined by "+", the count in the graph's own noun), the chain's
 * nodes and edges 3px wide with no hue. Only the chain's drawn nodes and
 * edges count; with no chain, or none of it drawn, only the external and
 * focus classes are written.
 */
function criticalStyles(
  graph: DependencyGraph,
  idOf: ReadonlyMap<string, string>,
  written: readonly WrittenEdge[],
  critical: MermaidChain | null
): string[] {
  const frame = frameStyles(graph);
  const nodeIds = [...new Set(critical?.nodeIds)].filter((id) => idOf.has(id));
  if (critical === null || nodeIds.length === 0) {
    return [...frame.defs, ...classLines(graph, frame.classes)];
  }
  const onPath = new Set(nodeIds);
  const pathEdges = new Set(
    critical.edges.map((edge) => `${edge.from}->${edge.to}`)
  );
  const kind = graph.nodes.find((node) => onPath.has(node.id))?.kind ?? 'issue';
  const steps = chainSteps(nodeIds, critical.edges)
    .map((group) => group.map((id) => idOf.get(id) ?? id).join(' + '))
    .join(' → ');
  return [
    `  %% Critical path: ${steps} (${countLabel(nodeIds.length, kind)})`,
    '  classDef critical stroke-width:3px',
    ...frame.defs,
    ...classLines(graph, [
      ['critical', (node) => onPath.has(node.id)],
      ...frame.classes,
    ]),
    ...linkStyleLines(
      written,
      (edge) => pathEdges.has(`${edge.from}->${edge.to}`),
      'stroke-width:3px'
    ),
  ];
}

/**
 * Splits a chain's nodes into its steps: runs of neighbouring nodes that
 * lie on one cycle of the chain's own edges form one step (a cycle is
 * broken as a whole), every other node is a step of its own. The cycles
 * come from findCycles over the chain's edges, so the host needs to pass
 * nothing but the chain.
 */
function chainSteps(
  nodeIds: readonly string[],
  edges: MermaidChain['edges']
): string[][] {
  // nodeIds holds no repeats (criticalStyles drops them).
  const position = new Map(nodeIds.map((id, i) => [id, i] as const));
  const successors: number[][] = nodeIds.map(() => []);
  for (const edge of edges) {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (from !== undefined && to !== undefined) successors[from]?.push(to);
  }
  const cycleOf = new Map<number, number>();
  findCycles(nodeIds.length, successors).forEach((members, c) => {
    for (const member of members) cycleOf.set(member, c);
  });
  const steps: string[][] = [];
  let previousCycle: number | undefined;
  nodeIds.forEach((id, i) => {
    const cycle = cycleOf.get(i);
    const last = steps.at(-1);
    if (last !== undefined && cycle !== undefined && cycle === previousCycle) {
      last.push(id);
    } else {
      steps.push([id]);
    }
    previousCycle = cycle;
  });
  return steps;
}
