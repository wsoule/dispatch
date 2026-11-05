import type {
  GraphCluster,
  GraphLevel,
  GraphNode,
  GraphScope,
  Issue,
  Snapshot,
} from '@dispatch/planning';
import {
  graphContainer,
  graphScopeFor,
  homeInitiativeIds,
  isIssueOpen,
  issueStateType,
  NO_INITIATIVE_ID,
} from '@dispatch/planning';

import { GRAPH_DRAW_LIMITS, type GraphScopeHref } from './graphScope';

// Where a double-click on a graph box or a frame title goes, ported from the
// planner's lib/adapters/graph-drill.ts (Better-Tracker; owner request
// 2026-10-23: "when I double click on the graph item, it should take me to
// that items graph so I can quickly drill down"): one level down, the box's
// own graph. An initiative opens its projects, a project its milestones, a
// milestone its issues, an issue its blocking chain; a frame opens what it
// stands for at the level being drawn. When that graph would be empty or
// past the draw limits the box goes where its panel's drill-down links go
// instead (the next one that draws, else the first that holds anything,
// whose page offers narrower graphs). Sizes are counted once per page, in
// one pass over the planning snapshot, by the core's membership rules: no
// graph is built for them. The links are written by the `graph` href the
// caller passes (graphScope's GraphScopeHref).

/** How much a graph would draw: its boxes and its arrows. */
export interface GraphSize {
  nodes: number;
  edges: number;
}

/** One way down from a box: the graph and the link to it (`chainOf`:
    the issue whose blocking chain it is). */
interface DrillCandidate {
  scope: GraphScope;
  href: string;
  chainOf?: string;
}

/** A container's count while it is being folded: the items under it, the
    outside ends of its relations, and its arrows. */
interface Tally {
  own: number;
  outside: Set<string>;
  /** The arrows: relations (issue level) or distinct unit pairs. */
  edges: Set<string> | number;
}

/**
 * The size of every graph a drill-down can open (the issue level inside a
 * milestone, project or initiative; the milestone level inside a project or
 * initiative; the project level inside an initiative), keyed
 * `<level>@<container kind>:<id>`, plus whether each issue has a relation
 * (a chain with none draws nothing). One pass over the issues, the
 * milestones, the projects and the relations: O(issues + relations).
 */
export class DrillSizes {
  private readonly tallies = new Map<string, Tally>();
  private readonly related = new Set<string>();

  constructor(snapshot: Snapshot) {
    const home = homeInitiativeIds(snapshot);
    const homeOf = (projectId: string): string =>
      home.get(projectId) ?? NO_INITIATIVE_ID;
    const canceled = (issue: Issue): boolean =>
      issueStateType(snapshot, issue) === 'canceled';

    // The issue level: every issue under the container that is not
    // canceled, plus the outside end of each relation touching one.
    const issueKeys = (issue: Issue): string[] => {
      const keys: string[] = [];
      if (issue.milestoneId !== null) {
        keys.push(`issue@milestone:${issue.milestoneId}`);
      }
      if (issue.projectId !== null) {
        keys.push(`issue@project:${issue.projectId}`);
        if (snapshot.projects.has(issue.projectId)) {
          keys.push(`issue@initiative:${homeOf(issue.projectId)}`);
        }
      }
      return keys;
    };
    for (const issue of snapshot.issues.values()) {
      if (canceled(issue)) continue;
      for (const key of issueKeys(issue)) this.tally(key, 0).own += 1;
    }
    // The milestone and project levels: every unit under the container.
    const milestoneKeys = (milestoneId: string): string[] => {
      const projectId = snapshot.milestones.get(milestoneId)?.projectId;
      if (projectId === undefined) return [];
      return [
        `milestone@project:${projectId}`,
        `milestone@initiative:${homeOf(projectId)}`,
      ];
    };
    const projectKeys = (projectId: string): string[] => [
      `project@initiative:${homeOf(projectId)}`,
    ];
    for (const id of snapshot.milestones.keys()) {
      for (const key of milestoneKeys(id)) this.tally(key, new Set()).own += 1;
    }
    for (const id of snapshot.projects.keys()) {
      for (const key of projectKeys(id)) this.tally(key, new Set()).own += 1;
    }

    for (const [blockedId, blockerIds] of snapshot.blockersOf) {
      const blocked = snapshot.issues.get(blockedId);
      if (blocked === undefined) continue;
      for (const blockerId of blockerIds) {
        const blocker = snapshot.issues.get(blockerId);
        if (blocker === undefined) continue;
        // A chain walks its issue's direct relations in any state.
        this.related.add(blocker.id);
        this.related.add(blocked.id);
        if (canceled(blocker) || canceled(blocked)) continue;
        this.relate(issueKeys(blocker), issueKeys(blocked), {
          from: blocker.id,
          to: blocked.id,
          pair: null,
        });
        // Above the issue level only open-to-open relations count, between
        // two different units.
        if (
          !isIssueOpen(snapshot, blocker) ||
          !isIssueOpen(snapshot, blocked)
        ) {
          continue;
        }
        const unitOf = (issue: Issue, level: 'milestone' | 'project') => {
          const id =
            level === 'milestone' ? issue.milestoneId : issue.projectId;
          const units =
            level === 'milestone' ? snapshot.milestones : snapshot.projects;
          return id !== null && units.has(id) ? id : null;
        };
        for (const level of ['milestone', 'project'] as const) {
          const from = unitOf(blocker, level);
          const to = unitOf(blocked, level);
          if (from === null || to === null || from === to) continue;
          const keysOf = level === 'milestone' ? milestoneKeys : projectKeys;
          this.relate(keysOf(from), keysOf(to), {
            from,
            to,
            pair: `${from}>${to}`,
          });
        }
      }
    }
  }

  private tally(key: string, edges: Set<string> | number): Tally {
    let entry = this.tallies.get(key);
    if (entry === undefined) {
      entry = { own: 0, outside: new Set(), edges };
      this.tallies.set(key, entry);
    }
    return entry;
  }

  /** One arrow from an end under `fromKeys` to one under `toKeys`, in
      every container either end is under; the other end, when outside
      one of them, is that container's outside box. */
  private relate(
    fromKeys: readonly string[],
    toKeys: readonly string[],
    arrow: { from: string; to: string; pair: string | null }
  ): void {
    for (const key of new Set([...fromKeys, ...toKeys])) {
      const entry = this.tally(key, arrow.pair === null ? 0 : new Set());
      if (typeof entry.edges === 'number') entry.edges += 1;
      else if (arrow.pair !== null) entry.edges.add(arrow.pair);
      if (!fromKeys.includes(key)) entry.outside.add(arrow.from);
      if (!toKeys.includes(key)) entry.outside.add(arrow.to);
    }
  }

  /** What `scope` would draw; a chain is null (see hasChain), and so is
      the workspace, which no drill-down opens. */
  sizeOf(scope: GraphScope): GraphSize | null {
    const container = graphContainer(scope);
    if (container.kind === 'workspace' || container.kind === 'chain') {
      return null;
    }
    const entry = this.tallies.get(
      `${scope.level}@${container.kind}:${container.id}`
    );
    if (entry === undefined) return { nodes: 0, edges: 0 };
    return {
      nodes: entry.own + entry.outside.size,
      edges: typeof entry.edges === 'number' ? entry.edges : entry.edges.size,
    };
  }

  /** Whether an issue's chain draws anything: it has a relation. */
  hasChain(issueId: string): boolean {
    return this.related.has(issueId);
  }
}

/** A drawable graph: something to draw, within GRAPH_DRAW_LIMITS. */
function draws(size: GraphSize): boolean {
  return (
    size.nodes > 0 &&
    size.nodes <= GRAPH_DRAW_LIMITS.nodes &&
    size.edges <= GRAPH_DRAW_LIMITS.edges
  );
}

/** The ways down from a box, in its panel's link order: the first is its
    own graph one level down, the rest the fallbacks. */
function nodeCandidates(
  snapshot: Snapshot,
  kind: GraphLevel,
  id: string,
  graph: GraphScopeHref
): DrillCandidate[] {
  const at = (scope: GraphScope, nodeId?: string): DrillCandidate => ({
    scope,
    href: graph(scope, { node: nodeId }),
  });
  switch (kind) {
    case 'initiative':
      return (['project', 'milestone', 'issue'] as const).map((level) =>
        at({ level, initiativeId: id })
      );
    case 'project':
      return [
        at({ level: 'milestone', projectId: id }),
        at({ level: 'issue', projectId: id }),
      ];
    case 'milestone': {
      const own = at({ level: 'issue', milestoneId: id });
      const projectId = snapshot.milestones.get(id)?.projectId;
      return projectId === undefined || !snapshot.projects.has(projectId)
        ? [own]
        : [own, at({ level: 'milestone', projectId }, id)];
    }
    case 'issue': {
      const issue = snapshot.issues.get(id);
      const key = issue?.identifier ?? id;
      const chain: DrillCandidate = {
        scope: { level: 'issue', issueId: key },
        href: graph({ level: 'issue', issueId: key }),
        chainOf: id,
      };
      const milestoneId = issue?.milestoneId ?? null;
      return milestoneId === null || !snapshot.milestones.has(milestoneId)
        ? [chain]
        : [chain, at({ level: 'issue', milestoneId })];
    }
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/**
 * The ways down from a frame's title: what it stands for at the level
 * being drawn (a milestone frame its issues, a project frame its issues
 * at the issue level and its milestones at the milestone level, an
 * initiative frame its projects; "No milestone" its project), then the
 * fallbacks of that item's own box. "No project" stands for nothing.
 */
function clusterCandidates(
  snapshot: Snapshot,
  cluster: GraphCluster,
  level: GraphLevel,
  graph: GraphScopeHref
): DrillCandidate[] {
  const own = (scope: GraphScope): DrillCandidate => ({
    scope,
    href: graph(scope),
  });
  const box = (kind: GraphLevel, id: string): DrillCandidate[] =>
    nodeCandidates(snapshot, kind, id, graph);
  switch (cluster.kind) {
    case 'milestone':
      if (cluster.refId !== null) {
        return [
          own(graphScopeFor({ kind: 'milestone', id: cluster.refId }, level)),
          ...box('milestone', cluster.refId),
        ];
      }
      return cluster.projectId === null
        ? []
        : [
            own(
              graphScopeFor({ kind: 'project', id: cluster.projectId }, level)
            ),
            ...box('project', cluster.projectId),
          ];
    case 'project':
      return cluster.refId === null
        ? []
        : [
            own(graphScopeFor({ kind: 'project', id: cluster.refId }, level)),
            ...box('project', cluster.refId),
          ];
    case 'initiative':
      return cluster.refId === null
        ? []
        : [
            own(
              graphScopeFor({ kind: 'initiative', id: cluster.refId }, level)
            ),
            ...box('initiative', cluster.refId),
          ];
    default: {
      const unreachable: never = cluster.kind;
      return unreachable;
    }
  }
}

/**
 * The drill-down hrefs of a drawn graph: each box's and each frame's
 * (absent when there is nowhere to go). A way down is never the page
 * itself (`pageHref`, the canonical link of this scope). The first way
 * down that draws wins; when none does (empty, or past the draw limits),
 * the first that holds anything (a too-large page offers narrower
 * graphs); none at all leaves the box without one.
 */
export function drillTargets(input: {
  snapshot: Snapshot;
  nodes: readonly GraphNode[];
  clusters: readonly GraphCluster[];
  level: GraphLevel;
  pageHref: string;
  graph: GraphScopeHref;
}): { nodes: Map<string, string>; clusters: Map<string, string> } {
  const { snapshot, level, pageHref, graph } = input;
  const sizes = new DrillSizes(snapshot);
  const choose = (candidates: readonly DrillCandidate[]): string | null => {
    const seen = new Set<string>();
    const ways = candidates.filter((way) => {
      const page = graph(way.scope);
      if (page === pageHref || seen.has(way.href)) return false;
      seen.add(way.href);
      return true;
    });
    const fits = ways.map((way) => {
      // A chain keeps at most CHAIN_MAX_NODES issues: it draws whenever
      // its issue has a relation.
      if (way.chainOf !== undefined) {
        const any = sizes.hasChain(way.chainOf);
        return { way, draws: any, any };
      }
      const size = sizes.sizeOf(way.scope) ?? { nodes: 0, edges: 0 };
      return { way, draws: draws(size), any: size.nodes > 0 };
    });
    return (
      fits.find((fit) => fit.draws)?.way.href ??
      fits.find((fit) => fit.any)?.way.href ??
      null
    );
  };
  const nodes = new Map<string, string>();
  for (const node of input.nodes) {
    const href = choose(nodeCandidates(snapshot, node.kind, node.id, graph));
    if (href !== null) nodes.set(node.id, href);
  }
  const clusters = new Map<string, string>();
  for (const cluster of input.clusters) {
    const href = choose(clusterCandidates(snapshot, cluster, level, graph));
    if (href !== null) clusters.set(cluster.id, href);
  }
  return { nodes, clusters };
}
