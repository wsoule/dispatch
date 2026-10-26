// The domain model every package shares. Linear stays the source of truth:
// the "mirrored" types below are normalized copies of Linear entities; the
// "tool-owned" types are data only this tool stores (weights, "done means…",
// settings). Everything here is plain data so it can cross the server/client
// boundary and be stored as JSON.

/** A calendar date, `YYYY-MM-DD` (Linear's TimelessDate). */
export type IsoDate = string;
/** An instant, ISO-8601 with timezone (e.g. `2026-10-21T15:00:00.000Z`). */
export type IsoDateTime = string;

/**
 * Linear priority: 0 = no priority, 1 = urgent, 2 = high, 3 = medium
 * (shown as "normal" in some Linear UIs), 4 = low.
 */
export type Priority = 0 | 1 | 2 | 3 | 4;

/**
 * Linear workflow state categories. Linear's API also reports "duplicate";
 * the gateway maps it to "canceled" (closed) and keeps the state's name.
 */
export type WorkflowStateType =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled';

/** Linear project status categories (ProjectStatus.type). */
export type ProjectStatusType =
  | 'backlog'
  | 'planned'
  | 'started'
  | 'paused'
  | 'completed'
  | 'canceled';

// ---------------------------------------------------------------------------
// Mirrored Linear entities
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  name: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  /** False once the user is deactivated (suspended) in Linear. */
  active: boolean;
  /** An app user (e.g. this tool's own actor=app identity), never a person. */
  app: boolean;
  /**
   * A Linear guest: they see only the teams they are a member of (§2.13),
   * and the planner is read-only for them (owner decision 2026-10-22,
   * "Guests limited to read only"; the engine's Actor.readOnly). Absent on
   * mirrors written before 2026-10-22 (read as not a guest).
   */
  guest?: boolean;
}

/**
 * Linear's Team.visibility: `public` teams are visible to every workspace
 * member, `private` ones only to their members, and `restricted` ones are
 * non-private teams inside a private team's boundary (a sub-team of a
 * private team), visible to the members of that boundary.
 */
export type TeamVisibility = 'public' | 'private' | 'restricted';

export interface Team {
  id: string;
  key: string;
  name: string;
  /**
   * Who may see the team's issues and projects (§2.13). Absent on mirrors
   * written before 2026-10-22: such a team is shown to nobody until the
   * next sync (the engine syncs such a mirror before reading it).
   */
  visibility?: TeamVisibility;
  /** The parent team of a sub-team, else null (absent: unknown, none). */
  parentId?: string | null;
  /** Ids of the team's members (Linear team memberships; absent: none known). */
  memberIds?: string[];
}

export interface WorkflowState {
  id: string;
  teamId: string;
  name: string;
  type: WorkflowStateType;
  /**
   * Linear's ordering of states within their type group (triage, backlog,
   * …); lower comes first. Positions of different groups do not compare.
   */
  position: number;
}

export interface Initiative {
  id: string;
  name: string;
  /** Linear's manual ordering; lower comes first. */
  sortOrder: number;
  /** Initiative priority when Linear exposes one, else 0 (none). */
  priority: Priority;
  targetDate: IsoDate | null;
}

export interface Project {
  id: string;
  name: string;
  url: string;
  /** The project lead: the "project owner" for allocation and warnings. */
  leadId: string | null;
  priority: Priority;
  /** Linear's manual ordering of projects; lower comes first. */
  sortOrder: number;
  statusType: ProjectStatusType;
  statusName: string;
  initiativeIds: string[];
  teamIds: string[];
  startDate: IsoDate | null;
  targetDate: IsoDate | null;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  /** Linear's milestone description (markdown), if any. */
  description: string | null;
  targetDate: IsoDate | null;
  /** Linear's manual ordering within the project; lower comes first. */
  sortOrder: number;
}

export interface Issue {
  id: string;
  /** Human key such as `ENG-123`. */
  identifier: string;
  title: string;
  url: string;
  teamId: string;
  projectId: string | null;
  milestoneId: string | null;
  assigneeId: string | null;
  stateId: string;
  priority: Priority;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  canceledAt: IsoDateTime | null;
  /**
   * When this issue last entered its current workflow state. Derived by the
   * sync from issue history when it was fetched, otherwise the latest of
   * createdAt/startedAt/completedAt/canceledAt. Drives "stalled" risk.
   */
  lastStateChangeAt: IsoDateTime;
  /**
   * The issue's own Linear due date (Issue.dueDate, a TimelessDate), or
   * null. Absent on mirrors written before 2026-10-22 (read as none) until
   * the next full sync writes it.
   */
  dueDate?: IsoDate | null;
}

/** Only Linear "blocks" relations are kept: blocker blocks blocked. */
export interface BlockingRelation {
  id: string;
  blockerId: string;
  blockedId: string;
}

/** Everything the tool mirrors from one Linear workspace. */
export interface WorkspaceData {
  workspaceId: string;
  users: User[];
  teams: Team[];
  states: WorkflowState[];
  initiatives: Initiative[];
  projects: Project[];
  milestones: Milestone[];
  issues: Issue[];
  relations: BlockingRelation[];
}

/**
 * WorkspaceData indexed for evaluation (built once per load by
 * indexWorkspace). Server-only: contains Maps.
 */
export interface Snapshot {
  data: WorkspaceData;
  users: ReadonlyMap<string, User>;
  teams: ReadonlyMap<string, Team>;
  states: ReadonlyMap<string, WorkflowState>;
  initiatives: ReadonlyMap<string, Initiative>;
  projects: ReadonlyMap<string, Project>;
  milestones: ReadonlyMap<string, Milestone>;
  issues: ReadonlyMap<string, Issue>;
  /** Per project: by targetDate ascending (undated last), then sortOrder. */
  milestonesByProject: ReadonlyMap<string, readonly Milestone[]>;
  issuesByMilestone: ReadonlyMap<string, readonly Issue[]>;
  issuesByProject: ReadonlyMap<string, readonly Issue[]>;
  issuesByAssignee: ReadonlyMap<string, readonly Issue[]>;
  /** Blocked issue id -> ids of the issues blocking it. */
  blockersOf: ReadonlyMap<string, readonly string[]>;
  /** Blocker issue id -> ids of the issues it blocks. */
  blocking: ReadonlyMap<string, readonly string[]>;
}

// ---------------------------------------------------------------------------
// Tool-owned data
// ---------------------------------------------------------------------------

/** Per-milestone data Linear has no field for. */
export interface MilestoneMeta {
  milestoneId: string;
  /**
   * Display-only sort override: higher sorts earlier within its group. It
   * never changes which milestone is "next" for allocation or warnings.
   */
  weight: number | null;
  /** One-line "done means…" outcome (rubric item b). */
  doneMeans: string | null;
  updatedAt: IsoDateTime;
  updatedBy: string | null;
}

export type AllocationMode = 'dry_run' | 'live';

/**
 * preview: digests are built and recorded in the app's outbox only.
 * live: digests are also delivered (Slack DM).
 */
export type WarningsMode = 'preview' | 'live';

/** Tunable thresholds; defaults in DEFAULT_TUNING. */
export interface Tuning {
  /** Warn this many days ahead of a milestone's due date. */
  warnLeadDays: number;
  /** "Time remaining" denominator for the behind-pace check. */
  paceWindowDays: number;
  /** No state change among a milestone's issues for this long = stalled. */
  stallDays: number;
  /** Repeat an overdue warning every N days while it stays overdue. */
  overdueRepeatDays: number;
  /** How long an auto-allocated issue keeps its "new" mark in My week. */
  newBadgeDays: number;
  /** Project statuses that receive allocation and warnings. */
  activeProjectStatuses: ProjectStatusType[];
  /** Timeline window, relative to today. */
  timelineDaysBack: number;
  timelineDaysAhead: number;
}

export interface WorkspaceSettings {
  workspaceId: string;
  /**
   * Users told about every at-risk milestone besides its project lead
   * (§2.9). There is no PM list: since the owner decision of 2026-10-22
   * every signed-in person may edit dates, weights, leads, "done means…"
   * and settings, so watchers are the only people the settings name.
   */
  watcherUserIds: string[];
  allocationMode: AllocationMode;
  warningsMode: WarningsMode;
  /** IANA zone used to decide what "today" is, e.g. `America/Chicago`. */
  timezone: string;
  tuning: Tuning;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Inputs every pure evaluation function receives. */
export interface EvalContext {
  /** "Today" in the workspace timezone. */
  today: IsoDate;
  now: IsoDateTime;
  tuning: Tuning;
  /** Tool-owned milestone data keyed by milestone id. */
  meta: ReadonlyMap<string, MilestoneMeta>;
}

export type RubricGap =
  | 'no_target_date'
  | 'no_done_means'
  | 'no_project_lead'
  | 'no_issues';

export interface RubricResult {
  valid: boolean;
  /** In display order: date, done means, lead, issues. */
  gaps: RubricGap[];
}

export type DoneMeansSource = 'planner' | 'linear_description';

export interface DoneMeans {
  text: string | null;
  source: DoneMeansSource | null;
}

export interface Progress {
  /** Every issue in the milestone, including canceled. */
  total: number;
  completed: number;
  canceled: number;
  /** total - canceled: the denominator shown as "done/scope". */
  scope: number;
  open: number;
  openUnassigned: number;
  openTriage: number;
}

/**
 * - empty: no issues at all (fails the rubric).
 * - complete: has issues and none are open.
 * - unscheduled: open issues but no target date.
 * - overdue: past its date with open issues.
 * - at_risk: due within warnLeadDays and at least one risk reason holds.
 * - on_track: everything else.
 */
export type MilestoneStatus =
  | 'empty'
  | 'complete'
  | 'unscheduled'
  | 'overdue'
  | 'at_risk'
  | 'on_track';

export type RiskReason = 'unassigned_open' | 'stalled' | 'behind_pace';

export interface MilestoneAssessment {
  milestoneId: string;
  projectId: string;
  status: MilestoneStatus;
  /** targetDate - today in calendar days; negative when overdue. */
  daysLeft: number | null;
  /** Populated for at_risk and overdue milestones. */
  reasons: RiskReason[];
  progress: Progress;
  rubric: RubricResult;
  doneMeans: DoneMeans;
  /** True when this is its project's "next milestone" (§6.2). */
  isNext: boolean;
  /** Latest lastStateChangeAt among the milestone's issues. */
  lastStateChangeAt: IsoDateTime | null;
}

// ---------------------------------------------------------------------------
// Allocation (§7.4)
// ---------------------------------------------------------------------------

export type ProjectAllocationOutcome =
  /** Has unassigned issues in a valid next milestone. */
  | 'allocate'
  /** Valid next milestone, nothing unassigned. */
  | 'nothing_to_do'
  /**
   * Missing input: reported loudly, nothing allocated. A missing or
   * deactivated lead blocks even a project with no open milestone.
   */
  | 'blocked'
  /** Every milestone is complete (or there are none); the lead is fine. */
  | 'no_open_milestone'
  /** Project status is not in tuning.activeProjectStatuses. */
  | 'inactive';

export type AllocationBlockReason =
  | 'no_lead'
  | 'lead_inactive'
  | 'next_milestone_invalid';

export type IssueSkipReason = 'already_assigned' | 'triage';

export interface AllocationAction {
  issueId: string;
  identifier: string;
  title: string;
  projectId: string;
  milestoneId: string;
  assigneeId: string;
  fromStateId: string;
  /** The team's Todo state when moving out of Backlog; null keeps the state. */
  toStateId: string | null;
}

export interface AllocationSkip {
  issueId: string;
  identifier: string;
  reason: IssueSkipReason;
}

export interface ProjectAllocationPlan {
  projectId: string;
  outcome: ProjectAllocationOutcome;
  nextMilestoneId: string | null;
  blockReason: AllocationBlockReason | null;
  /** Rubric gaps of the next milestone when blockReason is next_milestone_invalid. */
  gaps: RubricGap[];
  actions: AllocationAction[];
  skipped: AllocationSkip[];
}

export interface AllocationPlan {
  today: IsoDate;
  projects: ProjectAllocationPlan[];
  totals: {
    actions: number;
    blockedProjects: number;
    skippedIssues: number;
  };
}

// ---------------------------------------------------------------------------
// Warnings (§7.5)
// ---------------------------------------------------------------------------

export type NoticeKind =
  | 'overdue'
  | 'at_risk'
  /** Dated within warnLeadDays but fails the rubric. */
  | 'invalid_due_soon'
  /** Allocation for the project is stopped by a missing input. */
  | 'allocation_blocked';

export interface Notice {
  kind: NoticeKind;
  subjectKind: 'milestone' | 'project';
  /** Milestone id, or project id for allocation_blocked. */
  subjectId: string;
  projectId: string;
  milestoneId: string | null;
  /** Dedupe key; a notice is sent when it differs from the remembered one. */
  key: string;
  targetDate: IsoDate | null;
  daysLeft: number | null;
  reasons: RiskReason[];
  gaps: RubricGap[];
  blockReason: AllocationBlockReason | null;
  openIssueIds: string[];
  unassignedIssueIds: string[];
  /** Deduplicated user ids: project lead (if any) + watchers. */
  recipientIds: string[];
  /** 1 on first notice for this key, then 2, 3… for overdue repeats. */
  occurrence: number;
}

/** What the warning job remembers about one subject between runs. */
export interface WarningMemory {
  subjectKind: 'milestone' | 'project';
  subjectId: string;
  /** Key of the last evaluated state, or null for "nothing to report". */
  lastKey: string | null;
  lastNotifiedOn: IsoDate | null;
  occurrence: number;
}

export interface WarningPlan {
  notices: Notice[];
  /** Memory rows to persist (one per evaluated subject). */
  memory: WarningMemory[];
}

/** One open issue a digest item names, so the message says what is open. */
export interface DigestIssue {
  id: string;
  /** Human key such as `ENG-123`. */
  identifier: string;
  title: string;
  /** No assignee in Linear (one of the notice's `unassignedIssueIds`). */
  unassigned: boolean;
  /** The planner's issue page, `<appUrl>/issues/<identifier>`. */
  url: string;
}

export interface DigestItem {
  notice: Notice;
  projectName: string;
  milestoneName: string | null;
  leadName: string | null;
  openCount: number;
  unassignedCount: number;
  /**
   * The notice's open issues in display order (`notice.openIssueIds`), with
   * the unassigned ones flagged. buildDigests always sets it; it is absent on
   * digests stored before it existed (notification rows keep digest JSON).
   */
  openIssues?: DigestIssue[];
  /** Short, plain-language lines explaining why ("2 open issues unassigned"). */
  lines: string[];
  /** Deep link into the timeline for this subject. */
  url: string;
}

/** One message per recipient per day (§6.8). */
export interface Digest {
  recipientId: string;
  recipientName: string;
  recipientEmail: string | null;
  day: IsoDate;
  items: DigestItem[];
}

// ---------------------------------------------------------------------------
// Dependency graph (§7.3; graphs at every level, owner decision 2026-10-22)
// ---------------------------------------------------------------------------

/** What one node stands for: the zoom level. */
export type GraphLevel = 'initiative' | 'project' | 'milestone' | 'issue';

/**
 * What a dependency graph shows (§2.10): a level inside a container. With no
 * container key the container is the whole workspace, as the viewer sees it.
 * Otherwise exactly one key names the container, and the container is always
 * coarser than the level. `initiativeId` may be NO_INITIATIVE_ID ('none'):
 * the projects in no mirrored initiative. `issueId` is one issue's blocking
 * chain; on input it may be an id or an identifier in any case, and the
 * resolved scope always carries the id. Today's three shapes
 * ({ level: 'milestone' }, { level: 'issue', milestoneId },
 * { level: 'issue', projectId }) keep their meaning.
 * Branch on a scope only through graphContainer(), with an exhaustive switch.
 */
export type GraphScope =
  | { level: GraphLevel }
  | { level: 'project' | 'milestone' | 'issue'; initiativeId: string }
  | { level: 'milestone' | 'issue'; projectId: string }
  | { level: 'issue'; milestoneId: string }
  | { level: 'issue'; issueId: string };

/** A scope's container as a tagged value (graphContainer). */
export type GraphContainer =
  | { kind: 'workspace' }
  | { kind: 'initiative'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'milestone'; id: string }
  | { kind: 'chain'; id: string };

/** Why the graph answers a wider scope than the one asked for. */
export interface GraphFallback {
  /**
   * The viewer's mirror holds no initiatives: a Linear guest (or a person
   * the mirror does not know), or a workspace without initiatives.
   */
  reason: 'no_initiatives';
  /** The scope as asked. */
  requested: GraphScope;
}

/**
 * Where a graph node stands in the blocking flow (§2.10 "Readiness"):
 * `independent` is open work that neither blocks nor waits on anything
 * ("No dependencies"), drawn neutral; `ready` is open work in the blocking
 * flow that nothing open holds up; `done` has issues and none open;
 * `empty` (a box only) has no issue in the viewer's mirror at all, so it
 * is neither done nor in the flow ("No issues").
 */
export type GraphReadiness =
  | 'ready'
  | 'blocked'
  | 'done'
  | 'independent'
  | 'empty';

/** The highlight a graph is drawn or exported with (§2.10, planner ?highlight=). */
export type GraphHighlight = 'status' | 'risk' | 'critical';

/** What a graph cluster groups its nodes by (§2.10 "Clusters"). */
export type GraphClusterKind = 'initiative' | 'project' | 'milestone';

/**
 * A labelled frame around the drawn nodes that share a parent (§2.10
 * "Clusters", owner decision 2026-10-23): at the issue level one per
 * milestone ("No milestone" per project, "No project"), nested in one per
 * project when the drawn issues span more than one project; at the
 * milestone level one per project; at the project level one per first
 * initiative ("No initiative"), and none in a mirror without initiatives.
 * The initiative level and a chain have none. Only clusters with a drawn
 * node in them exist.
 */
export interface GraphCluster {
  /**
   * Stable and unique in the graph: `project:<id>`, `project:none`,
   * `milestone:<id>`, `milestone:none:<projectId>`, `initiative:<id>`
   * (`initiative:none` for NO_INITIATIVE_ID).
   */
  id: string;
  kind: GraphClusterKind;
  /**
   * The milestone, project or initiative it stands for
   * (NO_INITIATIVE_ID for "No initiative"); null for "No milestone" and
   * "No project".
   */
  refId: string | null;
  /** The name; "No milestone", "No project" or "No initiative". */
  label: string;
  /** The enclosing cluster (a milestone's project) or null at the top. */
  parentId: string | null;
  /**
   * The project it belongs to: a project cluster its own, a milestone
   * cluster (or "No milestone") its project's; null for "No project" and
   * initiative clusters.
   */
  projectId: string | null;
  /** One of its nodes is active (§2.8); inactive clusters are drawn muted. */
  active: boolean;
  /** Every node in it is an external (outside the container). */
  external: boolean;
}

/** One issue's chain, summarised (chain scopes only). */
export interface GraphChain {
  focusId: string;
  /**
   * Issues found upstream / downstream of the focus by the full walk
   * (§2.10), before the cap; the focus is not counted.
   */
  upstream: number;
  downstream: number;
  /** Walk nodes left out by CHAIN_MAX_NODES. */
  hidden: number;
}

export interface GraphNode {
  /** Initiative id, NO_INITIATIVE_ID, project, milestone or issue id. */
  id: string;
  kind: GraphLevel;
  label: string;
  /**
   * Issue: "ENG-12 · Ana"; milestone: project name; project: lead's name
   * or "No lead"; initiative: "4 projects".
   */
  sublabel: string;
  /**
   * Issue and project: their Linear URL. Milestone and initiative: null
   * (the mirror keeps no initiative URL).
   */
  url: string | null;
  /**
   * The first initiative (homeInitiativeIds) of the node's project;
   * NO_INITIATIVE_ID when the project has none; an initiative node: its own
   * id. Null only for an issue with no (mirrored) project.
   */
  initiativeId: string | null;
  projectId: string | null;
  milestoneId: string | null;
  /** Assignee (issue), project lead (milestone, project), null (initiative). */
  ownerId: string | null;
  /** Outside the requested container, one hop away. */
  external: boolean;
  /**
   * The innermost cluster (DependencyGraph.clusters) it is drawn in; null
   * when the graph has no clusters (the initiative level, a chain).
   */
  clusterId: string | null;
  /**
   * Its project is active (§2.8); an issue with no mirrored project counts
   * as active; an initiative: one of its projects is.
   */
  active: boolean;
  open: boolean;
  unassigned: boolean;
  overdue: boolean;
  inCycle: boolean;
  /**
   * An open issue under this node is on a blocking cycle among open
   * issues, anywhere in the viewer's mirror. For an issue node: itself.
   */
  holdsCycle: boolean;
  /** Transitively waits on an open unassigned issue. */
  waitsOnUnassigned: boolean;
  /** Transitively waits on an issue in an overdue milestone. */
  waitsOnOverdue: boolean;
  status: MilestoneStatus | WorkflowStateType;
  /**
   * Issue: done when completed or canceled; blocked when open with an open
   * blocker in the viewer's mirror; independent ("No dependencies") when
   * open with no blocks relation, either way, to an issue that is not
   * canceled; ready otherwise (in the blocking flow, nothing open holds it
   * up). Above the issue level: empty when no issue at all counts toward
   * the unit in the viewer's mirror (a milestone with "No issues yet", an
   * initiative whose projects count elsewhere or are hidden); done when
   * issues count toward it and none is open; blocked ("waiting") when one
   * of its open issues has an open
   * blocker that counts toward another unit of this level or toward none;
   * independent when it is also no such blocker of another unit's (or an
   * unplaced) open issue and something in it can start; ready ("clear")
   * otherwise (it may still hold blocked issues of its own). Mirror-wide,
   * like the risk facts.
   */
  readiness: GraphReadiness;
  /**
   * Issue: its distinct open blockers (a self-loop counts). Above: the
   * other units holding an open blocker of its open issues, plus the open
   * blockers with no unit at this level. 0 unless blocked. May exceed the
   * drawn in-edges.
   */
  blockedBy: number;
  /**
   * Above the issue level: how many of `blockedBy` are open blockers with
   * no unit at this level (an issue with no milestone at the milestone
   * level, with no project above it): issues, not boxes, so copy counts
   * them apart. 0 for an issue.
   */
  unplacedBlockers: number;
  /**
   * What finishing it alone would free. Issue: the open issues (not itself)
   * whose only open blocker it is. Above: the units whose only blocker
   * (units and unplaced alike) it is. 0 when done.
   */
  unblocks: number;
  /** Open issues counting toward the node (an issue: 1 when open). */
  openIssues: number;
  /** Of those, the ones with no open blocker anywhere in the mirror. */
  readyIssues: number;
  /**
   * Chain graphs only: signed hops from the focus (0 = the focus, negative
   * = upstream).
   */
  distance?: number;
  /**
   * Chain graphs only: this node's relations to walk nodes that
   * CHAIN_MAX_NODES left out (set only when above 0).
   */
  hiddenNeighbours?: number;
}

export interface GraphEdge {
  /** The blocker. */
  from: string;
  /** The node that waits. */
  to: string;
  /** Blocker is already completed/canceled (issue level only). */
  resolved: boolean;
  /**
   * Both ends are open: the blocker still holds the waiting end up. Always
   * true above the issue level (aggregate edges count open→open relations
   * only). False when the blocker is closed (`resolved`) or the waiting
   * issue is closed.
   */
  blocking: boolean;
  /**
   * The ends are in different projects (always true at the project and
   * initiative levels).
   */
  crossProject: boolean;
  /**
   * Both ends have a project and their first initiatives differ (always
   * true at the initiative level).
   */
  crossInitiative: boolean;
  /**
   * Owners set and different (issue: assignees; milestone, project: leads;
   * initiative: always false).
   */
  crossOwner: boolean;
  inCycle: boolean;
  /**
   * Issue level: the blocker is unassigned/overdue or waits on one.
   * Aggregate levels: one relation it summarises has such a blocker.
   */
  onRiskChain: boolean;
  /** Aggregate levels: how many issue relations the edge summarises. */
  weight: number;
}

export interface DependencyGraph {
  /**
   * The scope drawn: resolved (a chain carries the issue id) and, after a
   * fallback, the wider scope.
   */
  scope: GraphScope;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Each cycle as node ids in order. */
  cycles: string[][];
  /**
   * The labelled frames the nodes are drawn in (GraphCluster), parents
   * before their children, siblings in display order (in the container
   * first, then the ones holding only externals). Empty at the initiative
   * level and in a chain.
   */
  clusters: GraphCluster[];
  /** Set when the scope named initiatives the viewer has none of. */
  fallback: GraphFallback | null;
  /**
   * Aggregate levels: open→open relations that touch the container but
   * have an end with no node at this level (no milestone at the milestone
   * level; no project at the project and initiative levels).
   */
  unplacedRelations: number;
  /** Chain scopes only. */
  chain: GraphChain | null;
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** An allocation the tool made recently, for My week's "new" mark. */
export interface RecentAllocation {
  issueId: string;
  assigneeId: string;
  projectId: string;
  milestoneId: string;
  at: IsoDateTime;
}

export interface WeekIssueRow {
  issueId: string;
  identifier: string;
  title: string;
  url: string;
  priority: Priority;
  stateName: string;
  stateType: WorkflowStateType;
  /** "new — given to you because you lead <project>" when set. */
  newBecauseLeadOf: string | null;
}

export interface WeekSection {
  /** null for the final "No milestone" section. */
  milestoneId: string | null;
  milestoneName: string | null;
  projectId: string | null;
  projectName: string | null;
  projectUrl: string | null;
  targetDate: IsoDate | null;
  daysLeft: number | null;
  status: MilestoneStatus | null;
  progress: Progress | null;
  /**
   * In an active project (§2.8), and overdue or due on or before
   * today + 6 days.
   */
  thisWeek: boolean;
  rows: WeekIssueRow[];
}

export interface WeekView {
  userId: string;
  userName: string;
  today: IsoDate;
  sections: WeekSection[];
  totals: { open: number; thisWeek: number; overdue: number; new: number };
}

export interface TimelineBar {
  milestoneId: string;
  name: string;
  projectId: string;
  /** Bar start: previous dated milestone's date, else project start, else windowStart. */
  start: IsoDate;
  /** The due date the bar ends at; null for undated milestones. */
  end: IsoDate | null;
  status: MilestoneStatus;
  reasons: RiskReason[];
  rubric: RubricResult;
  doneMeans: DoneMeans;
  progress: Progress;
  isNext: boolean;
  daysLeft: number | null;
  weight: number | null;
}

export interface TimelineLane {
  projectId: string;
  name: string;
  url: string;
  leadId: string | null;
  leadName: string | null;
  priority: Priority;
  statusType: ProjectStatusType;
  /** Allocation and warnings apply (status in activeProjectStatuses). */
  active: boolean;
  /** Dated milestones in date order. */
  bars: TimelineBar[];
  /** Milestones without a target date, in Linear's order. */
  undated: TimelineBar[];
  /** Open issues in the project with no milestone (§6.4 "unplanned"). */
  unplannedIssueIds: string[];
  allocation: ProjectAllocationPlan | null;
}

export interface TimelineGroup {
  initiativeId: string | null;
  name: string;
  lanes: TimelineLane[];
}

export interface TimelineView {
  today: IsoDate;
  windowStart: IsoDate;
  windowEnd: IsoDate;
  groups: TimelineGroup[];
  banners: {
    projectsWithoutLead: { projectId: string; name: string }[];
    milestonesWithoutDate: {
      milestoneId: string;
      name: string;
      projectId: string;
      projectName: string;
    }[];
    issuesWithoutMilestone: {
      count: number;
      byProject: { projectId: string; name: string; issueIds: string[] }[];
    };
    blockedProjects: {
      projectId: string;
      name: string;
      reason: AllocationBlockReason;
      gaps: RubricGap[];
    }[];
  };
}

export interface MilestoneIssueRow {
  issueId: string;
  identifier: string;
  title: string;
  url: string;
  priority: Priority;
  stateName: string;
  stateType: WorkflowStateType;
  assigneeId: string | null;
  assigneeName: string | null;
  blockedByIds: string[];
}

export interface MilestoneDetail {
  milestone: Milestone;
  project: Project;
  leadName: string | null;
  assessment: MilestoneAssessment;
  meta: MilestoneMeta | null;
  issues: MilestoneIssueRow[];
  /** Milestones this one waits on (milestone-level graph neighbours). */
  waitsOn: { milestoneId: string; name: string; projectName: string }[];
}

// ---------------------------------------------------------------------------
// Issue detail and issue edits (owner decision 2026-10-21: every signed-in
// person can edit an issue from the planner with their own Linear token)
// ---------------------------------------------------------------------------

/**
 * A team's estimate scale (Linear `Team.issueEstimationType`). `notUsed`
 * means the team has estimates switched off: only "no estimate" is valid.
 */
export type EstimateScaleType =
  | 'notUsed'
  | 'exponential'
  | 'fibonacci'
  | 'linear'
  | 'tShirt';

export interface EstimateScale {
  type: EstimateScaleType;
  /** `Team.issueEstimationAllowZero`: 0 is an explicit, valid estimate. */
  allowZero: boolean;
  /** `Team.issueEstimationExtended`: two more values at the top of the scale. */
  extended: boolean;
}

/** One value the estimate picker offers ("5", or "L" on a T-shirt scale). */
export interface EstimateOption {
  /** What Linear stores (T-shirt sizes are stored as Fibonacci numbers). */
  value: number;
  label: string;
}

/** The label group a label belongs to (Linear `IssueLabel.parent`). */
export interface IssueLabelGroup {
  id: string;
  name: string;
  /**
   * At most one label of the group per issue. Linear groups are
   * single-select unless their `groupType` is `multiSelect`.
   */
  singleSelect: boolean;
}

/** A Linear issue label that can be applied to an issue (never a group). */
export interface IssueLabel {
  id: string;
  name: string;
  /**
   * Linear's HEX colour. Linear labels are colour-coded, so the planner
   * draws it as the small swatch beside the label's name in the label
   * picker (hex values only), the one place a colour from data appears;
   * everything else stays in the planner's own marks (architecture §8.2,
   * §8.5).
   */
  color: string;
  /** The team the label belongs to; null for a workspace label. */
  teamId: string | null;
  group: IssueLabelGroup | null;
}

/** A comment on an issue, as read live from Linear. */
export interface IssueComment {
  id: string;
  /** Markdown, as Linear stores it. */
  body: string;
  createdAt: IsoDateTime;
  /** Link to the comment in Linear; null when Linear did not send one. */
  url: string | null;
  /** The comment this one replies to (threads), else null. */
  parentId: string | null;
  /** The Linear user who wrote it; null for bots and integrations. */
  author: { id: string; name: string } | null;
  /** The bot's or external person's name when `author` is null. */
  externalAuthor: string | null;
}

/**
 * The fields of one issue the mirror does not keep, read live from Linear
 * for the issue page (the sync never fetches them, so the mirror stays
 * small and every reader sees Linear's current text).
 */
export interface IssueExtras {
  issueId: string;
  /** Markdown description; null when empty. */
  description: string | null;
  /** The issue's labels (the full set). */
  labels: IssueLabel[];
  estimate: number | null;
  dueDate: IsoDate | null;
  /** Oldest first, newest last. */
  comments: IssueComment[];
  /** Linear holds more comments than were read (see ISSUE_COMMENTS_MAX). */
  commentsTruncated: boolean;
  /** The estimate scale of the issue's team. */
  estimateScale: EstimateScale;
}

/**
 * A person's edit of one issue: only the keys present change. Null clears
 * a field that may be empty; `labelIds` is the issue's complete new label
 * set (labels left out are removed).
 */
export interface IssuePatch {
  title?: string;
  description?: string | null;
  stateId?: string;
  assigneeId?: string | null;
  priority?: Priority;
  projectId?: string | null;
  projectMilestoneId?: string | null;
  dueDate?: IsoDate | null;
  estimate?: number | null;
  labelIds?: string[];
}

export type IssuePatchField = keyof IssuePatch;

/** A person on the issue page, with whether Linear still has them active. */
export interface IssuePersonRef {
  id: string;
  name: string;
  active: boolean;
}

/** One blocks relation as the issue page lists it. */
export interface IssueRelationRow {
  /** The Linear relation id (what removeRelation takes). */
  relationId: string;
  /** The other issue of the relation. */
  issueId: string;
  identifier: string;
  title: string;
  url: string;
  stateName: string;
  stateType: WorkflowStateType;
  assigneeId: string | null;
  assigneeName: string | null;
  projectId: string | null;
  projectName: string | null;
  milestoneId: string | null;
  milestoneName: string | null;
  /**
   * The other issue is outside the planner's active work: it has no
   * project, or its project's status is not in activeProjectStatuses.
   */
  external: boolean;
  /** The relation's blocker is closed, so it no longer holds anything up. */
  resolved: boolean;
}

export interface IssueDetailProject {
  id: string;
  name: string;
  url: string;
  statusType: ProjectStatusType;
  statusName: string;
  /** In tuning.activeProjectStatuses (§2.8): allocated and warned about. */
  active: boolean;
  lead: IssuePersonRef | null;
}

export interface IssueDetailMilestone {
  id: string;
  name: string;
  targetDate: IsoDate | null;
  daysLeft: number | null;
  status: MilestoneStatus;
  reasons: RiskReason[];
  /** Its project's next milestone (§2.6). */
  isNext: boolean;
  rubric: RubricResult;
  progress: Progress;
}

export interface IssueDetailTiming {
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  canceledAt: IsoDateTime | null;
  /** When the issue entered its current state (see Issue). */
  lastStateChangeAt: IsoDateTime;
  /** Whole days since lastStateChangeAt (0 when it lies in the future). */
  daysInState: number;
  /** Open, and no state change for more than tuning.stallDays × 24 h. */
  stalled: boolean;
}

/** Why this issue matters to the plan, for the page's "why" panel. */
export interface IssueWhyItMatters {
  /**
   * Open, unassigned, in its active project's next milestone: the next
   * live allocation run gives it to the project lead.
   */
  unassignedInNextMilestone: boolean;
  /**
   * Overdue or at-risk milestones of active projects holding an open issue
   * this open issue blocks, in milestone display order.
   */
  blocksAtRiskMilestones: {
    milestoneId: string;
    name: string;
    projectName: string;
    status: 'overdue' | 'at_risk';
  }[];
  /** Open, and transitively waits on an open unassigned issue. */
  waitsOnUnassigned: boolean;
  /** Open, and transitively waits on an issue of an overdue milestone. */
  waitsOnOverdue: boolean;
  /**
   * On a dependency chain that ends in an unassigned or overdue issue
   * (§2.10): it waits on one, or is one and blocks an open issue.
   */
  onRiskChain: boolean;
}

/** A project the issue may move to, with its milestones. */
export interface IssueProjectOption {
  id: string;
  name: string;
  statusName: string;
  active: boolean;
  /** The issue's team works on the project (Project.teamIds). */
  includesTeam: boolean;
  /** In project order (§2.6: date ascending, undated last). */
  milestones: { id: string; name: string; targetDate: IsoDate | null }[];
}

/** What the edit controls may offer, all from the mirror. */
export interface IssueEditOptions {
  /**
   * The issue's team's workflow states in Linear's order: type group
   * (triage → canceled), then position within the group.
   */
  states: WorkflowState[];
  /** Active people (no app users), by name. */
  assignees: { id: string; name: string; displayName: string }[];
  /** Active projects first (timeline order), then the others. */
  projects: IssueProjectOption[];
}

/** The issue page's view model, built from the mirror (buildIssueDetail). */
export interface IssueDetail {
  issue: Issue;
  /** The issue's workflow state (null when the mirror lacks it). */
  state: { id: string; name: string; type: WorkflowStateType } | null;
  team: Team | null;
  assignee: IssuePersonRef | null;
  priority: Priority;
  project: IssueDetailProject | null;
  milestone: IssueDetailMilestone | null;
  /** Issues blocking this one, open blockers first, then issue order. */
  blockedBy: IssueRelationRow[];
  /** Issues this one blocks, open ones first, then issue order. */
  blocks: IssueRelationRow[];
  /**
   * Blocks relations whose other issue the mirror does not hold (an issue
   * of a closed project, or of a team the app cannot see): counted, since
   * there is nothing to show for them.
   */
  hiddenRelations: number;
  timing: IssueDetailTiming;
  why: IssueWhyItMatters;
  options: IssueEditOptions;
}

// ---------------------------------------------------------------------------
// Issue list (owner request 2026-10-22, "every issue in one list"): every
// issue the viewer can see, filtered, weight-ordered, grouped, and the
// moves that place issues in milestones (architecture §2.14, §7.3)
// ---------------------------------------------------------------------------

/**
 * "No project / milestone / initiative / assignee" in a filter or URL. It
 * equals NO_INITIATIVE_ID; Linear ids are UUIDs, so it cannot clash.
 */
export const LIST_NONE = 'none';
/** The viewer, in the assignee filter (resolved per request). */
export const LIST_ME = 'me';

/** What the list groups by. */
export type IssueListGroupBy =
  | 'milestone'
  | 'project'
  | 'initiative'
  | 'assignee'
  | 'state'
  | 'priority'
  | 'none';
/** The divider level above the groups. */
export type IssueListSectionBy = 'none' | 'initiative' | 'project';
/** Row order inside a group ('weight' is architecture §2.7's order). */
export type IssueListSort =
  | 'weight'
  | 'priority'
  | 'due'
  | 'updated'
  | 'created'
  | 'title';
/** Quick filters: each adds one condition. */
export type IssueListQuick = 'blocked' | 'at_risk' | 'next';
/** The filter fields that hold entity ids. */
export type IssueListIdFacet =
  | 'initiative'
  | 'project'
  | 'milestone'
  | 'assignee'
  | 'team';
/** The preset tabs. */
export type IssueListPresetId =
  | 'all'
  | 'mine'
  | 'unplanned'
  | 'unassigned'
  | 'blocked'
  | 'at_risk';

/**
 * The list's filters. Values within a field are OR'd; fields and quick
 * filters are AND'd; an empty field adds no condition.
 */
export interface IssueListFilters {
  /** Trimmed, at most ISSUE_LIST_QUERY_MAX characters; '' = none. */
  q: string;
  /** Initiative ids or LIST_NONE (a project in no mirrored initiative). */
  initiativeIds: string[];
  /** Project ids or LIST_NONE. */
  projectIds: string[];
  /** Milestone ids or LIST_NONE. */
  milestoneIds: string[];
  /** User ids, LIST_ME or LIST_NONE (unassigned). */
  assigneeIds: string[];
  teamIds: string[];
  /** Never empty; OPEN_STATE_TYPES by default. */
  stateTypes: WorkflowStateType[];
  priorities: Priority[];
  quick: IssueListQuick[];
}

/** One issue list view, as a URL describes it. */
export interface IssueListQuery {
  filters: IssueListFilters;
  group: IssueListGroupBy;
  sections: IssueListSectionBy;
  sort: IssueListSort;
  /** Ignored for 'weight' (normalized to 'asc' there). */
  dir: 'asc' | 'desc';
  /** Row budget: a multiple of ISSUE_LIST_LIMIT_STEP in [DEFAULT, MAX]. */
  limit: number;
}

/** What a bulk change, a drop or Undo sets (§7.3). Exactly the allowed fields. */
export interface IssueBulkPatch {
  /**
   * Placement: a milestone (its project comes with it), or a project with
   * no milestone, or { projectId: null, milestoneId: null } = no project.
   */
  move?: { projectId: string | null; milestoneId: string | null };
  assigneeId?: string | null;
  priority?: Priority;
  /**
   * Resolved per issue's team: the state of that type whose name matches
   * (trimmed, case-insensitive: stateNameKey).
   */
  state?: { type: WorkflowStateType; name: string };
}

/** One issue as the list shows it. */
export interface IssueListRow {
  id: string;
  identifier: string;
  title: string;
  url: string;
  teamId: string;
  stateId: string;
  /** '' when the state is not mirrored. */
  stateName: string;
  stateType: WorkflowStateType;
  priority: Priority;
  assigneeId: string | null;
  /** Null when not mirrored. */
  projectId: string | null;
  /** Null when not mirrored (reads as "No milestone"). */
  milestoneId: string | null;
  dueDate: IsoDate | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  open: boolean;
  /** Open blockers in the viewer's mirror. */
  blockedBy: number;
  /**
   * Open, and blocks an open issue of an overdue or at-risk milestone of
   * an active project: the first such milestone in weight order.
   */
  holdsUpMilestoneId: string | null;
  /** Open, unassigned, not triage, in its active project's next milestone. */
  unassignedInNext: boolean;
  /** Its project is active (§2.8); true when it has no project. */
  projectActive: boolean;
}

/** What a group collects. */
export type IssueListGroupValue =
  | { kind: 'milestone'; milestoneId: string; projectId: string }
  | { kind: 'no_milestone'; projectId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'no_project' }
  /** initiativeId may be NO_INITIATIVE_ID. */
  | { kind: 'initiative'; initiativeId: string }
  | { kind: 'assignee'; userId: string | null }
  | { kind: 'state'; stateType: WorkflowStateType; stateName: string }
  | { kind: 'priority'; priority: Priority }
  | { kind: 'all' };

export interface IssueListGroup {
  /** `<sectionKey>/<valueKey>` (architecture §2.14 has the grammar). */
  key: string;
  value: IssueListGroupValue;
  /** Matching issues in this group (all of them, shown or not). */
  count: number;
  /** The first issues in sort order, within the row budget (may be []). */
  rows: IssueListRow[];
  /** What dropping on this group sets; null = not a drop target. */
  patch: IssueBulkPatch | null;
  /** An inactive project's milestone, "No milestone" or project group. */
  muted: boolean;
  /** Listed only as a drop target (count 0). */
  emptyTarget: boolean;
}

/** What a section collects. */
export type IssueListSectionValue =
  | { kind: 'tier'; tier: 'overdue' | 'upcoming' | 'unplanned' | 'inactive' }
  | { kind: 'initiative'; initiativeId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'no_project' }
  | { kind: 'all' };

export interface IssueListSection {
  /** 't:<tier>' | 'i:<id|none>' | 'p:<id>' | 'p:none' | 'all'. */
  key: string;
  value: IssueListSectionValue;
  /** Matching issues in the section (all of them, shown or not). */
  count: number;
  groups: IssueListGroup[];
}

/** Names of what rows, groups, sections and filter values reference. */
export interface IssueListRefs {
  people: Record<string, { name: string; active: boolean }>;
  teams: Record<string, { key: string; name: string }>;
  initiatives: Record<string, { name: string }>;
  projects: Record<
    string,
    {
      name: string;
      url: string;
      active: boolean;
      statusName: string;
      leadId: string | null;
      homeInitiativeId: string | null;
      nextMilestoneId: string | null;
      allocation: {
        outcome: ProjectAllocationOutcome;
        blockReason: AllocationBlockReason | null;
        gaps: RubricGap[];
      } | null;
    }
  >;
  milestones: Record<
    string,
    {
      name: string;
      projectId: string;
      targetDate: IsoDate | null;
      daysLeft: number | null;
      status: MilestoneStatus;
      /** Why it is at risk or overdue (the assessment's reasons). */
      reasons: RiskReason[];
      rubric: RubricResult;
      isNext: boolean;
      weight: number | null;
      progress: Progress;
    }
  >;
}

/** The issue list (buildIssueList). Plain data, ready to serialize. */
export interface IssueListView {
  /** As applied: normalized, with the no-initiatives fallback. */
  query: IssueListQuery;
  today: IsoDate;
  /** Matching issues. */
  total: number;
  /** Rows returned, across groups. */
  shown: number;
  sections: IssueListSection[];
  /** Groups past ISSUE_LIST_MAX_GROUPS, left out (their issues count in total). */
  moreGroups: { groups: number; issues: number };
  /** Each preset's own result size (independent of the current filters). */
  counts: Record<IssueListPresetId, number>;
  /** Mirrored, non-completed projects the viewer sees. */
  projectCount: number;
  refs: IssueListRefs;
  /** Filter values the viewer's mirror lacks (unknown and hidden alike). */
  unknownIds: { facet: IssueListIdFacet; id: string }[];
  fallback: { reason: 'no_initiatives' } | null;
  /** The status filter names a closed type (coverage notice). */
  includesClosed: boolean;
  /**
   * With an initiative filter: projects in a chosen initiative that count
   * under another first initiative.
   */
  alsoIn: {
    projectId: string;
    projectName: string;
    homeInitiativeName: string;
    chosenInitiativeName: string;
  }[];
}

/** The filter, move and bulk pickers' data (fetched lazily by the planner). */
export interface IssueListOptions {
  /** compareInitiatives order; [] for a guest. */
  initiatives: { id: string; name: string }[];
  /** Active first (timeline order), then the rest. */
  projects: {
    id: string;
    name: string;
    active: boolean;
    statusName: string;
    homeInitiativeId: string | null;
    /**
     * Only the viewer's visible teams: the narrowed snapshot keeps a shared
     * project's full Project.teamIds, hidden teams included, and this
     * payload goes to the browser.
     */
    teamIds: string[];
    leadId: string | null;
    /** §2.6 order (date ascending, undated last). */
    milestones: {
      id: string;
      name: string;
      targetDate: IsoDate | null;
      daysLeft: number | null;
      status: MilestoneStatus;
      isNext: boolean;
      weight: number | null;
    }[];
  }[];
  /** Non-app people; active first, each part by folded name. */
  people: { id: string; name: string; displayName: string; active: boolean }[];
  teams: {
    id: string;
    key: string;
    name: string;
    /** Type group, then position. */
    states: {
      id: string;
      name: string;
      type: WorkflowStateType;
      position: number;
    }[];
  }[];
}
