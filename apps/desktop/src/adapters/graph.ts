import type {
  AllocationPlan,
  DependencyGraph,
  GraphCluster,
  GraphContainer,
  GraphEdge,
  GraphHighlight,
  GraphLevel,
  GraphNode,
  GraphScope,
  IsoDate,
  MermaidParts,
  MilestoneAssessment,
  MilestoneStatus,
  Project,
  ProjectAllocationPlan,
  Snapshot,
} from '@dispatch/planning';
import {
  graphContainer,
  graphScopeFor,
  homeInitiativeIds,
  isIssueOpen,
  mermaidParts,
  nextMilestoneId,
  NO_INITIATIVE_ID,
  PRIORITY_LABEL,
  readinessClass,
  readinessLabel,
  RISK_REASON_LABEL,
  RUBRIC_GAP_LABEL,
  STATUS_LABEL,
} from '@dispatch/planning';
import type {
  GraphClusterData,
  GraphEdgeData,
  GraphEdgeKind,
  GraphLayout,
  GraphLegendItem,
  GraphNodeData,
  GraphNodeReadiness,
  GraphNodeTag,
  GraphNodeTone,
  GraphPathWords,
  LongestChains,
  NavTabItem,
  OpenChain,
  ShellCrumb,
  UiStatus,
  UiTone,
} from '@dispatch/ui';
import {
  chainPhrase,
  longestChain,
  longestChains,
  measureNode,
  nameList,
  pathNodeName,
} from '@dispatch/ui';

import { drillTargets } from './graphDrill';
import { cachedLayoutGraph } from './graphLayoutCache';
import {
  GRAPH_DRAW_LIMITS,
  GRAPH_LEVEL_LABEL,
  graphTrail,
  initiativeName,
  levelTabs,
  NARROW_MAX_ROWS,
} from './graphScope';
import { dueLabel, formatDate, plural } from './planningFormat';
import {
  assessmentMark,
  blockedReasonLine,
  dueTone,
  issueMark,
  type StatusMarkModel,
  uiStatus,
} from './planningStatus';

// The Graph destination's page model, ported from the planner's
// lib/adapters/graph.ts (Better-Tracker): @dispatch/planning's
// DependencyGraph at any of its four levels (initiative, project, milestone,
// issue) inside the workspace, an initiative, a project, a milestone or one
// issue's chain, mapped onto @dispatch/ui's GraphNodeData / GraphEdgeData /
// GraphClusterData (readiness, boundary crossings and the labelled frames
// included). Every item of the scope is drawn, not only the ones on a
// blocking relation (owner decision 2026-10-23): the arrows are the
// relations, and the frames group the boxes by parent. Around the drawing:
// heading, trail, receipts, notices, the screen-reader summary, the level
// tabs, each node's panel details, the layout, the too-large state, and per
// highlight (Status, Risk, Critical path) the legend, the idle readout and
// the Mermaid styles, with the readout's words. Pure functions over planning
// data; the view builds the model once (memoized) and only renders it,
// switching highlights on its own.
//
// What changed in the port: every href is a parameter (GraphHrefs: in
// Dispatch every box is a task, so one `task(id)` replaces the Linear links,
// and a graph link is written by the view's own `graph(scope)`); the Linear
// write-grant model is gone (a graph is read-only by nature, and the
// no-initiatives notice has one wording); the highlight and the locked box
// are the view's state rather than URL parameters; ?node= becomes
// `nodeId`, the box to select on arrival at any level (the planner kept
// issues for its own slide-over; here every box opens the task drawer); and
// a node's panel keeps the planner's properties with Dispatch links.

/** Where the graph's links go. */
export interface GraphHrefs {
  /** A box's task (shellRoutes' `taskHref`): every box is a task. */
  task(id: string): string;
  /** Another graph: a scope, with the box to select on arrival. */
  graph(scope: GraphScope, options?: { node?: string | null }): string;
  /** The Issues list (a filtered list once Phase 6 adds query routes). */
  issues(): string;
  /** The Timeline (a focused lane once Phase 6 adds query routes). */
  timeline(): string;
}

/** A link in a node's panel. */
export interface GraphLink {
  label: string;
  href: string;
}

/** One row of a node's property list, as plain text. */
export interface GraphProperty {
  label: string;
  value: string;
  /** The value's status tone: danger when it is overdue, warning when it
      needs action ("No lead", "Unassigned", a risk reason, a due date today
      or tomorrow), info / muted for the allocation cell's chip tones. */
  tone?: UiTone;
}

/** What the panel shows for a selected node. */
export interface GraphNodeDetail {
  id: string;
  kind: GraphLevel;
  title: string;
  /** The crumb above the title: "Atlas billing migration / Dual-write". */
  breadcrumb: string;
  status: UiStatus;
  statusLabel: string;
  /** A red (danger) Overdue strip at the top when the node is overdue. */
  alert: string | null;
  properties: GraphProperty[];
  /** Drill-down and elsewhere links, in panel order; never this page. */
  links: GraphLink[];
}

/** One way to narrow a graph too large to draw. */
export interface GraphNarrowRow {
  id: string;
  label: string;
  /** "Initiative", "Project", "Milestone", "Issue". */
  kind: string;
  /** Boxes it would draw, or an issue's edges, as digits. */
  count: string;
  href: string;
}

/** What the view shows instead of a graph past GRAPH_DRAW_LIMITS. */
export interface GraphTooLarge {
  message: string;
  title: string;
  note: string | null;
  rows: GraphNarrowRow[];
}

/** A quiet one-line paragraph under the receipts. */
export interface GraphNotice {
  id: 'fallback' | 'unplaced' | 'shared' | 'chain-closed' | 'chain-cut';
  text: string;
}

export interface GraphPageModel {
  level: GraphLevel;
  container: GraphContainer;
  /** Canonical link of this scope (no node). */
  scopeHref: string;
  /** Remount key of the graph: scopeHref plus the arrival node. */
  pageKey: string;
  heading: string;
  receipts: string;
  notices: GraphNotice[];
  /** The drill-up trail above the heading; empty in the workspace. */
  trail: ShellCrumb[];
  /** Level tabs; empty when the container offers one level. */
  tabs: NavTabItem[];
  /** BlockBar title over the graph. */
  blockTitle: string;
  /** BlockBar meta over the graph. */
  meta: string;
  /** The drawn nodes: every item of the scope (plus the externals one
      relation away), whether or not it is on an edge; empty when nothing
      is drawn (no item, too large, or a chain with no relation). */
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  /** The labelled frames the nodes are drawn in, parents first (the
      core's DependencyGraph.clusters); empty at the initiative level, in a
      chain and when nothing is drawn. The canvas names each box's frames. */
  clusters: GraphClusterData[];
  /** layoutGraph of nodes and edges (in the clusters, except for a
      chain), reused from cachedLayoutGraph when the same drawing was laid
      out before. */
  layout: GraphLayout | null;
  /** Panel details of the drawn nodes. */
  details: Record<string, GraphNodeDetail>;
  /** Set instead of nodes when the graph is past GRAPH_DRAW_LIMITS. */
  tooLarge: GraphTooLarge | null;
  /** The `nodeId` box selected on arrival, when it is drawn. */
  initialSelectedId: string | null;
  /** A chain's issue, ringed as the graph's focus. */
  focusId: string | null;
  ariaSummary: string;
  emptyMessage: string;
  /** The legend of each highlight (the view shows its own mode's). */
  legends: Record<GraphHighlight, GraphLegendItem[]>;
  /**
   * What the readout under the drawing says with nothing pointed at, per
   * highlight, over the drawn nodes ("3 ready · 5 blocked · 1 done").
   * Empty when nothing is drawn. A chain graph's readout describes its
   * focus instead.
   */
  readouts: Record<GraphHighlight, string>;
  /** The readout's and the pill's words for this level (ui GraphPathWords). */
  pathWords: Partial<GraphPathWords>;
  /**
   * Mermaid of the drawn graph as one body and a style block per
   * highlight (the core's mermaidParts; the critical block draws the
   * critical path shown at rest); Copy Mermaid joins the body with the
   * current highlight's styles. Null when nothing is drawn.
   */
  mermaid: MermaidParts | null;
  /** The page's own breadcrumb ("Issues in Dual-write"), or null. */
  crumb: string | null;
}

export interface GraphPageInput {
  graph: DependencyGraph;
  snapshot: Snapshot;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  allocationPlan: AllocationPlan;
  today: IsoDate;
  hrefs: GraphHrefs;
  /** A box to select on arrival (a link's ?node=), when it is drawn. */
  nodeId?: string | null;
  /**
   * Rewrites the drawn boxes before the layout, the critical path and the
   * readouts are computed over them (the Dispatch overlay, graphOverlay.ts:
   * a bucket's chip and hue, readiness from the ready set). Applied here
   * rather than to `nodes` afterwards so that the boxes are measured with
   * their final chips and dagre runs once per drawing. Default: as built.
   */
  overlay?: (nodes: GraphNodeData[]) => GraphNodeData[];
}

function isMilestoneStatus(value: string): value is MilestoneStatus {
  return Object.hasOwn(STATUS_LABEL, value);
}

/** Whether an edge crosses the boundary the level draws as "cross": a
    project at the issue and milestone levels, a first initiative at the
    project level (never in a workspace without initiatives, whose edges
    carry no crossInitiative), nothing at the initiative level. The Status
    and Critical path highlights dash every such edge that still blocks (ui
    GraphEdgeData.cross), whatever its kind. */
export function crossesBoundary(edge: GraphEdge, level: GraphLevel): boolean {
  switch (level) {
    case 'issue':
    case 'milestone':
      return edge.crossProject;
    case 'project':
      return edge.crossInitiative;
    case 'initiative':
      return false;
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

/**
 * How an edge is drawn, in the ui package's precedence (resolved > cycle >
 * risk > cross > default): an edge that no longer blocks (its blocker is
 * done, or the issue that waited is) holds nothing up and is drawn
 * "unblocked", a cycle is the loudest problem, a risk chain next, then the
 * level's boundary (crossesBoundary). The kind never depends on the
 * highlight, so the layout is the same in every mode.
 */
export function edgeKind(
  edge: GraphEdge,
  level: GraphLevel = 'issue'
): GraphEdgeKind {
  if (!edge.blocking) return 'resolved';
  if (edge.inCycle) return 'cycle';
  if (edge.onRiskChain) return 'risk';
  if (crossesBoundary(edge, level)) return 'cross';
  return 'default';
}

/** The chip of an issue on an open cycle that this graph does not draw
    whole: the word without the dashed outline, which stays for drawn
    cycles (Cycle). */
export const ON_A_CYCLE_TAG = 'On a cycle';

/**
 * The sentence-case chips on a node (ui DependencyGraph draws each as a
 * Chip in its tone), from the core's flags, in this order: Unassigned
 * (open issues and milestones only: a project or initiative always holds
 * some unassigned later work; a tinted amber chip), Overdue (never for an
 * inactive project's work; a red dot pill, and the box's red tint under
 * the Risk highlight), Cycle (a drawn cycle: the box gets the dashed red
 * outline), On a cycle (an issue on an open cycle the graph does not draw
 * whole, so its stuck red always has a word), Cycle inside (a box holding
 * an issue loop), No lead (an active project), Inactive (a box with no
 * active project, or an open issue of an inactive one: paused work is
 * quiet, and the word says why) and +N more (a chain issue leading on to
 * issues the chain cap left out).
 */
export function nodeTags(node: GraphNode): GraphNodeTag[] {
  const tags: GraphNodeTag[] = [];
  const aggregate = node.kind !== 'issue';
  if (
    (node.kind === 'issue' || node.kind === 'milestone') &&
    node.open &&
    node.unassigned
  ) {
    tags.push('Unassigned');
  }
  if (node.overdue && node.active) tags.push('Overdue');
  if (node.inCycle) tags.push('Cycle');
  else if (!aggregate && node.open && node.holdsCycle) {
    tags.push(ON_A_CYCLE_TAG);
  }
  if (aggregate && node.holdsCycle) tags.push('Cycle inside');
  if (node.kind === 'project' && node.active && node.ownerId === null) {
    tags.push('No lead');
  }
  if (!node.active && (aggregate || node.open)) tags.push('Inactive');
  if ((node.hiddenNeighbours ?? 0) > 0) {
    tags.push(`+${node.hiddenNeighbours} more`);
  }
  return tags;
}

/**
 * Node emphasis in the status tones, first match wins: muted once closed
 * (an issue done or canceled, a milestone complete) or when its project is
 * inactive (a box of paused work is never loud); danger (red) when it is
 * overdue in an active project; warning (amber) when it needs action;
 * neutral otherwise. An issue needs action when it is open and nobody owns
 * it, in an active project; a milestone when it is at risk; a project or
 * an initiative when its next milestone (the most severe of them) is at
 * risk, danger when that one is overdue. A later milestone's unassigned
 * issues are normal (allocation hands out only the next milestone), so
 * they keep their Unassigned chip without edging every milestone in amber.
 */
export function nodeTone(node: GraphNode): GraphNodeTone {
  if (!node.open || node.status === 'complete') return 'muted';
  if (node.kind !== 'issue' && !node.active) return 'muted';
  if (node.overdue && node.active) return 'danger';
  switch (node.kind) {
    case 'issue':
      return node.unassigned && node.active ? 'warning' : 'default';
    case 'milestone':
      return node.status === 'at_risk' ? 'warning' : 'default';
    case 'project':
    case 'initiative':
      return node.status === 'overdue'
        ? 'danger'
        : node.status === 'at_risk'
          ? 'warning'
          : 'default';
    default: {
      const unreachable: never = node.kind;
      return unreachable;
    }
  }
}

/** The Status highlight's tone of each readiness class (the core's
    readinessClass): ready a green edge, blocked an amber edge, stuck a red
    edge, quiet (done or paused work) quiet, and independent ("No
    dependencies": on no blocking relation at all) neutral, so a graph of
    every item is not a sea of green. */
export const READINESS_TONE: Readonly<
  Record<ReturnType<typeof readinessClass>, GraphNodeTone>
> = {
  ready: 'success',
  blocked: 'warning',
  stuck: 'danger',
  independent: 'default',
  quiet: 'muted',
};

/**
 * The core's readiness facts as the ui draws them: the chip word (an
 * independent node's "No dependencies" is said in its name and the
 * readout, never drawn as a chip), the Status tone, the workspace-wide
 * counts, and for a box whether anything in it can start (a clear box
 * whose every open issue waits inside it cannot, so "start with" never
 * points at it). Issues leave canStart unset; the Dispatch overlay
 * (graphOverlay.ts) sets it from the ready set.
 */
export function nodeReadiness(node: GraphNode): GraphNodeReadiness {
  const readiness: GraphNodeReadiness = {
    state: node.readiness,
    label: readinessLabel(node),
    tone: READINESS_TONE[readinessClass(node)],
    blockedBy: node.blockedBy,
    unblocks: node.unblocks,
  };
  if (node.kind !== 'issue') readiness.canStart = node.readyIssues > 0;
  return readiness;
}

function statusMark(status: string): StatusMarkModel {
  const known = isMilestoneStatus(status) ? status : 'empty';
  return { status: uiStatus(known), label: STATUS_LABEL[known] };
}

function milestoneMark(
  node: GraphNode,
  assessment: MilestoneAssessment | undefined
): StatusMarkModel {
  if (assessment !== undefined) return assessmentMark(assessment);
  return statusMark(node.status);
}

/* ---- the allocation cell --------------------------------------------------- */

/** A project's allocation as the planner's register cell drew it: a short
    label, an optional reason line, and the chip's tone. */
interface AllocationCell {
  label: string;
  detail?: string;
  tone: UiTone;
}

/** The chip tone of each outcome: info allocating, warning blocked (its
    reason worded as on the timeline's Blocked banner), muted inactive /
    no open milestone / not evaluated, default nothing to do. */
function allocationCell(plan: ProjectAllocationPlan | null): AllocationCell {
  if (plan === null) return { label: 'Not evaluated', tone: 'muted' };
  switch (plan.outcome) {
    case 'allocate':
      return { label: `Allocating ${plan.actions.length}`, tone: 'info' };
    case 'blocked':
      return plan.blockReason === null
        ? { label: 'Blocked', tone: 'warning' }
        : {
            label: 'Blocked',
            detail: blockedReasonLine(plan.blockReason, plan.gaps),
            tone: 'warning',
          };
    case 'nothing_to_do':
      return { label: 'Nothing to do', tone: 'default' };
    case 'no_open_milestone':
      return { label: 'No open milestone', tone: 'muted' };
    case 'inactive':
      return { label: 'Inactive', tone: 'muted' };
    default: {
      const unreachable: never = plan.outcome;
      return unreachable;
    }
  }
}

/* ---- page context ------------------------------------------------------ */

/** Everything the per-node builders share, computed once per page. */
interface PageContext {
  snapshot: Snapshot;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  today: IsoDate;
  hrefs: GraphHrefs;
  scope: GraphScope;
  container: GraphContainer;
  /** Canonical link of the page (a link to it is left out of panels). */
  scopeHref: string;
  /** The container in sentences: "Dual-write", "the workspace". */
  containerName: string;
  hasInitiatives: boolean;
  /** Each project's first initiative (homeInitiativeIds). */
  home: ReadonlyMap<string, string | null>;
  plans: ReadonlyMap<string, ProjectAllocationPlan>;
  /** Drawn node id → the labels of its drawn direct blockers (blocking
      edges between drawn nodes), for the panel's Readiness row. */
  drawnBlockers: Map<string, string[]>;
}

function homeOf(ctx: PageContext, projectId: string): string {
  return ctx.home.get(projectId) ?? NO_INITIATIVE_ID;
}

/** A project's allocation plan says it is not active. */
function isInactive(ctx: PageContext, projectId: string): boolean {
  return ctx.plans.get(projectId)?.outcome === 'inactive';
}

function userName(snapshot: Snapshot, id: string | null): string | null {
  if (id === null) return null;
  return snapshot.users.get(id)?.name ?? 'Unknown person';
}

function projectName(snapshot: Snapshot, id: string | null): string {
  if (id === null) return 'No project';
  return snapshot.projects.get(id)?.name ?? 'Unknown project';
}

/** A container as it reads in a sentence ("No issue in {it} …"). */
function containerName(snapshot: Snapshot, container: GraphContainer): string {
  switch (container.kind) {
    case 'workspace':
      return 'the workspace';
    case 'initiative':
      return container.id === NO_INITIATIVE_ID
        ? 'the projects with no initiative'
        : (snapshot.initiatives.get(container.id)?.name ?? 'this initiative');
    case 'project':
      return snapshot.projects.get(container.id)?.name ?? 'this project';
    case 'milestone':
      return snapshot.milestones.get(container.id)?.name ?? 'this milestone';
    case 'chain':
      return snapshot.issues.get(container.id)?.identifier ?? container.id;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/**
 * Where a count of `noun`s sits, as it follows the count in a sentence:
 * "in Dual-write", "in the workspace". "No initiative" is a group of
 * projects, not a named thing, so it reads "with no initiative" after
 * projects and "in projects with no initiative" after anything else
 * ("1 project with no initiative", "3 milestones in projects with no
 * initiative"), never "projects in the projects with no initiative".
 */
function containerPhrase(ctx: PageContext, noun: string): string {
  const { container } = ctx;
  if (container.kind === 'initiative' && container.id === NO_INITIATIVE_ID) {
    return noun === 'project'
      ? 'with no initiative'
      : 'in projects with no initiative';
  }
  return `in ${ctx.containerName}`;
}

/**
 * The h1 of a scope, which is also its panel-link label: "Dependencies"
 * for the workspace, "Projects in Platform reliability", "Milestones of
 * projects with no initiative", "Issues in Dual-write", "Blocking chain
 * of ENG-24".
 */
function graphHeading(snapshot: Snapshot, scope: GraphScope): string {
  const container = graphContainer(scope);
  const levelName = GRAPH_LEVEL_LABEL[scope.level];
  switch (container.kind) {
    case 'workspace':
      return 'Dependencies';
    case 'initiative':
      if (container.id === NO_INITIATIVE_ID) {
        return scope.level === 'project'
          ? 'Projects with no initiative'
          : `${levelName} of projects with no initiative`;
      }
      return `${levelName} in ${containerName(snapshot, container)}`;
    case 'project':
    case 'milestone':
      return `${levelName} in ${containerName(snapshot, container)}`;
    case 'chain':
      return `Blocking chain of ${containerName(snapshot, container)}`;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/** The panel link to a scope, unless it is the page itself. */
function scopeLink(
  ctx: PageContext,
  label: string,
  scope: GraphScope,
  node?: string
): GraphLink | null {
  if (ctx.hrefs.graph(scope) === ctx.scopeHref) return null;
  return { label, href: ctx.hrefs.graph(scope, { node }) };
}

function presentLinks(links: readonly (GraphLink | null)[]): GraphLink[] {
  return links.filter((link): link is GraphLink => link !== null);
}

/* ---- node marks, sublabels and details, per kind -------------------------- */

/**
 * The line a drawn box shows for `sublabel`: ui's measureNode cuts a line
 * too wide for its widest box at its end. Measured with measureNode
 * itself (every drawn box has a status mark), so this follows the ui's
 * box metrics and its Geist text widths.
 */
function shownSublabel(sublabel: string): string {
  return measureNode({
    id: 'measure',
    label: '',
    sublabel,
    tone: 'default',
    status: 'open',
  }).sublabelLine;
}

/** The fewest characters of the head kept before it gives way whole. */
const MIN_HEAD = 3;

/**
 * "<head> · <tail>" for a box's one sublabel line. measureNode would cut
 * a too-long line at its end, which is where the date is, so here the
 * head gives way instead ("Atlas billing mig… · Jan 1, 2027"): the date
 * always shows. A line that fits is unchanged; a tail too long to leave
 * the head a few characters is left to the box's own cut. The longest
 * head that fits is found by halving (the width grows with the head).
 */
export function fitSublabel(head: string, tail: string): string {
  const full = `${head} · ${tail}`;
  if (shownSublabel(full) === full) return full;
  const cut = (n: number) => `${head.slice(0, n).trimEnd()}… · ${tail}`;
  const fits = (n: number) => shownSublabel(cut(n)) === cut(n);
  if (!fits(MIN_HEAD)) return full;
  let lo = MIN_HEAD;
  let hi = head.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

/** "Atlas billing migration · Oct 18", "… · no date": fits one node line
    (a project name too long for the box is cut, never the date). */
function milestoneSublabel(
  snapshot: Snapshot,
  milestoneId: string,
  today: IsoDate
): string {
  const milestone = snapshot.milestones.get(milestoneId);
  const project = projectName(snapshot, milestone?.projectId ?? null);
  const target = milestone?.targetDate ?? null;
  return fitSublabel(
    project,
    target === null ? 'no date' : formatDate(target, today)
  );
}

/** "Oct 18", or "No target date" (null) for "No initiative". */
function initiativeTarget(ctx: PageContext, id: string): string | null {
  if (id === NO_INITIATIVE_ID) return null;
  const target = ctx.snapshot.initiatives.get(id)?.targetDate ?? null;
  return target === null ? null : formatDate(target, ctx.today);
}

/** The next open milestone of a project and its assessment (the core's rule). */
function nextMilestoneOf(ctx: PageContext, projectId: string) {
  const id = nextMilestoneId(ctx.snapshot, projectId, ctx.assessments);
  const milestone = id === null ? undefined : ctx.snapshot.milestones.get(id);
  if (milestone === undefined) return null;
  return { milestone, assessment: ctx.assessments.get(milestone.id) };
}

function projectMark(ctx: PageContext, projectId: string): StatusMarkModel {
  const next = nextMilestoneOf(ctx, projectId);
  if (next?.assessment === undefined) {
    return { status: 'missing', label: 'No open milestone' };
  }
  return assessmentMark(next.assessment);
}

/** The projects whose first initiative is `initiativeId`. */
function projectsUnder(ctx: PageContext, initiativeId: string): Project[] {
  return ctx.snapshot.data.projects.filter(
    (project) => homeOf(ctx, project.id) === initiativeId
  );
}

/** "Outside Platform reliability: it blocks or waits on a project here". */
function outsideLine(ctx: PageContext, noun: string): GraphProperty {
  return {
    label: 'Scope',
    value: `Outside ${ctx.containerName}: it blocks or waits on a ${noun} here`,
  };
}

/**
 * A box's Readiness panel row, toned by its Status class (an inactive box
 * carries no tone): "Waiting on 1 milestone: Dual-write" (warning; the
 * drawn direct blockers, "(1 not drawn)" when it waits on more boxes, and
 * the blockers with no box at this level counted apart as issues: "…, and
 * 2 issues with no milestone"), "Clear: nothing outside it holds it up"
 * (success), "None ready: …" (danger), a waiting box none of whose issues
 * can start (danger), "No dependencies: …" (no tone: on no blocking
 * relation), "Complete" (it has issues, none open) or "No issues" (nothing
 * counts toward it).
 */
function readinessRow(ctx: PageContext, node: GraphNode): GraphProperty {
  const klass = readinessClass(node);
  const tone: UiTone = klass === 'quiet' ? 'default' : READINESS_TONE[klass];
  if (node.readiness === 'done') {
    return { label: 'Readiness', value: 'Complete', tone: 'default' };
  }
  if (node.readiness === 'empty') {
    return { label: 'Readiness', value: 'No issues', tone: 'default' };
  }
  if (node.readiness === 'independent') {
    return {
      label: 'Readiness',
      value: `No dependencies: it neither waits on nor holds up another ${node.kind}`,
      tone: 'default',
    };
  }
  if (node.readiness === 'ready') {
    return {
      label: 'Readiness',
      value:
        node.readyIssues === 0
          ? 'None ready: every open issue in it waits on another'
          : 'Clear: nothing outside it holds it up',
      tone,
    };
  }
  const names = ctx.drawnBlockers.get(node.id) ?? [];
  // Blockers with no box at this level are issues, not boxes (the core's
  // unplacedBlockers): counted apart, never under the level's noun.
  const unplaced = node.unplacedBlockers;
  const boxes = Math.max(0, node.blockedBy - unplaced);
  const notDrawn = Math.max(0, boxes - names.length);
  const listed = names.length === 0 ? '' : `: ${nameList(names)}`;
  const extra = notDrawn > 0 ? ` (${notDrawn} not drawn)` : '';
  const home = node.kind === 'milestone' ? 'milestone' : 'project';
  const loose =
    unplaced > 0 ? `${plural(unplaced, 'issue')} with no ${home}` : '';
  const stuck =
    klass === 'stuck'
      ? '. None of its open issues can start: a cycle inside holds some of them'
      : '';
  const waits =
    boxes === 0
      ? loose
      : `${plural(boxes, node.kind)}${listed}${extra}${loose === '' ? '' : `, and ${loose}`}`;
  return {
    label: 'Readiness',
    value: `Waiting on ${waits}${stuck}`,
    tone,
  };
}

/** "4 open · 3 can start · 1 blocked" (the core's workspace-wide counts),
    or "None open"; `unassigned` adds "· 2 unassigned" (the initiative's
    row). "Can start", not "ready": the issues nothing open blocks include
    those on no relation at all, which the Issues level calls "No
    dependencies" and keeps "Ready" for the ones in the blocking flow. */
function openIssuesValue(node: GraphNode, unassigned = 0): string {
  if (node.openIssues === 0) return 'None open';
  const blocked = node.openIssues - node.readyIssues;
  const tail = unassigned > 0 ? ` · ${unassigned} unassigned` : '';
  return `${node.openIssues} open · ${node.readyIssues} can start · ${blocked} blocked${tail}`;
}

/** The Readiness and Open issues rows of a project or milestone panel. */
function readinessRows(ctx: PageContext, node: GraphNode): GraphProperty[] {
  return [
    readinessRow(ctx, node),
    { label: 'Open issues', value: openIssuesValue(node) },
  ];
}

function initiativeDetail(
  ctx: PageContext,
  node: GraphNode,
  mark: StatusMarkModel
): GraphNodeDetail {
  const { snapshot, hrefs } = ctx;
  const id = node.id;
  const none = id === NO_INITIATIVE_ID;
  const projects = projectsUnder(ctx, id);
  const inactive = projects.filter((p) => isInactive(ctx, p.id)).length;
  let unassigned = 0;
  for (const project of projects) {
    for (const issue of snapshot.issuesByProject.get(project.id) ?? []) {
      if (!isIssueOpen(snapshot, issue)) continue;
      if (issue.assigneeId === null) unassigned += 1;
    }
  }
  const atRisk: string[] = [];
  let anyOverdue = false;
  for (const project of projects) {
    if (isInactive(ctx, project.id)) continue;
    const next = nextMilestoneOf(ctx, project.id);
    const status = next?.assessment?.status;
    if (next === null || (status !== 'at_risk' && status !== 'overdue')) {
      continue;
    }
    if (status === 'overdue') anyOverdue = true;
    atRisk.push(
      `${project.name} › ${next.milestone.name} (${status === 'overdue' ? 'overdue' : 'at risk'})`
    );
  }
  const target = initiativeTarget(ctx, id);
  const properties: GraphProperty[] = [
    { label: 'Target date', value: target ?? 'No target date' },
    {
      label: 'Projects',
      value: `${plural(projects.length, 'project')}${inactive > 0 ? ` · ${inactive} inactive` : ''}`,
    },
    readinessRow(ctx, node),
    { label: 'Open issues', value: openIssuesValue(node, unassigned) },
    {
      label: 'At risk',
      value: atRisk.length === 0 ? 'None' : atRisk.join('; '),
      // Red when any of them is overdue, amber when they are only at risk.
      tone: atRisk.length === 0 ? 'default' : anyOverdue ? 'danger' : 'warning',
    },
  ];
  if (node.external) properties.push(outsideLine(ctx, 'project'));
  const at = (level: 'project' | 'milestone' | 'issue'): GraphScope => ({
    level,
    initiativeId: id,
  });
  const links = presentLinks([
    scopeLink(ctx, graphHeading(snapshot, at('project')), at('project')),
    scopeLink(ctx, graphHeading(snapshot, at('milestone')), at('milestone')),
    scopeLink(ctx, graphHeading(snapshot, at('issue')), at('issue')),
    { label: 'Open as list', href: hrefs.issues() },
    { label: 'Open on the timeline', href: hrefs.timeline() },
    // "No initiative" is a group of projects, not a task.
    none ? null : { label: 'Open task', href: hrefs.task(id) },
  ]);
  return {
    id,
    kind: 'initiative',
    title: node.label,
    breadcrumb: none ? 'Projects with no initiative' : 'Initiative',
    status: mark.status,
    statusLabel: mark.label,
    alert: null,
    properties,
    links,
  };
}

function projectDetail(
  ctx: PageContext,
  node: GraphNode,
  mark: StatusMarkModel
): GraphNodeDetail {
  const { snapshot, today, hrefs } = ctx;
  const project = snapshot.projects.get(node.id);
  const active = node.active;
  const lead = userName(snapshot, project?.leadId ?? null);
  const next = nextMilestoneOf(ctx, node.id);
  const properties: GraphProperty[] = [
    { label: 'Status', value: project?.statusName ?? '—' },
    {
      label: 'Lead',
      value: lead ?? 'No lead',
      tone: lead === null && active ? 'warning' : 'default',
    },
    {
      label: 'Next milestone',
      value:
        next === null
          ? 'None'
          : `${next.milestone.name} · ${dueLabel(next.milestone.targetDate, next.assessment?.daysLeft ?? null, today, next.assessment?.status)}`,
      tone:
        next === null || !active
          ? 'default'
          : dueTone(
              next.assessment?.status ?? null,
              next.assessment?.daysLeft ?? null,
              next.milestone.targetDate === null
            ),
    },
  ];
  const progress = next?.assessment?.progress;
  if (progress !== undefined) {
    const unassigned =
      progress.openUnassigned > 0
        ? ` · ${plural(progress.openUnassigned, 'open issue')} unassigned`
        : '';
    properties.push({
      label: 'Progress',
      value: `${progress.completed}/${progress.scope} done${unassigned}`,
      tone: active && progress.openUnassigned > 0 ? 'warning' : 'default',
    });
  }
  properties.push(...readinessRows(ctx, node));
  const cell = allocationCell(ctx.plans.get(node.id) ?? null);
  properties.push({
    label: 'Allocation',
    value:
      cell.detail === undefined ? cell.label : `${cell.label} · ${cell.detail}`,
    tone: cell.tone,
  });
  if (ctx.hasInitiatives && project !== undefined) {
    const first = homeOf(ctx, project.id);
    const others = project.initiativeIds.filter(
      (id) => id !== first && snapshot.initiatives.has(id)
    );
    if (others.length > 0) {
      properties.push({
        label: 'Initiatives',
        value: `${initiativeName(snapshot, first)} · also in ${others.map((id) => initiativeName(snapshot, id)).join(', ')}`,
      });
    }
  }
  if (node.external) properties.push(outsideLine(ctx, 'project'));
  const links = presentLinks([
    scopeLink(ctx, `Milestones of ${node.label}`, {
      level: 'milestone',
      projectId: node.id,
    }),
    scopeLink(ctx, `Issues of ${node.label}`, {
      level: 'issue',
      projectId: node.id,
    }),
    { label: 'Open as list', href: hrefs.issues() },
    { label: 'Lane on the timeline', href: hrefs.timeline() },
    { label: 'Open task', href: hrefs.task(node.id) },
  ]);
  return {
    id: node.id,
    kind: 'project',
    title: node.label,
    breadcrumb: ctx.hasInitiatives
      ? initiativeName(snapshot, node.initiativeId ?? NO_INITIATIVE_ID)
      : 'Project',
    status: mark.status,
    statusLabel: mark.label,
    alert: null,
    properties,
    links,
  };
}

function milestoneDetail(
  ctx: PageContext,
  node: GraphNode,
  mark: StatusMarkModel
): GraphNodeDetail {
  const { snapshot, assessments, today, hrefs } = ctx;
  const milestone = snapshot.milestones.get(node.id);
  const project =
    milestone === undefined
      ? undefined
      : snapshot.projects.get(milestone.projectId);
  const assessment = assessments.get(node.id);
  const progress = assessment?.progress;
  const lead = userName(snapshot, project?.leadId ?? null);
  // An inactive project's milestone is never loud: the panel says the
  // same facts without a status hue, as its box does.
  const loud = node.active;
  const properties: GraphProperty[] = [
    {
      label: 'Due',
      value: dueLabel(
        milestone?.targetDate ?? null,
        assessment?.daysLeft ?? null,
        today,
        assessment?.status
      ),
      tone: loud
        ? dueTone(
            assessment?.status ?? null,
            assessment?.daysLeft ?? null,
            (milestone?.targetDate ?? null) === null
          )
        : 'default',
    },
    {
      label: 'Lead',
      value: lead ?? 'No lead',
      tone: loud && lead === null ? 'warning' : 'default',
    },
  ];
  if (progress !== undefined) {
    const unassigned =
      progress.openUnassigned > 0
        ? ` · ${plural(progress.openUnassigned, 'open issue')} unassigned`
        : '';
    properties.push({
      label: 'Progress',
      value: `${progress.completed}/${progress.scope} done${unassigned}`,
      tone: loud && progress.openUnassigned > 0 ? 'warning' : 'default',
    });
  }
  properties.push(...readinessRows(ctx, node));
  if (assessment !== undefined && assessment.reasons.length > 0) {
    properties.push({
      label: 'Risk reasons',
      value: assessment.reasons.map((r) => RISK_REASON_LABEL[r]).join('; '),
      tone: loud ? 'warning' : 'default',
    });
  }
  if (assessment !== undefined && assessment.rubric.gaps.length > 0) {
    properties.push({
      label: 'Missing',
      value: assessment.rubric.gaps.map((g) => RUBRIC_GAP_LABEL[g]).join('; '),
      tone: loud ? 'warning' : 'default',
    });
  }
  if (node.external) properties.push(outsideLine(ctx, 'milestone'));
  const links = presentLinks([
    scopeLink(ctx, 'Issues of this milestone', {
      level: 'issue',
      milestoneId: node.id,
    }),
    project === undefined
      ? null
      : scopeLink(
          ctx,
          `Milestones of ${project.name}`,
          { level: 'milestone', projectId: project.id },
          node.id
        ),
    { label: 'Open as list', href: hrefs.issues() },
    { label: 'Open on the timeline', href: hrefs.timeline() },
    { label: 'Open task', href: hrefs.task(node.id) },
  ]);
  return {
    id: node.id,
    kind: 'milestone',
    title: node.label,
    breadcrumb: project?.name ?? node.sublabel,
    status: mark.status,
    statusLabel: mark.label,
    alert:
      loud && node.overdue && assessment?.daysLeft != null
        ? `Overdue by ${plural(-assessment.daysLeft, 'day')}, with ${plural(progress?.open ?? 0, 'open issue')}.`
        : null,
    properties,
    links,
  };
}

function issueDetail(
  ctx: PageContext,
  node: GraphNode,
  mark: StatusMarkModel
): GraphNodeDetail {
  const { snapshot, today, hrefs } = ctx;
  const issue = snapshot.issues.get(node.id);
  const milestone =
    issue?.milestoneId == null
      ? undefined
      : snapshot.milestones.get(issue.milestoneId);
  const assessment =
    milestone === undefined ? undefined : ctx.assessments.get(milestone.id);
  const project = projectName(snapshot, issue?.projectId ?? null);
  const assignee = userName(snapshot, issue?.assigneeId ?? null);
  // An inactive project's issue is never loud, like its box.
  const loud = node.active;
  const properties: GraphProperty[] = [
    { label: 'Issue', value: issue?.identifier ?? node.sublabel },
    {
      label: 'Assignee',
      value: assignee ?? 'Unassigned',
      tone: loud && assignee === null && node.open ? 'warning' : 'default',
    },
    {
      label: 'Priority',
      value: issue === undefined ? '—' : PRIORITY_LABEL[issue.priority],
    },
    { label: 'Project', value: project },
    {
      label: 'Milestone',
      value:
        milestone === undefined
          ? 'No milestone'
          : `${milestone.name} · ${dueLabel(milestone.targetDate, assessment?.daysLeft ?? null, today, assessment?.status)}`,
      tone: loud && node.overdue ? 'danger' : 'default',
    },
  ];
  if (node.external) {
    properties.push({
      label: 'Scope',
      value: 'Outside this graph’s scope: it blocks or waits on an issue here',
    });
  }
  const links: GraphLink[] = [
    { label: 'Open task', href: hrefs.task(node.id) },
  ];
  if (milestone !== undefined) {
    links.push({ label: 'Milestone on the timeline', href: hrefs.timeline() });
    const own = scopeLink(ctx, 'Issues of this milestone', {
      level: 'issue',
      milestoneId: milestone.id,
    });
    if (own !== null) links.push(own);
  }
  return {
    id: node.id,
    kind: 'issue',
    title: node.label,
    breadcrumb:
      milestone === undefined ? project : `${project} / ${milestone.name}`,
    status: mark.status,
    statusLabel: mark.label,
    alert:
      loud && node.overdue && assessment?.daysLeft != null
        ? `Its milestone is overdue by ${plural(-assessment.daysLeft, 'day')}.`
        : null,
    properties,
    links,
  };
}

/** What one node draws and says, per kind: its mark and sublabel (the
    frame it sits in comes from the core's clusters). */
interface NodeFace {
  mark: StatusMarkModel;
  sublabel: string;
}

function nodeFace(ctx: PageContext, node: GraphNode): NodeFace {
  const { snapshot, assessments, today } = ctx;
  switch (node.kind) {
    case 'initiative': {
      const target = initiativeTarget(ctx, node.id);
      return {
        mark: statusMark(node.status),
        sublabel:
          node.id === NO_INITIATIVE_ID
            ? node.sublabel
            : fitSublabel(node.sublabel, target ?? 'no target date'),
      };
    }
    case 'project':
      return { mark: projectMark(ctx, node.id), sublabel: node.sublabel };
    case 'milestone':
      return {
        mark: milestoneMark(node, assessments.get(node.id)),
        sublabel: milestoneSublabel(snapshot, node.id, today),
      };
    case 'issue': {
      const issue = snapshot.issues.get(node.id);
      const stateName =
        issue === undefined
          ? node.status
          : (snapshot.states.get(issue.stateId)?.name ?? node.status);
      return {
        mark: issueMark({
          open: node.open,
          unassigned: node.unassigned,
          stateName,
        }),
        sublabel: node.sublabel,
      };
    }
    default: {
      const unreachable: never = node.kind;
      return unreachable;
    }
  }
}

function nodeDetail(
  ctx: PageContext,
  node: GraphNode,
  mark: StatusMarkModel
): GraphNodeDetail {
  switch (node.kind) {
    case 'initiative':
      return initiativeDetail(ctx, node, mark);
    case 'project':
      return projectDetail(ctx, node, mark);
    case 'milestone':
      return milestoneDetail(ctx, node, mark);
    case 'issue':
      return issueDetail(ctx, node, mark);
    default: {
      const unreachable: never = node.kind;
      return unreachable;
    }
  }
}

/* ---- phrases --------------------------------------------------------------- */

/** Names of the nodes of one cycle, as a clause ("A and B wait on each other"). */
function cycleClause(ids: readonly string[], labels: Map<string, string>) {
  const names = ids.map((id) => labels.get(id) ?? id);
  if (names.length === 1) return `${names[0]} waits on itself`;
  if (names.length === 2)
    return `${names[0]} and ${names[1]} wait on each other`;
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(', ')} and ${last} wait on each other in a loop`;
}

/** Joins the present parts: "a", "a and b", "a, b and c" ("" for none). */
export function listPhrase(parts: readonly (string | null)[]): string {
  const present = parts.filter((part): part is string => part !== null);
  if (present.length <= 1) return present[0] ?? '';
  return `${present.slice(0, -1).join(', ')} and ${present[present.length - 1]}`;
}

/** "no cycles" / "1 cycle: A and B wait on each other". */
export function cyclesPhrase(
  cycles: readonly (readonly string[])[],
  labels: Map<string, string>
): string {
  if (cycles.length === 0) return 'no cycles';
  return `${plural(cycles.length, 'cycle')}: ${cycles.map((c) => cycleClause(c, labels)).join('; ')}`;
}

/** ": a, b and c" after a count, or "" when no part applies. */
function detailClause(parts: readonly (string | null)[]): string {
  const detail = listPhrase(parts);
  return detail === '' ? '' : `: ${detail}`;
}

/* ---- legends -------------------------------------------------------------- */

/** The Risk legend's note on the level's box. It holds across a drawing
    laid out as one flow (the initiative level, a chain, the project level
    of a workspace without initiatives); a framed drawing lays out each
    frame on its own and packs the frames on shelves that wrap, so an arrow
    between two frames can run right to left, and the note then says it
    holds in a frame (FRAMED_FLOW_NOTE). */
const FLOW_NOTE = 'blockers sit left of what waits';
const FRAMED_FLOW_NOTE = 'in a frame, blockers sit left of what waits';

const MILESTONE_LEGEND: GraphLegendItem[] = [
  { mark: 'node', label: 'Milestone', note: FLOW_NOTE },
  { mark: 'node-overdue', label: 'Overdue', note: 'past its date' },
  { mark: 'node-warning', label: 'At risk', note: 'due soon and at risk' },
  { mark: 'node-cycle', label: 'In a cycle', note: 'waits on itself' },
  {
    mark: 'node-muted',
    label: 'Complete or inactive',
    note: 'nothing open, or a paused project',
  },
  { mark: 'edge-default', label: 'Blocks', note: 'an open issue blocks one' },
  {
    mark: 'edge-risk',
    label: 'Risk chain',
    note: 'ends in an unassigned or overdue blocker',
  },
  { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
  { mark: 'edge-cross', label: 'Cross-project', note: 'leaves its project' },
  { mark: 'weight', label: 'Count', note: 'issue relations on one edge' },
];

const ISSUE_LEGEND: GraphLegendItem[] = [
  { mark: 'node', label: 'Issue', note: FLOW_NOTE },
  { mark: 'node-overdue', label: 'Overdue', note: 'its milestone is past due' },
  { mark: 'node-warning', label: 'Needs action', note: 'open and unassigned' },
  { mark: 'node-cycle', label: 'In a cycle', note: 'waits on itself' },
  { mark: 'node-external', label: 'External', note: 'outside this scope' },
  { mark: 'node-muted', label: 'Closed', note: 'done or canceled' },
  { mark: 'edge-default', label: 'Blocks', note: 'blocker → waiting' },
  {
    mark: 'edge-risk',
    label: 'Risk chain',
    note: 'ends in an unassigned or overdue blocker',
  },
  { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
  { mark: 'edge-cross', label: 'Cross-project', note: 'leaves its project' },
  { mark: 'edge-resolved', label: 'Unblocked', note: 'one end is done' },
];

/** The issue legend where nothing is outside the scope: the workspace
    (it holds everything) and a chain (every box is on it). */
const ISSUE_LEGEND_NO_EXTERNAL: GraphLegendItem[] = ISSUE_LEGEND.filter(
  (item) => item.mark !== 'node-external'
);

/** The issue legend for one issue's chain: no externals, plus the focus. */
const CHAIN_LEGEND: GraphLegendItem[] = [
  ...ISSUE_LEGEND_NO_EXTERNAL.slice(0, 1),
  { mark: 'node-focus', label: 'Focus', note: 'the issue this chain is about' },
  ...ISSUE_LEGEND_NO_EXTERNAL.slice(1),
];

/** Shared by the initiative and project legends. */
const AGGREGATE_EDGES: GraphLegendItem[] = [
  { mark: 'edge-default', label: 'Blocks', note: 'an open issue blocks one' },
  {
    mark: 'edge-risk',
    label: 'Risk chain',
    note: 'a blocking issue is unassigned or overdue, or waits on one',
  },
  { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
];

const WEIGHT_ITEM: GraphLegendItem = {
  mark: 'weight',
  label: 'Count',
  note: 'issue relations on one edge',
};

function aggregateLegend(
  kind: 'Initiative' | 'Project',
  inactiveNote: string,
  cross: GraphLegendItem | null
): GraphLegendItem[] {
  return [
    { mark: 'node', label: kind, note: FLOW_NOTE },
    {
      mark: 'node-overdue',
      label: 'Overdue',
      note: 'a project’s milestone is past due',
    },
    {
      mark: 'node-warning',
      label: 'At risk',
      note: 'a project’s next milestone',
    },
    {
      mark: 'node-cycle',
      label: 'In a cycle',
      note: 'they wait on each other',
    },
    { mark: 'node-muted', label: 'Inactive', note: inactiveNote },
    ...AGGREGATE_EDGES,
    ...(cross === null ? [] : [cross]),
    WEIGHT_ITEM,
  ];
}

const INITIATIVE_LEGEND: GraphLegendItem[] = aggregateLegend(
  'Initiative',
  'no active project',
  null
);

/** The legend with "External — outside {where}" after the cycle swatch. */
function withExternal(
  legend: readonly GraphLegendItem[],
  where: string
): GraphLegendItem[] {
  const at = legend.findIndex((item) => item.mark === 'node-cycle') + 1;
  return [
    ...legend.slice(0, at),
    { mark: 'node-external', label: 'External', note: `outside ${where}` },
    ...legend.slice(at),
  ];
}

/** The Risk highlight's legend: the level's boxes and arrows, then the
    Paths row. `framed` when the graph draws frames, so the box's note says
    the flow holds in a frame (FLOW_NOTE). */
function riskLegend(ctx: PageContext, framed: boolean): GraphLegendItem[] {
  const marks = riskMarks(ctx);
  return [
    ...(framed
      ? marks.map((item) =>
          item.note === FLOW_NOTE ? { ...item, note: FRAMED_FLOW_NOTE } : item
        )
      : marks),
    ...pathItems(ctx.scope.level !== 'issue'),
  ];
}

function riskMarks(ctx: PageContext): GraphLegendItem[] {
  const { container } = ctx;
  const level = ctx.scope.level;
  const where =
    container.kind === 'initiative' ? 'this initiative' : 'this project';
  switch (level) {
    case 'initiative':
      return INITIATIVE_LEGEND;
    case 'project': {
      const legend = aggregateLegend(
        'Project',
        'paused or not started',
        ctx.hasInitiatives
          ? {
              mark: 'edge-cross',
              label: 'Cross-initiative',
              note: 'leaves its initiative',
            }
          : null
      );
      return container.kind === 'workspace'
        ? legend
        : withExternal(legend, where);
    }
    case 'milestone':
      return container.kind === 'workspace'
        ? MILESTONE_LEGEND
        : withExternal(MILESTONE_LEGEND, where);
    case 'issue':
      switch (container.kind) {
        case 'chain':
          return CHAIN_LEGEND;
        case 'workspace':
          return ISSUE_LEGEND_NO_EXTERNAL;
        case 'initiative':
        case 'project':
        case 'milestone':
          return ISSUE_LEGEND;
        default: {
          const unreachable: never = container;
          return unreachable;
        }
      }
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

/** The box being read: what the reader points at, focuses or taps
    (the soft accent tint under an accent ring, on every input). */
const READING_ITEM: GraphLegendItem = {
  mark: 'path-active',
  label: 'Reading',
  note: 'the box you point at or focus',
};

/** The locked box: the tint and ring of the box being read plus its
    corner ticks, with Open beside it. */
const LOCKED_ITEM: GraphLegendItem = {
  mark: 'path-locked',
  label: 'Locked',
  note: 'the box you click or tap: its paths stay lit, Open beside it',
};

/** What pointing at a box lights (the Paths row of every legend but the
    Critical path's): box paths follow the box arrows above the issue
    level, and "Clear next" replaces "Ready next" there. */
function pathItems(aggregate: boolean): GraphLegendItem[] {
  return [
    READING_ITEM,
    LOCKED_ITEM,
    {
      mark: 'path-up',
      label: 'Waits on',
      note: 'what the box you point at waits on',
    },
    {
      mark: 'path-down',
      label: 'Holds up',
      note: aggregate
        ? 'what waits on it, through box arrows'
        : 'what waits on it',
    },
    aggregate
      ? {
          mark: 'path-next',
          label: 'Clear next',
          note: 'clear once it is finished',
        }
      : {
          mark: 'path-next',
          label: 'Ready next',
          note: 'ready once it is done',
        },
  ];
}

/** Whether the scope draws boxes from outside its container (one hop). */
function drawsExternals(ctx: PageContext): boolean {
  const { container } = ctx;
  if (ctx.scope.level === 'initiative') return false;
  return (
    container.kind === 'initiative' ||
    container.kind === 'project' ||
    container.kind === 'milestone'
  );
}

/** "External — outside …", when the scope draws externals. */
function externalItems(ctx: PageContext): GraphLegendItem[] {
  if (!drawsExternals(ctx)) return [];
  const { container } = ctx;
  const where =
    ctx.scope.level === 'issue'
      ? 'this scope'
      : container.kind === 'initiative'
        ? 'this initiative'
        : 'this project';
  return [
    { mark: 'node-external', label: 'External', note: `outside ${where}` },
  ];
}

/** "Focus — the issue this chain is about", on a chain. */
function focusItems(ctx: PageContext): GraphLegendItem[] {
  return ctx.container.kind === 'chain'
    ? [
        {
          mark: 'node-focus',
          label: 'Focus',
          note: 'the issue this chain is about',
        },
      ]
    : [];
}

/** The faint box of each level. */
function quietItem(level: GraphLevel): GraphLegendItem {
  switch (level) {
    case 'initiative':
      return {
        mark: 'node-muted',
        label: 'Inactive',
        note: 'no active project',
      };
    case 'project':
      return {
        mark: 'node-muted',
        label: 'Inactive',
        note: 'paused or not started',
      };
    case 'milestone':
      return {
        mark: 'node-muted',
        label: 'Complete or inactive',
        note: 'nothing open, or a paused project',
      };
    case 'issue':
      return {
        mark: 'node-muted',
        label: 'Done or paused',
        note: 'closed, or in a paused project (Inactive)',
      };
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

/** The level's cross-boundary arrow, as the Risk legend names it. */
function crossItems(ctx: PageContext): GraphLegendItem[] {
  const level = ctx.scope.level;
  switch (level) {
    case 'issue':
    case 'milestone':
      return [
        {
          mark: 'edge-cross',
          label: 'Cross-project',
          note: 'leaves its project',
        },
      ];
    case 'project':
      return ctx.hasInitiatives
        ? [
            {
              mark: 'edge-cross',
              label: 'Cross-initiative',
              note: 'leaves its initiative',
            },
          ]
        : [];
    case 'initiative':
      return [];
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

/**
 * The Status highlight's legend: where each box stands (ready / no
 * dependencies / blocked / stuck / done or paused at the issue level;
 * clear / no dependencies / waiting / stuck / the level's faint box above
 * it; a chain draws nothing without a relation), the drawn-cycle outline,
 * externals and the focus; the arrows, with unblocked ones as green dots;
 * the paths.
 */
function statusLegend(ctx: PageContext): GraphLegendItem[] {
  const level = ctx.scope.level;
  const noun = levelNoun(level);
  const aggregate = level !== 'issue';
  const boxes: GraphLegendItem[] = aggregate
    ? [
        {
          mark: 'node-ready',
          label: 'Clear',
          note: 'nothing outside it holds it up',
        },
        {
          mark: 'node',
          label: 'No dependencies',
          note: `it neither waits on nor holds up another ${noun}`,
        },
        {
          mark: 'node-blocked',
          label: 'Waiting',
          note: `an open issue in it waits on another ${noun}`,
        },
        {
          mark: 'node-stuck',
          label: 'Stuck',
          note: 'nothing inside can start: a cycle inside holds it',
        },
        {
          mark: 'node-cycle',
          label: 'In a cycle',
          note: 'they wait on each other',
        },
        quietItem(level),
      ]
    : [
        { mark: 'node-ready', label: 'Ready', note: 'nothing open blocks it' },
        // A chain draws only what is on it.
        ...(ctx.container.kind === 'chain'
          ? []
          : [
              {
                mark: 'node' as const,
                label: 'No dependencies',
                note: 'it neither blocks nor waits on another issue',
              },
            ]),
        {
          mark: 'node-blocked',
          label: 'Blocked',
          note: 'an open issue blocks it',
        },
        {
          mark: 'node-stuck',
          label: 'Stuck',
          note: 'on a blocking cycle (it may run outside this graph)',
        },
        { mark: 'node-cycle', label: 'In a cycle', note: 'waits on itself' },
        quietItem(level),
      ];
  const arrows: GraphLegendItem[] = aggregate
    ? [
        {
          mark: 'edge-default',
          label: 'Blocks',
          note: 'an open issue blocks one',
        },
        { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
        ...crossItems(ctx),
        WEIGHT_ITEM,
      ]
    : [
        {
          mark: 'edge-default',
          label: 'Blocks',
          note: 'the blocker is still open',
        },
        {
          mark: 'edge-unblocked',
          label: 'Unblocked',
          note: 'one end is done: no longer blocking',
        },
        { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
        ...crossItems(ctx),
      ];
  return [
    ...boxes,
    ...externalItems(ctx),
    ...focusItems(ctx),
    ...arrows,
    ...pathItems(aggregate),
  ];
}

/**
 * The Critical path highlight's legend: the numbered boxes on the
 * longest chain and the faded rest, the drawn-cycle outline, externals
 * and the focus; the chain's heavier arrows (counted in issues, or in the
 * level's boxes), plain and cycle arrows, unblocked dots at the issue
 * level; and what pointing at a box shows.
 */
function criticalLegend(ctx: PageContext): GraphLegendItem[] {
  const level = ctx.scope.level;
  const aggregate = level !== 'issue';
  const counted = `${levelNoun(level)}s`;
  return [
    {
      mark: 'node-chain',
      label: 'Critical path',
      note: 'numbered in order; each waits on the one before',
    },
    { mark: 'node-faded', label: 'Off the path', note: 'faded' },
    {
      mark: 'node-cycle',
      label: 'In a cycle',
      note: aggregate ? 'they wait on each other' : 'waits on itself',
    },
    ...externalItems(ctx),
    ...focusItems(ctx),
    {
      mark: 'edge-chain',
      label: 'Critical path',
      note: `the longest chain of open blockers, counted in ${counted}`,
    },
    {
      mark: 'edge-default',
      label: 'Blocks',
      note: aggregate
        ? 'an open issue blocks one'
        : 'the blocker is still open',
    },
    { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
    ...(aggregate
      ? []
      : [
          {
            mark: 'edge-resolved' as const,
            label: 'Unblocked',
            note: 'one end is done',
          },
        ]),
    READING_ITEM,
    LOCKED_ITEM,
    {
      mark: 'path-chain',
      label: 'Critical path',
      note: 'through the box you point at: the longest chain it is on',
    },
  ];
}

/**
 * The frames the graph draws, for every highlight's Nodes row: what a
 * frame stands for at this level (a milestone, inside its project's frame
 * when the issues span projects; a project; an initiative), then the
 * dashed frame of paused work when one is drawn. None at the initiative
 * level, in a chain, or in a workspace without initiatives at the project
 * level (no clusters).
 */
function frameItems(
  level: GraphLevel,
  clusters: readonly GraphCluster[]
): GraphLegendItem[] {
  if (clusters.length === 0) return [];
  let frame: GraphLegendItem;
  switch (level) {
    case 'issue':
      frame = {
        mark: 'cluster',
        label: 'Milestone',
        note: clusters.some((cluster) => cluster.kind === 'project')
          ? 'a frame of its issues, inside its project’s'
          : 'a frame of its issues',
      };
      break;
    case 'milestone':
      frame = {
        mark: 'cluster',
        label: 'Project',
        note: 'a frame of its milestones',
      };
      break;
    case 'project':
      frame = {
        mark: 'cluster',
        label: 'Initiative',
        note: 'a frame of its projects (each under its first initiative)',
      };
      break;
    case 'initiative':
      return [];
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
  return clusters.some((cluster) => !cluster.active)
    ? [
        frame,
        {
          mark: 'cluster-muted',
          label: 'Inactive',
          note: 'a dashed frame of paused work',
        },
      ]
    : [frame];
}

/** Every highlight's legend for the page's level and container, each
    with the frames the graph draws. */
function legendsFor(
  ctx: PageContext,
  clusters: readonly GraphCluster[]
): Record<GraphHighlight, GraphLegendItem[]> {
  const frames = frameItems(ctx.scope.level, clusters);
  return {
    status: [...statusLegend(ctx), ...frames],
    risk: [...riskLegend(ctx, frames.length > 0), ...frames],
    critical: [...criticalLegend(ctx), ...frames],
  };
}

/** The core's clusters as the ui draws them (GraphClusterData): the frame
    of work with nothing active muted (dashed grey), one holding only boxes
    from outside the scope dashed, and the graph a double-click on its
    title opens (`drills`, graphDrill.ts) when it has one. */
export function clusterData(
  clusters: readonly GraphCluster[],
  drills: ReadonlyMap<string, string> = new Map()
): GraphClusterData[] {
  return clusters.map((cluster) => {
    const data: GraphClusterData = { id: cluster.id, label: cluster.label };
    if (cluster.parentId !== null) data.parent = cluster.parentId;
    if (!cluster.active) data.muted = true;
    if (cluster.external) data.external = true;
    const drill = drills.get(cluster.id);
    if (drill !== undefined) data.drillHref = drill;
    return data;
  });
}

/**
 * The drawn box a lock names (the view keeps the locked box as state; a
 * link may carry one later): by its id, else an issue box by its
 * identifier in any case ("eng-23"); null when it names nothing drawn, so
 * a stale lock locks nothing.
 */
export function lockedNodeId(
  nodes: readonly GraphNodeData[],
  param: string | null
): string | null {
  if (param === null) return null;
  const wanted = param.toUpperCase();
  return (
    nodes.find((node) => node.id === param)?.id ??
    nodes.find(
      (node) => node.key !== undefined && node.key.toUpperCase() === wanted
    )?.id ??
    null
  );
}

/** The lock a drawn box is written as: an issue by its identifier
    ("ENG-23", as a chain link names it), any other box by its id. */
export function lockParam(
  nodes: readonly GraphNodeData[],
  id: string | null
): string | null {
  if (id === null) return null;
  const node = nodes.find((n) => n.id === id);
  if (node === undefined) return null;
  return node.key !== undefined && node.key !== '' ? node.key : node.id;
}

/* ---- words per level ------------------------------------------------------- */

/** Each level's noun in counts ("3 milestones"). */
const LEVEL_NOUN: Readonly<Record<GraphLevel, string>> = {
  initiative: 'initiative',
  project: 'project',
  milestone: 'milestone',
  issue: 'issue',
};

/** An aggregate box's mark label, saying why the box is quiet when it is
    inactive ("Overdue · inactive project"). */
function quietLabel(node: GraphNode, label: string): string {
  if (node.active) return label;
  return `${label} · ${node.kind === 'initiative' ? 'no active project' : 'inactive project'}`;
}

/* ---- notices --------------------------------------------------------------- */

/** Why a workspace with no initiatives sees every project. */
const FALLBACK_TEXT =
  'This workspace has no initiatives, so this graph covers every project.';

/** "A, B, C, D, E and 3 more": at most five names, then a count. */
function namesPhrase(names: readonly string[]): string {
  if (names.length <= 5) return listPhrase(names);
  return `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`;
}

/**
 * Projects also in this initiative that count under another (their
 * first) initiative, as on the timeline: they are drawn as externals here,
 * so the page names them. (Dispatch's hierarchy is a tree, so this stays
 * empty until a project can belong to two initiatives.)
 */
function sharedNotice(ctx: PageContext, initiativeId: string): string | null {
  const { snapshot } = ctx;
  const shared = snapshot.data.projects.filter(
    (project) =>
      project.initiativeIds.includes(initiativeId) &&
      homeOf(ctx, project.id) !== initiativeId
  );
  if (shared.length === 0) return null;
  const here = initiativeName(snapshot, initiativeId);
  const homes = new Set(shared.map((project) => homeOf(ctx, project.id)));
  const [onlyHome] = homes;
  const names = namesPhrase(shared.map((project) => project.name));
  if (shared.length === 1 && onlyHome !== undefined) {
    return `${names} is also in ${here} and counts under ${initiativeName(snapshot, onlyHome)}, its first initiative, as on the timeline.`;
  }
  return homes.size === 1 && onlyHome !== undefined
    ? `${names} are also in ${here} and count under ${initiativeName(snapshot, onlyHome)}, their first initiative, as on the timeline.`
    : `${names} are also in ${here} and count under their first initiatives, as on the timeline.`;
}

/* ---- the too-large state ---------------------------------------------------- */

const KIND_LABEL: Readonly<Record<GraphLevel, string>> = {
  initiative: 'Initiative',
  project: 'Project',
  milestone: 'Milestone',
  issue: 'Issue',
};

function issueRowLabel(snapshot: Snapshot, node: GraphNode): string {
  const key = snapshot.issues.get(node.id)?.identifier;
  return key === undefined ? node.label : `${key} ${node.label}`;
}

function chainHrefOf(ctx: PageContext, node: GraphNode): string {
  const key = ctx.snapshot.issues.get(node.id)?.identifier ?? node.id;
  return ctx.hrefs.graph({ level: 'issue', issueId: key });
}

/** Most first; ties keep the order they were met in (node order). */
function byCountThenOrder(
  a: { n: number; order: number },
  b: { n: number; order: number }
): number {
  return b.n !== a.n ? b.n - a.n : a.order - b.order;
}

/**
 * Rows counted per child and sorted by count (descending), then by the
 * first node that counted for each, capped at NARROW_MAX_ROWS. Children
 * with no count never appear (they are never added).
 */
function rankRows(
  counted: Map<string, { row: Omit<GraphNarrowRow, 'count'>; n: number }>
): GraphNarrowRow[] {
  return [...counted.values()]
    .map((entry, order) => ({ ...entry, order }))
    .sort(byCountThenOrder)
    .slice(0, NARROW_MAX_ROWS)
    .map(({ row, n }) => ({ ...row, count: String(n) }));
}

/** Edges per node id, over the graph's edges. */
function edgeCounts(edges: readonly GraphEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
    counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
  }
  return counts;
}

/**
 * The narrower graphs offered when this one is past the draw limits: the
 * workspace's initiatives (or its projects, without initiatives), an
 * initiative's projects and a project's milestones, each at the same
 * level when it offers it, with how many of the drawn boxes each holds;
 * inside a milestone its 20 most connected issues, and in a chain the
 * focus's direct neighbours, each opening its own chain.
 */
function narrowRows(
  ctx: PageContext,
  graph: DependencyGraph,
  drawnNodes: readonly GraphNode[]
): GraphNarrowRow[] {
  const { snapshot, container, scope, hrefs } = ctx;
  const counted = new Map<
    string,
    { row: Omit<GraphNarrowRow, 'count'>; n: number }
  >();
  const count = (key: string, row: () => Omit<GraphNarrowRow, 'count'>) => {
    const entry = counted.get(key);
    if (entry !== undefined) entry.n += 1;
    else counted.set(key, { row: row(), n: 1 });
  };
  switch (container.kind) {
    case 'workspace':
      for (const node of drawnNodes) {
        if (ctx.hasInitiatives) {
          const id = node.initiativeId;
          if (id === null) continue;
          count(id, () => ({
            id,
            label: initiativeName(snapshot, id),
            kind: KIND_LABEL.initiative,
            href: hrefs.graph(
              graphScopeFor({ kind: 'initiative', id }, scope.level)
            ),
          }));
        } else {
          const id = node.projectId;
          if (id === null) continue;
          count(id, () => ({
            id,
            label: projectName(snapshot, id),
            kind: KIND_LABEL.project,
            href: hrefs.graph(
              graphScopeFor({ kind: 'project', id }, scope.level)
            ),
          }));
        }
      }
      return rankRows(counted);
    case 'initiative':
      for (const node of drawnNodes) {
        const id = node.projectId;
        if (node.external || id === null) continue;
        count(id, () => ({
          id,
          label: projectName(snapshot, id),
          kind: KIND_LABEL.project,
          href: hrefs.graph(
            graphScopeFor({ kind: 'project', id }, scope.level)
          ),
        }));
      }
      return rankRows(counted);
    case 'project':
      for (const node of drawnNodes) {
        const id = node.milestoneId;
        if (node.external || id === null) continue;
        count(id, () => ({
          id,
          label: snapshot.milestones.get(id)?.name ?? 'Unknown milestone',
          kind: KIND_LABEL.milestone,
          href: hrefs.graph({ level: 'issue', milestoneId: id }),
        }));
      }
      return rankRows(counted);
    case 'milestone':
      return mostConnectedRows(ctx, graph, drawnNodes, MOST_CONNECTED_ROWS);
    case 'chain':
      return mostConnectedRows(ctx, graph, drawnNodes, NARROW_MAX_ROWS);
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/** How many issues "Most connected issues" lists. */
const MOST_CONNECTED_ROWS = 20;

/**
 * The drawn issues with the most edges, most first, each opening its own
 * chain; in a chain only the focus's direct neighbours. This is what a
 * milestone and a chain offer past the draw limits, and what any issue
 * level falls back to when its boxes have no smaller container to narrow
 * to (issues with no project, or none with a milestone), so the too-large
 * state never ends in an empty list.
 */
function mostConnectedRows(
  ctx: PageContext,
  graph: DependencyGraph,
  drawnNodes: readonly GraphNode[],
  limit: number
): GraphNarrowRow[] {
  const { snapshot } = ctx;
  const edges = edgeCounts(graph.edges);
  const focus = graph.chain?.focusId ?? null;
  const neighbours = new Set<string>();
  if (focus !== null) {
    for (const edge of graph.edges) {
      if (edge.from === focus) neighbours.add(edge.to);
      if (edge.to === focus) neighbours.add(edge.from);
    }
  }
  return drawnNodes
    .map((node, order) => ({ node, order, n: edges.get(node.id) ?? 0 }))
    .filter(
      ({ node, n }) =>
        n > 0 && (focus === null ? !node.external : neighbours.has(node.id))
    )
    .sort(byCountThenOrder)
    .slice(0, limit)
    .map(({ node, n }) => ({
      id: node.id,
      label: issueRowLabel(snapshot, node),
      kind: KIND_LABEL.issue,
      count: String(n),
      href: chainHrefOf(ctx, node),
    }));
}

/**
 * The arrival box's own container at the same level, as the first narrow
 * row, so a link that meant "show me this box" still reaches it past the
 * draw limits: a milestone's project, or a project's first initiative.
 * Null when that container is the page itself or there is none.
 */
function arrivalRow(
  ctx: PageContext,
  node: GraphNode,
  drawnNodes: readonly GraphNode[]
): GraphNarrowRow | null {
  const { snapshot, scope, hrefs } = ctx;
  let own: GraphScope;
  let label: string;
  let kind: string;
  let inOwn: (other: GraphNode) => boolean;
  if (node.kind === 'milestone' && node.projectId !== null) {
    const projectId = node.projectId;
    own = { level: 'milestone', projectId };
    label = `${projectName(snapshot, projectId)} › ${node.label}`;
    kind = KIND_LABEL.project;
    inOwn = (other) => other.projectId === projectId;
  } else if (node.kind === 'project' && ctx.hasInitiatives) {
    const initiativeId = node.initiativeId ?? NO_INITIATIVE_ID;
    own = { level: 'project', initiativeId };
    label = `${initiativeName(snapshot, initiativeId)} › ${node.label}`;
    kind = KIND_LABEL.initiative;
    inOwn = (other) => other.initiativeId === initiativeId;
  } else {
    return null;
  }
  if (hrefs.graph(own) === ctx.scopeHref || own.level !== scope.level) {
    return null;
  }
  return {
    id: `node:${node.id}`,
    label,
    kind,
    count: String(
      drawnNodes.filter((other) => !other.external && inOwn(other)).length
    ),
    href: hrefs.graph(own, { node: node.id }),
  };
}

/* ---- the page --------------------------------------------------------------- */

/** "milestone", "issue": the level's noun in counts. */
function levelNoun(level: GraphLevel): string {
  return LEVEL_NOUN[level];
}

/** What the receipts say when no graph is drawn (or it is too large). */
function aboutSentence(ctx: PageContext, focusTitle: string | null): string {
  const { container } = ctx;
  const level = ctx.scope.level;
  switch (container.kind) {
    case 'workspace':
      return level === 'issue'
        ? 'Every issue in the workspace, and which wait on which, from their blocking relations.'
        : `Every ${levelNoun(level)} in the workspace, and which wait on which, from the blocking relations between open issues.`;
    case 'chain':
      return `${ctx.containerName} “${focusTitle ?? ''}”: everything it waits on and everything waiting on it, through open issues.`;
    case 'initiative':
    case 'project':
    case 'milestone':
      return `Every ${levelNoun(level)} ${containerPhrase(ctx, levelNoun(level))}, and which wait on which, from their blocking relations.`;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/* ---- readouts, the critical path in words, path words --------------------- */

/** Zero parts left out, joined: "3 ready · 5 blocked". */
function countParts(
  parts: readonly [count: number, word: string][],
  separator: string
): string {
  return parts
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(separator);
}

/** How many drawn nodes stand where: ready / blocked / with no
    dependencies / done; above the issue level clear / waiting / with no
    dependencies / complete / with no issues, plus their open issues. */
function readinessCounts(nodes: readonly GraphNode[]) {
  let ready = 0;
  let blocked = 0;
  let independent = 0;
  let done = 0;
  let empty = 0;
  let open = 0;
  let readyIssues = 0;
  for (const node of nodes) {
    if (node.readiness === 'ready') ready += 1;
    else if (node.readiness === 'blocked') blocked += 1;
    else if (node.readiness === 'independent') independent += 1;
    else if (node.readiness === 'empty') empty += 1;
    else done += 1;
    open += node.openIssues;
    readyIssues += node.readyIssues;
  }
  return { ready, blocked, independent, done, empty, open, readyIssues };
}

/** The readiness counts as count/word pairs, in reading order: what can
    start, what waits, what has no dependencies, what is finished, and
    above the issue level the boxes with no issues at all (never counted
    as complete: their names say "No issues yet"). */
function readinessParts(
  level: GraphLevel,
  c: ReturnType<typeof readinessCounts>
): [count: number, word: string][] {
  return level === 'issue'
    ? [
        [c.ready, 'ready'],
        [c.blocked, 'blocked'],
        [c.independent, 'with no dependencies'],
        [c.done, 'done'],
      ]
    : [
        [c.ready, 'clear'],
        [c.blocked, 'waiting'],
        [c.independent, 'with no dependencies'],
        [c.done, 'complete'],
        [c.empty, 'with no issues'],
      ];
}

/**
 * The Status highlight's idle readout over every drawn node: "3 ready ·
 * 5 blocked · 36 with no dependencies · 7 done" at the issue level; above
 * it "1 clear · 3 waiting · 11 with no dependencies · 1 complete · 1 with
 * no issues · 38 open issues: 33 can start, 5 blocked" (zero parts left
 * out; "can start" as in `openIssuesValue`).
 */
function statusReadout(level: GraphLevel, drawnNodes: readonly GraphNode[]) {
  const c = readinessCounts(drawnNodes);
  if (level === 'issue') return countParts(readinessParts(level, c), ' · ');
  const boxes = countParts(readinessParts(level, c), ' · ');
  if (c.open === 0) return boxes;
  const split = countParts(
    [
      [c.readyIssues, 'can start'],
      [c.open - c.readyIssues, 'blocked'],
    ],
    ', '
  );
  return `${boxes} · ${plural(c.open, 'open issue')}: ${split}`;
}

/** The Risk highlight's idle readout: "3 relations on a risk chain · 1
    cycle" (issues), "3 edges on a risk chain · no cycles" (boxes), or "No
    risk chains or cycles." */
function riskReadout(level: GraphLevel, risk: number, cycles: number): string {
  if (risk === 0 && cycles === 0) return 'No risk chains or cycles.';
  const noun = level === 'issue' ? 'relation' : 'edge';
  return [
    risk === 0 ? 'no risk chains' : `${plural(risk, noun)} on a risk chain`,
    cycles === 0 ? 'no cycles' : plural(cycles, 'cycle'),
  ].join(' · ');
}

/** A drawn node as copy names it: an issue's key, else its label cut to
    32 characters (ui pathNodeName, as the readout does). */
function copyName(byId: ReadonlyMap<string, GraphNodeData>, id: string) {
  const node = byId.get(id);
  return node === undefined ? id : pathNodeName(node);
}

/** "A and B", "A, B and C", then "A, B, C and 2 more": copy's caps. */
function cappedPhrase(names: readonly string[]): string {
  if (names.length <= 3) return listPhrase(names);
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** Whether the step group holding `id` is a cycle (or a self-loop). */
function groupIsCycle(chains: LongestChains, id: string): boolean {
  const group = chains.groupOf.get(id);
  return group !== undefined && chains.cyclic[group] === true;
}

/**
 * The Critical path highlight's idle readout: the chain shown at rest
 * (graph-wide, or through a chain's focus) with its count in the level's
 * noun and its steps ("Dual-write → Search v2 beta → Tokens and type");
 * where to start ("Start with Dual-write (clear).", or why nothing can:
 * the head waits outside the graph, or is a box where nothing can start);
 * and, when it runs through a cycle, that it cannot finish until the
 * cycle is broken. Above the issue level a cycle of boxes may be no issue
 * cycle at all (box arrows are not one issue chain), so it says so and
 * points at the Issues level instead.
 */
function criticalReadout(input: {
  chain: OpenChain | null;
  chains: LongestChains;
  byId: ReadonlyMap<string, GraphNodeData>;
  level: GraphLevel;
  focusId: string | null;
}): string {
  const { chain, chains, byId, level, focusId } = input;
  if (chain === null) {
    return 'No open chain: nothing drawn waits on anything open.';
  }
  const name = (id: string) => copyName(byId, id);
  const steps = chainPhrase(chain.groups.map((group) => group.map(name)));
  const count = plural(chain.length, levelNoun(level));
  const sentences: string[] = [
    focusId !== null && chain.steps.has(focusId)
      ? `Critical path through ${name(focusId)}: ${count}: ${steps}.`
      : chain.stepCount === 1
        ? `Critical path: ${count}: ${steps}.`
        : `Critical path: ${count}, each waiting on the one before: ${steps}.`,
  ];
  const head = chain.groups[0] ?? [];
  const headId = head[0];
  if (
    headId !== undefined &&
    head.length === 1 &&
    !groupIsCycle(chains, headId)
  ) {
    const readiness = byId.get(headId)?.readiness;
    if (readiness?.state === 'ready' && readiness.canStart !== false) {
      sentences.push(
        `Start with ${name(headId)} (${readiness.label.toLowerCase()}).`
      );
    } else if (readiness?.state === 'ready') {
      sentences.push(
        `It starts at ${name(headId)}, where nothing can start: a cycle inside holds it.`
      );
    } else if (readiness?.state === 'blocked') {
      sentences.push(
        `It starts at ${name(headId)}, which waits on ${readiness.blockedBy} more outside this graph.`
      );
    }
  }
  const cycles = chain.groups.filter(
    (group) => group[0] !== undefined && groupIsCycle(chains, group[0])
  );
  if (cycles.length > 0 && level === 'issue') {
    const clauses = cycles
      .map((group) =>
        group.length === 1
          ? `${name(group[0] ?? '')} blocks itself`
          : `${cappedPhrase(group.map(name))} wait on each other`
      )
      .join('; ');
    sentences.push(
      cycles.length === 1
        ? `It runs through a cycle (${clauses}), so it cannot finish until the cycle is broken.`
        : `It runs through ${cycles.length} cycles (${clauses}), so it cannot finish until they are broken.`
    );
  } else if (cycles.length > 0) {
    const groups = cycles.map((group) => cappedPhrase(group.map(name)));
    sentences.push(
      `It runs through boxes that wait on each other (${groups.join('; ')}); the Issues level shows whether their issues form a real cycle.`
    );
  }
  return sentences.join(' ');
}

/** The aria summary's readiness sentence: "3 ready, 5 blocked, 36 with
    no dependencies, 7 done." ("1 clear, 3 waiting, …" above the issue
    level). */
function readinessSentence(
  level: GraphLevel,
  drawnNodes: readonly GraphNode[]
): string {
  const parts = countParts(
    readinessParts(level, readinessCounts(drawnNodes)),
    ', '
  );
  return parts === '' ? '' : `${parts}.`;
}

/** The aria summary's critical-path sentence, with copy's caps: "Critical
    path: 3 issues: ENG-12, ENG-23, OPS-20." ('' without one). */
function criticalSentence(
  chain: OpenChain | null,
  byId: ReadonlyMap<string, GraphNodeData>,
  level: GraphLevel
): string {
  if (chain === null) return '';
  const steps = chainPhrase(
    chain.groups.map((group) => group.map((id) => copyName(byId, id))),
    undefined,
    ', '
  );
  return `Critical path: ${plural(chain.length, levelNoun(level))}: ${steps}.`;
}

/** How to trace, lock, open and drill into a box, in the idle readout
    (every box opens its task, and most have a graph). */
const GESTURE_WORDS: Partial<GraphPathWords> = {
  hint: 'Point at or focus a box to trace what it waits on and holds up; click it to lock the trace, double-click to open its graph.',
  tapHint:
    'Tap a box to lock the trace of what it waits on and holds up; tap it again to open it, or double-tap for its graph.',
  hintCritical:
    'Point at or focus a box to show the longest chain through it; click it to lock it, double-click to open its graph.',
  tapHintCritical:
    'Tap a box to lock the longest chain through it; tap it again to open it, or double-tap for its graph.',
};

/**
 * The readout's words for the level (ui GraphPathWords): issues are
 * counted as issues; above the issue level as the level's boxes, which
 * wait on other boxes ("Waits on 1", "Nothing outside it holds it up"),
 * are cleared rather than unblocked ("Finishing it would clear 1: …",
 * the "Clear next" pill) and read "Complete" when done.
 */
export function pathWordsFor(level: GraphLevel): Partial<GraphPathWords> {
  if (level === 'issue') {
    return { unit: ['issue', 'issues'], ...GESTURE_WORDS };
  }
  const noun = levelNoun(level);
  return {
    ...GESTURE_WORDS,
    unit: [noun, `${noun}s`],
    waitsOn: 'Waits on {n}',
    waitsOnNone: 'Nothing outside it holds it up',
    waitsOnOutside: 'Waits on {n} outside this graph',
    unblock: 'Finishing it would clear {n}: {names}',
    next: 'Clear next',
    done: 'Complete',
  };
}

/* ---- receipts: what is drawn ---------------------------------------------- */

/**
 * Where the drawn issues sit, as the frames show it, after "N issues in
 * X": ", in 3 milestones", ", 45 of them in 16 milestones", or ", none in
 * a milestone".
 */
function milestonesClause(issues: readonly GraphNode[]): string {
  const ids = new Set<string>();
  let placed = 0;
  for (const issue of issues) {
    if (issue.milestoneId === null) continue;
    placed += 1;
    ids.add(issue.milestoneId);
  }
  if (placed === 0) {
    return issues.length === 1
      ? ', not in a milestone'
      : ', none in a milestone';
  }
  const where = plural(ids.size, 'milestone');
  return placed === issues.length
    ? `, in ${where}`
    : `, ${placed} of them in ${where}`;
}

/** " in 2 initiatives, 1 with no initiative" after "N projects" (nothing
    in a workspace without initiatives): the frames of the project level. */
function initiativesClause(
  ctx: PageContext,
  projects: readonly GraphNode[]
): string {
  if (!ctx.hasInitiatives) return '';
  const ids = new Set<string>();
  let none = 0;
  for (const project of projects) {
    const id = project.initiativeId;
    if (id === null || id === NO_INITIATIVE_ID) none += 1;
    else ids.add(id);
  }
  const homes = ids.size === 0 ? '' : ` in ${plural(ids.size, 'initiative')}`;
  if (none === 0) return homes;
  if (ids.size === 0) return ', none in an initiative';
  return `${homes}, ${none} with no initiative`;
}

/** "6 blocking relations", "no blocking edges": the arrows, counted. */
function arrowsPhrase(count: number, level: GraphLevel): string {
  const word = level === 'issue' ? 'blocking relation' : 'blocking edge';
  return count === 0 ? `no ${word}s` : plural(count, word);
}

/** Builds everything the Graph destination shows from the planning graph
    and snapshot. */
export function buildGraphPage(input: GraphPageInput): GraphPageModel {
  const { graph, snapshot, assessments, today, hrefs } = input;
  const scope = graph.scope;
  const container = graphContainer(scope);
  const level = scope.level;
  const isChain = container.kind === 'chain';
  const focusIssue =
    graph.chain === null ? undefined : snapshot.issues.get(graph.chain.focusId);
  const focusKey = focusIssue?.identifier ?? graph.chain?.focusId ?? null;
  const scopeHref = isChain
    ? hrefs.graph({ level: 'issue', issueId: focusKey ?? container.id })
    : hrefs.graph(scope);
  const ctx: PageContext = {
    snapshot,
    assessments,
    today,
    hrefs,
    scope,
    container,
    scopeHref,
    containerName: containerName(snapshot, container),
    hasInitiatives: snapshot.initiatives.size > 0,
    home: homeInitiativeIds(snapshot),
    plans: new Map(input.allocationPlan.projects.map((p) => [p.projectId, p])),
    drawnBlockers: new Map(),
  };
  const name = ctx.containerName;
  const noun = levelNoun(level);

  // `nodeId` selects a box on arrival, when it is in this graph.
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const arrival = input.nodeId != null ? nodeById.get(input.nodeId) : undefined;

  // Every item of the scope is drawn, on an edge or not (owner decision
  // 2026-10-23): the empty state is only for a scope with nothing in it,
  // and for a chain whose issue has no relation. Past the draw limits the
  // view shows narrower graphs instead, building no node data, details,
  // layout or Mermaid.
  const hasNodes =
    graph.nodes.length > 0 && (!isChain || graph.edges.length > 0);
  const overLimit =
    hasNodes &&
    (graph.nodes.length > GRAPH_DRAW_LIMITS.nodes ||
      graph.edges.length > GRAPH_DRAW_LIMITS.edges);
  const drawn = hasNodes && !overLimit;

  const built: GraphNodeData[] = [];
  const details: Record<string, GraphNodeDetail> = {};
  const labels = new Map<string, string>();
  for (const node of graph.nodes) labels.set(node.id, node.label);
  // Where a double-click on each box and frame title goes: its own graph
  // one level down, or its panel's next drill-down link (graphDrill.ts).
  const drills = drawn
    ? drillTargets({
        snapshot,
        nodes: graph.nodes,
        clusters: isChain ? [] : graph.clusters,
        level,
        pageHref: scopeHref,
        graph: hrefs.graph,
      })
    : { nodes: new Map<string, string>(), clusters: new Map<string, string>() };
  if (drawn) {
    for (const edge of graph.edges) {
      if (!edge.blocking || edge.from === edge.to) continue;
      const names = ctx.drawnBlockers.get(edge.to) ?? [];
      const blocker = labels.get(edge.from) ?? edge.from;
      if (!names.includes(blocker)) names.push(blocker);
      ctx.drawnBlockers.set(edge.to, names);
    }
    for (const node of graph.nodes) {
      const face = nodeFace(ctx, node);
      const data: GraphNodeData = {
        id: node.id,
        label: node.label,
        sublabel: face.sublabel,
        tone: nodeTone(node),
        status: face.mark.status,
        statusLabel:
          node.kind === 'issue'
            ? face.mark.label
            : quietLabel(node, face.mark.label),
        tags: nodeTags(node),
        readiness: nodeReadiness(node),
      };
      // Every box but "No initiative" is a task: a plain click (no
      // onSelect) and the lock strip's Open follow it.
      if (node.id !== NO_INITIATIVE_ID) data.href = hrefs.task(node.id);
      if (node.kind === 'issue') {
        const key = snapshot.issues.get(node.id)?.identifier;
        if (key !== undefined) data.key = key;
      }
      if (node.clusterId !== null) data.cluster = node.clusterId;
      if (node.external) data.external = true;
      const drill = drills.nodes.get(node.id);
      if (drill !== undefined) data.drillHref = drill;
      details[node.id] = nodeDetail(ctx, node, face.mark);
      built.push(data);
    }
  }
  // The host's overlay sees every box once, before anything measures it.
  const nodes = input.overlay === undefined ? built : input.overlay(built);
  const edges: GraphEdgeData[] = drawn
    ? graph.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        kind: edgeKind(edge, level),
        weight: edge.weight,
        cross: crossesBoundary(edge, level),
      }))
    : [];
  const clusters = drawn ? clusterData(graph.clusters, drills.clusters) : [];

  const edgeCount = graph.edges.length;
  const riskCount = edges.filter((e) => e.kind === 'risk').length;
  const crossProjects = graph.edges.filter(
    (e) => e.crossProject && e.blocking
  ).length;
  const crossInitiatives = graph.edges.filter(
    (e) => e.crossInitiative && e.blocking
  ).length;
  // Edges that no longer block (one end done): "unblocked", as the legend.
  const resolvedCount = edges.filter((e) => e.kind === 'resolved').length;
  const cycleCount = graph.cycles.length;
  const cycles = cyclesPhrase(graph.cycles, labels);
  const cyclesPart = cycleCount > 0 ? plural(cycleCount, 'cycle') : null;
  const riskPart = riskCount > 0 ? `${riskCount} on a risk chain` : null;
  const resolvedPart = resolvedCount > 0 ? `${resolvedCount} unblocked` : null;
  const crossPart =
    level === 'project'
      ? ctx.hasInitiatives && crossInitiatives > 0
        ? `${crossInitiatives} across initiatives`
        : null
      : level === 'milestone' && crossProjects > 0
        ? `${crossProjects} across projects`
        : null;
  const insideNodes = graph.nodes.filter((n) => !n.external);
  const outside = graph.nodes.length - insideNodes.length;
  const inside = insideNodes.length;
  const arrows = arrowsPhrase(edges.length, level);
  const metaCycles =
    cycleCount === 0 ? '' : ` · ${plural(cycleCount, 'cycle')}`;
  const meta = overLimit
    ? `${plural(graph.nodes.length, noun)} · ${plural(edgeCount, 'edge')} · too many to draw`
    : drawn
      ? `${plural(nodes.length, noun)} · ${plural(edges.length, 'edge')}${metaCycles}`
      : isChain
        ? 'No edges'
        : `No ${noun}s`;

  // "in Dual-write", or "with no initiative" for that group of projects.
  const where = containerPhrase(ctx, noun);
  const noInitiative =
    container.kind === 'initiative' && container.id === NO_INITIATIVE_ID;
  const outsidePart =
    outside === 0
      ? ''
      : `, plus ${plural(outside, noun)} ${noInitiative ? 'elsewhere' : 'outside it'} that ${outside === 1 ? 'blocks or waits' : 'block or wait'} on them`;

  let receipts: string;
  let ariaSummary: string;
  let emptyMessage: string;
  switch (container.kind) {
    case 'workspace': {
      switch (level) {
        case 'initiative': {
          // The cycles' names go in parentheses so the sentence keeps one
          // colon: "…: 1 on a risk chain and 1 cycle (A and B wait on each
          // other)."
          const namedCycles =
            cycleCount === 0
              ? null
              : `${plural(cycleCount, 'cycle')} (${graph.cycles.map((c) => cycleClause(c, labels)).join('; ')})`;
          const named = graph.nodes.filter(
            (n) => n.id !== NO_INITIATIVE_ID
          ).length;
          const boxes =
            named === graph.nodes.length
              ? plural(named, 'initiative')
              : named === 0
                ? 'The projects with no initiative'
                : `${plural(named, 'initiative')} and the projects with no initiative`;
          receipts = `${boxes}; ${arrows}${detailClause([riskPart, namedCycles])}. Select an initiative to see its projects.`;
          ariaSummary = `Initiative dependency graph of the workspace: ${boxes.charAt(0).toLowerCase()}${boxes.slice(1)}, with ${arrows}, ${riskCount} on a risk chain; ${cycles}.`;
          break;
        }
        case 'project': {
          const homes = initiativesClause(ctx, graph.nodes);
          receipts = `${plural(nodes.length, 'project')}${homes}; ${arrows}${detailClause([riskPart, crossPart, cyclesPart])}. Select a project to see its milestones and issues.`;
          ariaSummary = `Project dependency graph of the workspace: ${plural(nodes.length, 'project')}${homes}, with ${arrows}, ${riskCount} on a risk chain; ${cycles}.`;
          break;
        }
        case 'milestone': {
          const projects = plural(
            new Set(graph.nodes.map((n) => n.projectId)).size,
            'project'
          );
          receipts = `${plural(nodes.length, 'milestone')} in ${projects}; ${arrows}${detailClause([riskPart, crossPart, cyclesPart])}. Select a milestone to see its issues.`;
          ariaSummary = `Milestone dependency graph: ${plural(nodes.length, 'milestone')} in ${projects}, with ${arrows}, ${riskCount} on a risk chain and ${crossProjects} across projects; ${cycles}.`;
          break;
        }
        case 'issue': {
          const placed = milestonesClause(graph.nodes);
          receipts = `${plural(nodes.length, 'issue')} in the workspace${placed}; ${arrows}${detailClause([riskPart, resolvedPart, cyclesPart])}.`;
          ariaSummary = `Issue dependency graph of the workspace: ${plural(nodes.length, 'issue')}${placed}, with ${arrows}, ${riskCount} on a risk chain and ${resolvedCount} unblocked; ${cycles}.`;
          break;
        }
        default: {
          const unreachable: never = level;
          return unreachable;
        }
      }
      emptyMessage = `No ${noun}s in the workspace.`;
      if (!drawn) receipts = aboutSentence(ctx, null);
      break;
    }
    case 'initiative':
    case 'project':
    case 'milestone': {
      if (level === 'issue') {
        // A milestone is one frame: no "in N milestones" inside it.
        const placed =
          container.kind === 'milestone' ? '' : milestonesClause(insideNodes);
        receipts = `${plural(inside, 'issue')} ${where}${placed}${outsidePart}; ${arrows}${detailClause([riskPart, resolvedPart, cyclesPart])}.`;
        ariaSummary = `Issue dependency graph for ${name}: ${plural(inside, 'issue')} in scope${placed} and ${plural(outside, 'outside issue')}, with ${arrows}, ${riskCount} on a risk chain and ${resolvedCount} unblocked; ${cycles}.`;
      } else {
        receipts = `${plural(inside, noun)} ${where}${outsidePart}; ${arrows}${detailClause([riskPart, crossPart, cyclesPart])}.`;
        ariaSummary = `${KIND_LABEL[level]} dependency graph for ${name}: ${plural(inside, noun)} in scope and ${plural(outside, `outside ${noun}`)}, with ${arrows}, ${riskCount} on a risk chain; ${cycles}.`;
      }
      emptyMessage = `No ${noun}s ${where}.`;
      if (!drawn) receipts = aboutSentence(ctx, null);
      break;
    }
    case 'chain': {
      const chain = graph.chain;
      const title = focusIssue?.title ?? '';
      const projects = new Set(
        graph.nodes
          .map((n) => n.projectId)
          .filter((id): id is string => id !== null)
      ).size;
      receipts = drawn
        ? `${name} “${title}”: ${plural(chain?.upstream ?? 0, 'issue')} upstream and ${chain?.downstream ?? 0} downstream, across ${plural(projects, 'project')}; ${plural(edges.length, 'blocking relation')}${detailClause([riskPart, resolvedPart, cyclesPart])}.`
        : overLimit
          ? aboutSentence(ctx, title)
          : `${name} “${title}” neither blocks nor waits on another issue.`;
      ariaSummary = `Blocking chain of ${name}: ${plural(nodes.length, 'issue')} joined by ${plural(edges.length, 'blocking relation')}, ${riskCount} on a risk chain and ${resolvedCount} unblocked; ${cycles}. ${name} is the focus.`;
      emptyMessage = `${name} neither blocks nor waits on another issue.`;
      break;
    }
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
  if (!drawn && !overLimit) ariaSummary = emptyMessage;

  const notices: GraphNotice[] = [];
  if (graph.fallback !== null) {
    notices.push({ id: 'fallback', text: FALLBACK_TEXT });
  }
  if (graph.unplacedRelations > 0) {
    const n = graph.unplacedRelations;
    const what = level === 'milestone' ? 'milestone' : 'project';
    notices.push({
      id: 'unplaced',
      text:
        n === 1
          ? `1 blocking relation involves an issue with no ${what}, so this level cannot place it; the Issues tab shows it.`
          : `${n} blocking relations involve issues with no ${what}, so this level cannot place them; the Issues tab shows them.`,
    });
  }
  if (container.kind === 'initiative') {
    const shared = sharedNotice(ctx, container.id);
    if (shared !== null) notices.push({ id: 'shared', text: shared });
  }
  if (focusIssue !== undefined && !isIssueOpen(snapshot, focusIssue)) {
    notices.push({
      id: 'chain-closed',
      text: `${name} is closed, so only its own relations are drawn.`,
    });
  }
  if (graph.chain !== null && graph.chain.hidden > 0) {
    notices.push({
      id: 'chain-cut',
      text: `Drawn: the nearest ${graph.nodes.length} issues; ${graph.chain.hidden} more are further out. Issues marked +N more lead on: open one and choose Graph to follow its chain.`,
    });
  }

  let tooLarge: GraphTooLarge | null = null;
  if (overLimit) {
    const relationWord = level === 'issue' ? 'relation' : 'edge';
    let rows = narrowRows(ctx, graph, graph.nodes);
    // Issues with no project (or, in a project, no milestone) have no
    // smaller container: offer the most connected ones instead.
    let byIssue = container.kind === 'milestone';
    if (rows.length === 0 && level === 'issue' && !isChain) {
      rows = mostConnectedRows(ctx, graph, graph.nodes, MOST_CONNECTED_ROWS);
      byIssue = true;
    }
    if (arrival !== undefined) {
      const first = arrivalRow(ctx, arrival, graph.nodes);
      if (first !== null) {
        const plain = first.href.replace(/[?&]node=[^&]*$/, '');
        rows.unshift(first);
        const dup = rows.findIndex((row, i) => i > 0 && row.href === plain);
        if (dup !== -1) rows.splice(dup, 1);
      }
    }
    // "Narrow it down:" only introduces rows that follow it.
    const limits = `and the graph draws at most ${GRAPH_DRAW_LIMITS.nodes.toLocaleString('en-US')} boxes and ${GRAPH_DRAW_LIMITS.edges.toLocaleString('en-US')} arrows${rows.length > 0 ? '. Narrow it down:' : '.'}`;
    tooLarge = isChain
      ? {
          message: `Too many to draw: the nearest ${plural(graph.nodes.length, 'issue')} on ${name}’s chain are joined by ${plural(edgeCount, 'blocking relation')}.`,
          title: 'Its direct neighbours',
          note: 'Open one’s chain to follow it.',
          rows,
        }
      : {
          message: `Too many to draw: ${plural(graph.nodes.length, noun)} ${where} with ${plural(edgeCount, `blocking ${relationWord}`)}, ${limits}`,
          title: byIssue ? 'Most connected issues' : 'Narrow to',
          note: byIssue ? 'Open one’s chain to follow it.' : null,
          rows,
        };
    ariaSummary = tooLarge.message;
  }

  // The critical path shown at rest: graph-wide, or through a chain's
  // focus. The ui's own walk over the drawn nodes and edges (the canvas
  // runs the same one), so the readout, the aria summary and the Mermaid
  // export name exactly what the drawing numbers.
  const focusId = drawn ? (graph.chain?.focusId ?? null) : null;
  const chains = drawn ? longestChains(nodes, edges) : null;
  const critical = chains === null ? null : longestChain(chains, focusId);
  const nodeData = new Map(nodes.map((node) => [node.id, node]));
  if (drawn) {
    ariaSummary = [
      ariaSummary,
      readinessSentence(level, graph.nodes),
      criticalSentence(critical, nodeData, level),
    ]
      .filter((part) => part !== '')
      .join(' ');
  }
  const readouts: Record<GraphHighlight, string> =
    chains === null
      ? { status: '', risk: '', critical: '' }
      : {
          status: statusReadout(level, graph.nodes),
          risk: riskReadout(level, riskCount, cycleCount),
          critical: criticalReadout({
            chain: critical,
            chains,
            byId: nodeData,
            level,
            focusId,
          }),
        };

  const initialSelectedId = drawn && arrival !== undefined ? arrival.id : null;
  const heading = graphHeading(snapshot, scope);
  // A chain keeps its one dagre flow; every other scope is laid out in
  // its frames (the initiative level's are none: its loose boxes pack).
  const layout = drawn
    ? cachedLayoutGraph(
        nodes,
        edges,
        isChain ? { direction: 'LR' } : { direction: 'LR', clusters }
      )
    : null;
  return {
    level,
    container,
    scopeHref,
    pageKey:
      initialSelectedId === null
        ? scopeHref
        : hrefs.graph(scope, { node: initialSelectedId }),
    heading,
    receipts,
    notices,
    trail: graphTrail(snapshot, scope, hrefs.graph),
    tabs: levelTabs(scope, {
      hasInitiatives: ctx.hasInitiatives,
      graph: hrefs.graph,
    }),
    blockTitle: isChain ? 'Chain' : GRAPH_LEVEL_LABEL[level],
    meta,
    nodes,
    edges,
    clusters,
    layout,
    details,
    tooLarge,
    initialSelectedId,
    focusId,
    ariaSummary,
    emptyMessage,
    legends: legendsFor(ctx, drawn ? graph.clusters : []),
    readouts,
    pathWords: pathWordsFor(level),
    mermaid: drawn ? mermaidParts(graph, { critical }) : null,
    crumb:
      container.kind === 'workspace'
        ? null
        : isChain
          ? `Chain of ${name}`
          : heading,
  };
}
