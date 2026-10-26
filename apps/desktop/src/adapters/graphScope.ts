import type {
  GraphContainer,
  GraphHighlight,
  GraphLevel,
  GraphScope,
  Snapshot,
} from '@dispatch/planning';
import {
  DEFAULT_GRAPH_LEVEL,
  findIssue,
  GRAPH_LEVELS_WITHIN,
  graphContainer,
  graphScopeFor,
  homeInitiativeIds,
  NO_INITIATIVE_ID,
} from '@dispatch/planning';
import type { NavTabItem, ShellCrumb } from '@dispatch/ui';

// The Graph destination's scope vocabulary, ported from the planner's
// lib/adapters/graph-scope.ts (Better-Tracker): writing a scope as an href
// and reading it back, the drill-up trail, the level tabs and the highlight
// words. Pure functions over @dispatch/planning's GraphScope.
//
// What changed in the port: a graph href is the Graph page's route
// (lib/routes.ts reads `#/graph` plus the planner's query vocabulary
// (?initiative=, ?project=, ?milestone=, ?chain=, ?level=, ?node=) through
// `parseGraphParams` and writes it with `graphHref`), so every link written
// here is a real href the nav reducer lands on. The highlight and the locked
// box are the view's own state, not URL parameters or a cookie, so their
// read/write helpers (withHighlightParam, carryLock, highlightCookie…) are
// gone; `parseHighlight` stays for the day a link carries one. Every function
// that writes a graph link takes the writer (`GraphScopeHref`, `graphHref` by
// default) so a caller can hand in another.

/** The Graph page's route path (lib/routes.ts). */
export const GRAPH_PATH = '#/graph';

/** At most this many characters of an id from a link reach the planning core. */
export const MAX_ID_LENGTH = 200;

/**
 * The most a graph draws (the planner's §11.2, kept). Every item of a scope
 * is drawn, so a workspace's issue level holds every task: at 700 boxes and
 * 1,000 arrows the framed layout plus the page model stays near a second on
 * the client (graph.test.ts times it). Past either, the view shows "Too
 * many to draw" and narrower graphs instead of a partial drawing that would
 * hide risk.
 */
export const GRAPH_DRAW_LIMITS: {
  readonly nodes: number;
  readonly edges: number;
} = { nodes: 700, edges: 1000 };

/** Rows of the too-large state's "Narrow to" list. */
export const NARROW_MAX_ROWS = 50;

/** Each level's tab and block-bar name. */
export const GRAPH_LEVEL_LABEL: Readonly<Record<GraphLevel, string>> = {
  initiative: 'Initiatives',
  project: 'Projects',
  milestone: 'Milestones',
  issue: 'Issues',
};

/** Writes the link to a graph scope (and the box to select on arrival). */
export type GraphScopeHref = (
  scope: GraphScope,
  options?: { node?: string | null }
) => string;

type SearchParams = Record<string, string | string[] | undefined>;

/** The first value of a parameter, trimmed; null when blank or too long. */
function pickParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return null;
  const id = raw.trim();
  return id === '' || id.length > MAX_ID_LENGTH ? null : id;
}

/** ?level= read leniently: any case, a trailing "s" dropped ("Issues"). */
function parseLevel(value: string | string[] | undefined): GraphLevel | null {
  const raw = pickParam(value)?.toLowerCase();
  if (raw === undefined) return null;
  const singular = raw.endsWith('s') ? raw.slice(0, -1) : raw;
  return isGraphLevel(singular) ? singular : null;
}

/** One of the four levels. An own key only: `in` would also accept
    Object.prototype's names ("constructor", "__proto__", "toString"). */
function isGraphLevel(value: string): value is GraphLevel {
  return Object.hasOwn(GRAPH_LEVEL_LABEL, value);
}

/**
 * The graph a set of link parameters asks for, and the box to select on
 * arrival. The narrowest container wins (?chain= > ?milestone= > ?project=
 * > ?initiative=, else the whole workspace). ?level= is used only when
 * that container offers it, otherwise the container's default level
 * applies (a bad level never fails). Ids are passed through as given: the
 * planning core checks them, and a chain may name its issue by identifier.
 */
export function parseGraphParams(params: SearchParams): {
  scope: GraphScope;
  nodeId: string | null;
} {
  const chain = pickParam(params.chain);
  const milestone = pickParam(params.milestone);
  const project = pickParam(params.project);
  const initiative = pickParam(params.initiative);
  const container: GraphContainer =
    chain !== null
      ? { kind: 'chain', id: chain }
      : milestone !== null
        ? { kind: 'milestone', id: milestone }
        : project !== null
          ? { kind: 'project', id: project }
          : initiative !== null
            ? { kind: 'initiative', id: initiative }
            : { kind: 'workspace' };
  const level = parseLevel(params.level) ?? undefined;
  return {
    scope: graphScopeFor(container, level),
    nodeId: pickParam(params.node),
  };
}

/**
 * Reads a graph link back (the inverse of `graphHref`): the whole href
 * (`#/graph?milestone=ms-1`), its query alone (`milestone=ms-1`) or a link
 * with a different path before the `?`. A repeated parameter keeps its
 * first value, as `parseGraphParams` does.
 */
export function parseGraphScope(href: string): {
  scope: GraphScope;
  nodeId: string | null;
} {
  const at = href.indexOf('?');
  const query =
    at === -1 ? (href.startsWith('#') ? '' : href) : href.slice(at + 1);
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    const seen = params[key];
    if (seen === undefined) params[key] = value;
    else params[key] = [...(Array.isArray(seen) ? seen : [seen]), value];
  }
  return parseGraphParams(params);
}

/**
 * A scope as link parameters, in the planner's canonical order: the
 * container parameter first, then ?level= only when it is not the
 * container's default, then ?node=. '' for the workspace's default level.
 * A chain is written with whatever its scope carries (the planning core's
 * resolved scope carries the issue id; links to a chain use `chainHref`
 * with the identifier instead).
 */
export function serialiseGraphScope(
  scope: GraphScope,
  options: { node?: string | null } = {}
): string {
  const container = graphContainer(scope);
  const parts: string[] = [];
  switch (container.kind) {
    case 'workspace':
      break;
    case 'initiative':
      parts.push(`initiative=${encodeURIComponent(container.id)}`);
      break;
    case 'project':
      parts.push(`project=${encodeURIComponent(container.id)}`);
      break;
    case 'milestone':
      parts.push(`milestone=${encodeURIComponent(container.id)}`);
      break;
    case 'chain':
      parts.push(`chain=${encodeURIComponent(container.id)}`);
      break;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
  if (scope.level !== DEFAULT_GRAPH_LEVEL[container.kind]) {
    parts.push(`level=${scope.level}`);
  }
  const node = options.node ?? null;
  if (node !== null) parts.push(`node=${encodeURIComponent(node)}`);
  return parts.join('&');
}

/** The canonical graph link of a scope: GRAPH_PATH plus its parameters. */
export const graphHref: GraphScopeHref = (scope, options = {}) => {
  const query = serialiseGraphScope(scope, options);
  return query === '' ? GRAPH_PATH : `${GRAPH_PATH}?${query}`;
};

/** One issue's blocking chain, by identifier ("#/graph?chain=ENG-24"). */
export function chainHref(key: string): string {
  return graphHref({ level: 'issue', issueId: key });
}

/* ---- the highlight ------------------------------------------------------- */

/** Each highlight's switch label, in switch order. */
export const GRAPH_HIGHLIGHT_LABEL: Readonly<Record<GraphHighlight, string>> = {
  status: 'Status',
  risk: 'Risk',
  critical: 'Critical path',
};

/** The highlights, in switch order. */
export const GRAPH_HIGHLIGHTS: readonly GraphHighlight[] = [
  'status',
  'risk',
  'critical',
];

/**
 * What a graph is drawn with when nothing says otherwise: Risk, the
 * canvas's own default (the planner opened on Status; Dispatch's graph
 * leads with the overdue tints and the risk chains, what the Timeline's
 * banners point at). The view remembers the last pick per window.
 */
export const DEFAULT_GRAPH_HIGHLIGHT: GraphHighlight = 'risk';

/** One of the three highlights. An own key only, like isGraphLevel, so
    "constructor" or "__proto__" never pass. */
function isGraphHighlight(value: string): value is GraphHighlight {
  return Object.hasOwn(GRAPH_HIGHLIGHT_LABEL, value);
}

/**
 * A highlight read leniently from a link or a saved preference: the first
 * value of a repeated parameter, trimmed, any case, with "critical-path"
 * and "criticalpath" meaning critical. Anything else is null, never an
 * error.
 */
export function parseHighlight(
  value: string | string[] | undefined | null
): GraphHighlight | null {
  const raw = pickParam(value ?? undefined)?.toLowerCase();
  if (raw === undefined) return null;
  const id =
    raw === 'critical-path' || raw === 'criticalpath' ? 'critical' : raw;
  return isGraphHighlight(id) ? id : null;
}

/* ---- names, the trail and the tabs --------------------------------------- */

/** "Platform reliability", or "No initiative" for NO_INITIATIVE_ID. */
export function initiativeName(snapshot: Snapshot, id: string): string {
  if (id === NO_INITIATIVE_ID) return 'No initiative';
  return snapshot.initiatives.get(id)?.name ?? 'Unknown initiative';
}

/**
 * The drill-up trail above the heading: Workspace › first initiative ›
 * project › milestone › issue key, built from the planning snapshot, empty
 * for the four workspace levels. Missing levels are skipped (an issue with
 * no milestone reads "… › Atlas › ENG-18"), and the initiative crumb is
 * left out when the workspace has no initiatives. Each ancestor links to
 * itself at its natural level, one below it, so drilling up zooms out; the
 * last crumb is the page.
 */
export function graphTrail(
  snapshot: Snapshot,
  scope: GraphScope,
  graph: GraphScopeHref
): ShellCrumb[] {
  const container = graphContainer(scope);
  const hasInitiatives = snapshot.initiatives.size > 0;
  let initiativeId: string | null = null;
  let projectId: string | null = null;
  let milestoneId: string | null = null;
  let issueKey: string | null = null;
  switch (container.kind) {
    case 'workspace':
      return [];
    case 'initiative':
      initiativeId = container.id;
      break;
    case 'project':
      projectId = container.id;
      break;
    case 'milestone':
      milestoneId = container.id;
      projectId = snapshot.milestones.get(container.id)?.projectId ?? null;
      break;
    case 'chain': {
      const issue = findIssue(snapshot.issues, container.id);
      issueKey = issue?.identifier ?? container.id;
      projectId = issue?.projectId ?? null;
      milestoneId = issue?.milestoneId ?? null;
      break;
    }
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
  if (projectId !== null && !snapshot.projects.has(projectId)) {
    projectId = null;
  }
  if (milestoneId !== null && !snapshot.milestones.has(milestoneId)) {
    milestoneId = null;
  }
  if (projectId !== null && hasInitiatives) {
    initiativeId =
      homeInitiativeIds(snapshot).get(projectId) ?? NO_INITIATIVE_ID;
  }

  const trail: ShellCrumb[] = [
    {
      label: 'Workspace',
      href: graph({ level: hasInitiatives ? 'initiative' : 'project' }),
    },
  ];
  if (initiativeId !== null && hasInitiatives) {
    trail.push({
      label: initiativeName(snapshot, initiativeId),
      href: graph({ level: 'project', initiativeId }),
    });
  }
  if (projectId !== null) {
    trail.push({
      label: snapshot.projects.get(projectId)?.name ?? 'Unknown project',
      href: graph({ level: 'milestone', projectId }),
    });
  }
  if (milestoneId !== null) {
    trail.push({
      label: snapshot.milestones.get(milestoneId)?.name ?? 'Unknown milestone',
      href: graph({ level: 'issue', milestoneId }),
    });
  }
  if (issueKey !== null) trail.push({ label: issueKey });
  // The last crumb is the page itself: shown, not linked.
  const last = trail[trail.length - 1];
  if (last !== undefined) trail[trail.length - 1] = { label: last.label };
  return trail;
}

/**
 * The level tabs of a scope: exactly the levels its container offers
 * (GRAPH_LEVELS_WITHIN), the scope's own marked current. The workspace
 * leaves out Initiatives when there are none. A milestone or a chain
 * offers one level, so it gets no tabs: the trail is the way up.
 */
export function levelTabs(
  scope: GraphScope,
  options: { hasInitiatives: boolean; graph: GraphScopeHref }
): NavTabItem[] {
  const container = graphContainer(scope);
  const levels = GRAPH_LEVELS_WITHIN[container.kind].filter(
    (level) =>
      options.hasInitiatives ||
      container.kind !== 'workspace' ||
      level !== 'initiative'
  );
  if (levels.length <= 1) return [];
  return levels.map((level) => ({
    id: level,
    label: GRAPH_LEVEL_LABEL[level],
    href: options.graph(graphScopeFor(container, level)),
    current: level === scope.level,
  }));
}
