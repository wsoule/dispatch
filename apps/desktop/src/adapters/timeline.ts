import type {
  TimelineBar as CoreBar,
  TimelineLane as CoreLane,
  DependencyGraph,
  MilestoneAssessment,
  MilestoneDetail,
  MilestoneIssueRow,
  RubricGap,
  TimelineView,
} from '@dispatch/planning';
import {
  graphContainer,
  isOpenState,
  missingLine,
  NO_INITIATIVE_ID,
  RISK_REASON_LABEL,
  RUBRIC_GAP_LABEL,
  RUBRIC_GAP_SHORT_LABEL,
} from '@dispatch/planning';
import type {
  ChecklistItem,
  SegmentedOption,
  TimelineBar,
  TimelineDependency,
  TimelineGroup,
  TimelineLane,
  TimelineUndated,
  UiStatus,
  UiTone,
} from '@dispatch/ui';

import { dueLabel, formatDate, plural } from './planningFormat';
import {
  assessmentMark,
  dueTone,
  issueMark,
  progressTone,
  type StatusMarkModel,
} from './planningStatus';

// The Timeline destination's planning → ui mapping, ported from the planner's
// lib/adapters/timeline.ts (Better-Tracker): @dispatch/planning's TimelineView
// (built in the renderer from a WorkspaceData synthesized out of
// DispatchProjectData) becomes @dispatch/ui's TimelineChart groups, lanes,
// bars and undated chips; the milestone-level DependencyGraph becomes the
// chart's connectors; the view's banners become plain alert data; and a
// MilestoneDetail becomes the Milestone section of the task drawer. Pure
// functions over plain data, unit-tested without React: the view memoizes
// them and attaches the callbacks.
//
// What changed in the port: every href is a parameter (TimelineHrefs: in
// Dispatch a project, a milestone and an issue are all tasks, so one
// `task(id)` covers them), the planner's Linear write-grant model collapses
// to one `canEdit` boolean (a bar is editable iff canEdit), the URL state
// (filters, zoom, selection) is the view's own, and the drawer model keeps
// only the facts the Milestone section draws (no Linear URLs, weights, "done
// means…" editing or lead pickers).

/* ---- hrefs ---------------------------------------------------------------- */

/**
 * Where the chart's links go. `task(id)` is shellRoutes' `taskHref`: a lane's
 * project name, a banner's project or milestone row and an unplanned issue
 * all open their task. `issues()` is the Issues list (a filtered list once
 * Phase 6 adds query routes; `#/issues` until then).
 */
export interface TimelineHrefs {
  task(id: string): string;
  issues(): string;
}

/* ---- chart ---------------------------------------------------------------- */

/** Group id for projects in no initiative (the planning core's). */
export { NO_INITIATIVE_ID };

export interface ChartOptions {
  /** Open bars get the re-date handle. Dispatch has no write grant: everyone
   * in the window may edit, so the view passes true unless the window is
   * read-only for a reason of its own. */
  canEdit: boolean;
  hrefs: TimelineHrefs;
}

/** "↑2" for a positive weight override, "↓3" for a negative one. */
export function weightTag(weight: number | null): string | null {
  if (weight === null || weight === 0) return null;
  return weight > 0 ? `↑${weight}` : `↓${-weight}`;
}

/** "Missing: done means…, project lead" (the bar's missing-input line). */
function missingLabel(gaps: readonly RubricGap[]): string {
  return `Missing: ${gaps.map((gap) => RUBRIC_GAP_SHORT_LABEL[gap]).join(', ')}`;
}

/** "Next" for the lane's next milestone, then the weight override. */
export function barTags(bar: CoreBar): string[] {
  const tags: string[] = [];
  if (bar.isNext) tags.push('Next');
  const weight = weightTag(bar.weight);
  if (weight !== null) tags.push(weight);
  return tags;
}

/**
 * One dated milestone as a chart bar. The mark comes from the one status
 * mapping (assessmentMark: rubric-invalid on-track reads as "missing"); any
 * open milestone that fails the rubric also carries the "Missing: …" line.
 * Only open milestones get the re-date handle, and only when editing is
 * allowed.
 */
export function toChartBar(bar: CoreBar, editable: boolean): TimelineBar {
  const mark = assessmentMark(bar);
  const out: TimelineBar = {
    id: bar.milestoneId,
    label: bar.name,
    start: bar.start,
    end: bar.end ?? bar.start,
    status: mark.status,
    statusLabel: mark.label,
    progressLabel: `${bar.progress.completed}/${bar.progress.scope}`,
    tags: barTags(bar),
  };
  if (bar.status !== 'complete' && bar.rubric.gaps.length > 0) {
    out.missing = missingLabel(bar.rubric.gaps);
  }
  if (editable && bar.status !== 'complete') out.editable = true;
  return out;
}

/** An undated milestone as a dashed chip at the lane's end. */
function toUndatedChip(bar: CoreBar): TimelineUndated {
  const mark = assessmentMark(bar);
  return {
    id: bar.milestoneId,
    label: bar.name,
    status: mark.status,
    statusLabel: mark.label,
  };
}

/**
 * The quiet line under a project name: the lead; "No lead" and a deactivated
 * lead in the warning tone (amber: the project's milestones fail the rubric);
 * and "Inactive · <lead>" for projects outside the active statuses (drawn
 * muted, never loud).
 */
export function laneSublabel(lane: CoreLane): {
  sublabel: string;
  tone: UiTone;
} {
  const lead = lane.leadName ?? (lane.leadId === null ? null : 'Unknown lead');
  if (!lane.active) {
    return {
      sublabel: lead === null ? 'Inactive · no lead' : `Inactive · ${lead}`,
      tone: 'default',
    };
  }
  if (lead === null) return { sublabel: 'No lead', tone: 'warning' };
  if (lane.allocation?.blockReason === 'lead_inactive') {
    return { sublabel: `${lead} · deactivated`, tone: 'warning' };
  }
  return { sublabel: lead, tone: 'default' };
}

/** One project as a chart lane, its name linking to the project's task. */
function toChartLane(lane: CoreLane, opts: ChartOptions): TimelineLane {
  const { sublabel, tone } = laneSublabel(lane);
  const out: TimelineLane = {
    id: lane.projectId,
    label: lane.name,
    href: opts.hrefs.task(lane.projectId),
    sublabel,
    sublabelTone: tone,
    bars: lane.bars
      .filter((bar) => bar.end !== null)
      .map((bar) => toChartBar(bar, opts.canEdit)),
    undated: lane.undated.map(toUndatedChip),
  };
  if (!lane.active) out.muted = true;
  return out;
}

/** Every initiative group (and "No initiative") and its lanes, in the
 * planning core's timeline order. */
export function toChartGroups(
  view: TimelineView,
  opts: ChartOptions
): TimelineGroup[] {
  return view.groups.map((group) => ({
    id: group.initiativeId ?? NO_INITIATIVE_ID,
    label: group.name,
    lanes: group.lanes.map((lane) => toChartLane(lane, opts)),
  }));
}

/** The chart's calendar: the host's today and the first and last day drawn. */
export function timelineWindow(view: TimelineView): {
  today: string;
  windowStart: string;
  windowEnd: string;
} {
  return {
    today: view.today,
    windowStart: view.windowStart,
    windowEnd: view.windowEnd,
  };
}

/**
 * The workspace's milestone-level graph edges as chart connectors (`to`
 * waits on `from`), one per pair, leaving out an edge between two
 * milestones of inactive projects: paused work never pulls a connector
 * across the chart. Any other graph (another level, or milestones inside one
 * initiative or project) gives none: the chart draws the whole workspace's
 * connectors or nothing.
 */
export function chartDependencies(
  graph: DependencyGraph
): TimelineDependency[] {
  if (
    graph.scope.level !== 'milestone' ||
    graphContainer(graph.scope).kind !== 'workspace'
  ) {
    return [];
  }
  const active = new Map(graph.nodes.map((node) => [node.id, node.active]));
  const seen = new Map<string, TimelineDependency>();
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue;
    if (active.get(edge.from) === false && active.get(edge.to) === false) {
      continue;
    }
    const key = `${edge.from}\u0000${edge.to}`;
    const prior = seen.get(key);
    seen.set(key, {
      from: edge.from,
      to: edge.to,
      onRiskChain: edge.onRiskChain || prior?.onRiskChain === true,
    });
  }
  return [...seen.values()];
}

/* ---- filters -------------------------------------------------------------- */

/**
 * True when an active lane has an at-risk or overdue milestone. An inactive
 * (muted) lane never needs action, whatever its milestones' status.
 */
export function laneNeedsAction(lane: TimelineLane): boolean {
  return (
    lane.muted !== true &&
    lane.bars.some(
      (bar) => bar.status === 'overdue' || bar.status === 'at_risk'
    )
  );
}

/** The toolbar's one "Show" choice: every lane, active projects only, or
 * active projects with an at-risk or overdue milestone. */
export type TimelineShow = 'all' | 'active' | 'risk';

/** The "Show" cells. No counts: each initiative row of the chart already
 * counts the projects it shows. */
export const SHOW_OPTIONS: readonly SegmentedOption[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'risk', label: 'At risk' },
];

/** A "Show" value from a SegmentedControl's string; anything unknown is all. */
export function parseTimelineShow(value: string): TimelineShow {
  return value === 'active' || value === 'risk' ? value : 'all';
}

/**
 * Applies the toolbar's filters, dropping initiative groups left empty. The
 * search matches project names, case-insensitively.
 */
export function filterTimelineGroups(
  groups: readonly TimelineGroup[],
  show: TimelineShow,
  query = ''
): TimelineGroup[] {
  const needle = query.trim().toLowerCase();
  const out: TimelineGroup[] = [];
  for (const group of groups) {
    const lanes = group.lanes.filter(
      (lane) =>
        (needle === '' || lane.label.toLowerCase().includes(needle)) &&
        (show !== 'active' || lane.muted !== true) &&
        (show !== 'risk' || laneNeedsAction(lane))
    );
    if (lanes.length > 0) out.push({ ...group, lanes });
  }
  return out;
}

/** Connectors whose two ends are both drawn (dated bars still shown). */
export function visibleDependencies(
  dependencies: readonly TimelineDependency[],
  groups: readonly TimelineGroup[]
): TimelineDependency[] {
  const bars = new Set<string>();
  for (const group of groups) {
    for (const lane of group.lanes) {
      for (const bar of lane.bars) bars.add(bar.id);
    }
  }
  return dependencies.filter((dep) => bars.has(dep.from) && bars.has(dep.to));
}

/**
 * The header's receipts line: "9 projects (1 inactive) · 21 milestones ·
 * 3 overdue · 2 at risk · Oct 7 – Dec 30". Overdue and at risk count active
 * projects only (an inactive project is never loud; its lane is drawn in
 * greys), so the inactive count says why a grey overdue bar is not in them.
 */
export function timelineReceipts(view: TimelineView): string {
  let lanes = 0;
  let inactive = 0;
  let milestones = 0;
  let overdue = 0;
  let atRisk = 0;
  for (const group of view.groups) {
    for (const lane of group.lanes) {
      lanes += 1;
      if (!lane.active) inactive += 1;
      for (const bar of [...lane.bars, ...lane.undated]) {
        milestones += 1;
        if (!lane.active) continue;
        if (bar.status === 'overdue') overdue += 1;
        if (bar.status === 'at_risk') atRisk += 1;
      }
    }
  }
  return [
    inactive > 0
      ? `${plural(lanes, 'project')} (${inactive} inactive)`
      : plural(lanes, 'project'),
    plural(milestones, 'milestone'),
    `${overdue} overdue`,
    `${atRisk} at risk`,
    `${formatDate(view.windowStart, view.today)} – ${formatDate(view.windowEnd, view.today)}`,
  ].join(' · ');
}

/* ---- banners -------------------------------------------------------------- */

type TimelineBannerId = 'no_lead' | 'no_date' | 'unplanned';

/** One row of a banner's list: what it names and where it opens. */
interface TimelineBannerItem {
  id: string;
  label: string;
  href: string;
}

/** A banner as plain data, for the view to draw as an AlertStrip or Notice
 * with an expandable list of rows. */
export interface TimelineBanner {
  id: TimelineBannerId;
  /** Lead-in word: "No lead", "No date", "Unplanned". */
  label: string;
  /** The row's status tone: warning for every banner (a missing input, or
   * open issues no milestone counts), which colours its icon and lead-in. */
  tone: UiTone;
  count: number;
  /** One sentence with the count. */
  text: string;
  items: TimelineBannerItem[];
  /** A follow-up after the sentence ("Plan in Issues"). */
  action?: { label: string; href: string };
}

/** What the banners need to know about an issue without a milestone: the
 * view's title for each id the planning core counted. */
export interface UnplannedIssue {
  id: string;
  title: string;
}

/**
 * The timeline banners: active projects without a lead, milestones without
 * a target date (drawn as undated chips, never as bars), and open issues
 * without a milestone (per project, in the planning core's order; an id the
 * given list does not know is counted but not listed). Banners with nothing
 * in them are left out. Every row opens its task; the unplanned banner also
 * offers the Issues list.
 */
export function buildTimelineBanners(
  view: TimelineView,
  issuesWithoutMilestone: readonly UnplannedIssue[],
  hrefs: TimelineHrefs
): TimelineBanner[] {
  const { banners } = view;
  const out: TimelineBanner[] = [];

  const noLead = banners.projectsWithoutLead;
  if (noLead.length > 0) {
    out.push({
      id: 'no_lead',
      label: 'No lead',
      tone: 'warning',
      count: noLead.length,
      text:
        noLead.length === 1
          ? '1 active project has no lead, so its milestones fail the rubric.'
          : `${noLead.length} active projects have no lead, so their milestones fail the rubric.`,
      items: noLead.map((project) => ({
        id: project.projectId,
        label: project.name,
        href: hrefs.task(project.projectId),
      })),
    });
  }

  const noDate = banners.milestonesWithoutDate;
  if (noDate.length > 0) {
    out.push({
      id: 'no_date',
      label: 'No date',
      tone: 'warning',
      count: noDate.length,
      text:
        noDate.length === 1
          ? '1 milestone has no target date, so it fails the rubric and sits undated at the end of its lane.'
          : `${noDate.length} milestones have no target date, so they fail the rubric and sit undated at the end of their lanes.`,
      items: noDate.map((milestone) => ({
        id: milestone.milestoneId,
        label: `${milestone.projectName} › ${milestone.name}`,
        href: hrefs.task(milestone.milestoneId),
      })),
    });
  }

  const unplanned = banners.issuesWithoutMilestone;
  if (unplanned.count > 0) {
    const titles = new Map(
      issuesWithoutMilestone.map((issue) => [issue.id, issue.title])
    );
    const items: TimelineBannerItem[] = [];
    for (const project of unplanned.byProject) {
      for (const id of project.issueIds) {
        const title = titles.get(id);
        if (title === undefined) continue;
        items.push({
          id,
          label: `${project.name} › ${title}`,
          href: hrefs.task(id),
        });
      }
    }
    out.push({
      id: 'unplanned',
      label: 'Unplanned',
      tone: 'warning',
      count: unplanned.count,
      text:
        unplanned.count === 1
          ? '1 open issue has no milestone, so no milestone counts it. Move it into one, or cancel it.'
          : `${unplanned.count} open issues in ${plural(unplanned.byProject.length, 'project')} have no milestone, so no milestone counts them. Move them into one, or cancel them.`,
      items,
      action: { label: 'Plan in Issues', href: hrefs.issues() },
    });
  }

  return out;
}

/* ---- the drawer's Milestone section ---------------------------------------- */

export interface MilestoneSectionOptions {
  /** The timeline view, for the project's activity (an inactive project's
   * milestone is drawn quietly) and which of its milestones is next. */
  view?: TimelineView;
  /** Every milestone's assessment, for the status of what this one waits on.
   * Without it those rows carry the plain open mark. */
  assessments?: ReadonlyMap<string, MilestoneAssessment>;
}

interface MilestoneWaitsOn extends StatusMarkModel {
  id: string;
  /** The milestone's name; `project` is its project's. */
  name: string;
  project: string;
}

interface MilestoneOpenIssue extends StatusMarkModel {
  id: string;
  title: string;
}

/** The Milestone section of the task drawer and page, for a container of
 * kind milestone: its assessed status, due date, progress, rubric checklist,
 * the milestones it waits on and its open issues. */
export interface MilestoneSection {
  status: {
    status: UiStatus;
    label: string;
    /** Risk reasons and missing rubric input, as plain lines. */
    lines: string[];
  };
  due: {
    /** YYYY-MM-DD or null (no target date). */
    value: string | null;
    /** "Oct 18 · 3 days overdue", "No target date". */
    label: string;
    /** dueTone: danger overdue, warning with no target date or due today or
     * tomorrow, else default; default in an inactive project. */
    tone: UiTone;
  };
  progress: {
    done: number;
    total: number;
    /** progressTone: danger overdue, warning behind pace, success complete,
     * muted in an inactive project, default (the accent fill) otherwise. */
    tone: UiTone;
  };
  /** This is its project's next milestone. */
  isNext: boolean;
  /** The project's next milestone when this is not it (and the view knows
   * the lane); null otherwise. */
  next: { id: string; name: string } | null;
  rubric: ChecklistItem[];
  waitsOn: MilestoneWaitsOn[];
  openIssues: MilestoneOpenIssue[];
  /**
   * The milestone of an inactive project: never loud. A grey status mark
   * (its label still names the status), and no status hue on the due date
   * or the progress.
   */
  muted: boolean;
}

const RUBRIC_ORDER: readonly RubricGap[] = [
  'no_target_date',
  'no_done_means',
  'no_project_lead',
  'no_issues',
];

const RUBRIC_ITEM_LABEL: Record<RubricGap, string> = {
  no_target_date: 'Target date',
  no_done_means: '"Done means…"',
  no_project_lead: 'Project lead',
  no_issues: 'At least one issue',
};

/** Where a missing rubric item is fixed, in Dispatch's terms: a milestone's
 * target date is its due date, a project's lead is its assignee. */
const RUBRIC_FIX: Record<RubricGap, string> = {
  no_target_date: 'Set a due date on the milestone.',
  no_done_means:
    'Start a line of the milestone\'s description with "Done means:".',
  no_project_lead: 'Assign the project to someone.',
  no_issues: 'Move issues into this milestone.',
};

/**
 * The rubric as four checklist items, worded with RUBRIC_GAP_LABEL and where
 * to fix it when an item is missing, with what is there when it is met.
 */
export function rubricChecklist(
  detail: MilestoneDetail,
  today: string
): ChecklistItem[] {
  const { milestone, assessment } = detail;
  const gaps = new Set(assessment.rubric.gaps);
  const metNote: Record<RubricGap, string> = {
    no_target_date:
      milestone.targetDate === null
        ? ''
        : formatDate(milestone.targetDate, today),
    no_done_means:
      assessment.doneMeans.source === 'planner'
        ? 'Set on the milestone'
        : assessment.doneMeans.source === 'linear_description'
          ? 'From the description'
          : '',
    no_project_lead: detail.leadName ?? '',
    no_issues: plural(assessment.progress.total, 'issue'),
  };
  return RUBRIC_ORDER.map((gap) => {
    const met = !gaps.has(gap);
    return {
      id: gap,
      label: RUBRIC_ITEM_LABEL[gap],
      met,
      note: met ? metNote[gap] : `${RUBRIC_GAP_LABEL[gap]}. ${RUBRIC_FIX[gap]}`,
    };
  });
}

/** The timeline lane of a project, when the view is given and draws it. */
function laneOf(
  view: TimelineView | undefined,
  projectId: string
): CoreLane | undefined {
  if (view === undefined) return undefined;
  for (const group of view.groups) {
    const lane = group.lanes.find(
      (candidate) => candidate.projectId === projectId
    );
    if (lane !== undefined) return lane;
  }
  return undefined;
}

/** An open issue's mark (issueMark) from its planning row. */
function openIssueOf(issue: MilestoneIssueRow): MilestoneOpenIssue {
  return {
    id: issue.issueId,
    title: issue.title,
    ...issueMark({
      open: true,
      unassigned: issue.assigneeId === null,
      stateName: issue.stateName,
    }),
  };
}

/**
 * The Milestone section: status (with its risk and missing-input lines),
 * due date, progress, rubric, what it waits on and its open issues, each
 * coloured through the shared tone rules. `assessment` is the milestone's
 * own (what `detail.assessment` holds; the view hands it over from the
 * assessments it already keeps). An inactive project's milestone keeps its
 * real status, said quietly: its dates are not deadlines while the project
 * is paused.
 */
export function buildMilestoneSection(
  detail: MilestoneDetail,
  assessment: MilestoneAssessment,
  today: string,
  opts: MilestoneSectionOptions = {}
): MilestoneSection {
  const { milestone, project } = detail;
  const mark = assessmentMark(assessment);
  const lane = laneOf(opts.view, project.id);
  const muted = lane !== undefined && !lane.active;

  const lines = assessment.reasons.map((reason) => RISK_REASON_LABEL[reason]);
  if (!assessment.rubric.valid && assessment.status !== 'complete') {
    const gaps = missingLine(assessment.rubric.gaps);
    lines.push(gaps.charAt(0).toUpperCase() + gaps.slice(1));
  }

  // The lane's next milestone, when it is another one: bars carry `isNext`
  // from the same assessments, so no allocation plan is needed.
  const nextBar = assessment.isNext
    ? undefined
    : lane === undefined
      ? undefined
      : [...lane.bars, ...lane.undated].find((bar) => bar.isNext);

  return {
    status: {
      status: mark.status,
      label: muted ? `${mark.label} · inactive project` : mark.label,
      lines,
    },
    due: {
      value: milestone.targetDate,
      label: dueLabel(
        milestone.targetDate,
        assessment.daysLeft,
        today,
        assessment.status
      ),
      tone: muted
        ? 'default'
        : dueTone(
            assessment.status,
            assessment.daysLeft,
            milestone.targetDate === null
          ),
    },
    progress: {
      done: assessment.progress.completed,
      total: assessment.progress.scope,
      tone: progressTone(assessment, muted),
    },
    isNext: assessment.isNext,
    next:
      nextBar === undefined
        ? null
        : { id: nextBar.milestoneId, name: nextBar.name },
    rubric: rubricChecklist(detail, today),
    waitsOn: detail.waitsOn.map((other) => {
      const theirs = opts.assessments?.get(other.milestoneId);
      const otherMark: StatusMarkModel =
        theirs === undefined
          ? { status: 'open', label: 'Status unknown' }
          : assessmentMark(theirs);
      return {
        id: other.milestoneId,
        name: other.name,
        project: other.projectName,
        ...otherMark,
      };
    }),
    openIssues: detail.issues
      .filter((issue) => isOpenState(issue.stateType))
      .map(openIssueOf),
    muted,
  };
}
