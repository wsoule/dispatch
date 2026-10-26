import type {
  Priority,
  StatusModel,
  TaskListItem,
} from '@dispatch-foo/core/browser';
import {
  canonicalKind,
  isContainerKind,
  isDoneStatus,
  statusType,
} from '@dispatch-foo/core/browser';
import type {
  EpicChildPhase,
  EpicProgress,
  EpicProgressChild,
  LinearIssueLink,
  MergeQueueEntryState,
  RunState,
} from '@dispatch/client';
import type {
  NavTabItem,
  PickerMark,
  TaskChipData,
  TaskColumnId,
  TaskGroupData,
  TaskPriority,
  TaskRowData,
  TaskSectionData,
  UiStatus,
  UiTone,
} from '@dispatch/ui';

import { containerStatus } from '../lib/containerStatus';
import { PHASE_LABEL, showsPhasePill } from '../lib/epicSession';
import { landingBadgeTitle } from '../lib/landingBadge';
import { resolveLinearLink } from '../lib/linearSettings';
import type { ListGroup, ListGroupRow } from '../lib/listGrouping';
import { dueDateInfo } from '../lib/taskDates';
import { assigneeRef, priorityLabel, statusLabel } from '../lib/taskDisplay';
import {
  clauseParts,
  FILTER_NONE,
  type FilterContext,
  type FilterFacet,
  type FilterOp,
  type TaskFilterSet,
} from '../lib/taskFilters';
import { TASKS_PRESETS, type TasksPreset } from '../lib/tasksPresets';
import type { TaskBucket, TaskStatusCounts } from '../lib/taskStatus';
import { assigneeDisplay } from './people';
import { projectMark } from './shell';

// Dispatch's grouped task list (`groupTasks`'s ListGroups over TaskListItems,
// plus the window's live facts: buckets, runs, the merge queue, fan-out
// sessions, unread counts, pending dispatches) → @dispatch/ui's TaskGroupTable
// shapes (sections, groups, rows, chips), plus the preset tabs and the filter
// chips around it. Pure functions over plain data, deterministic for a given
// `now`, unit-tested without React. Everything a row showed in the old list
// (TaskListRow) has a place here: the priority, id and status glyphs are the
// table's cells; the label pills, the Dispatch overlay (Needs you, Failed,
// Agent working, Review, Landing, Blocked), the run and fan-out phase, the
// sub-task count and the unread count are chips; the epic chip is the
// milestone and project cells. A run's cost and open findings count moved to
// the detail pane.

/** The words for no assignee where the task needs one, so the amber repeats a
 * word instead of being the only difference from the grey "Unassigned". */
export const NEEDS_ASSIGNEE_LABEL = 'Needs assignee';

/** What the view hands every row and group builder: the window's data, as
 * maps keyed by task id so each row is O(1) to build. Every optional map may
 * be left out while its data loads. */
export interface RowContext {
  /** The project's status model (`useStatusModelOf(config)`): a status's
   * workflow type and whether it is done. */
  model: StatusModel;
  /** Every task the window knows (containers and archived tasks included)
   * by id: the hierarchy walk behind the project and milestone cells and the
   * group headers reads it. */
  tasksById: ReadonlyMap<string, TaskListItem>;
  /** The person an assignee names (PeopleContext's `personFor`). */
  personFor: (assignee: string) => { name: string } | undefined;
  /** An open task's one bucket (`itemBucket`, folding the window's asks,
   * attention, latest runs, merge queue and blocked ids); null for a
   * container or finished work. */
  bucketOf: (task: TaskListItem) => TaskBucket | null;
  /** `GET /api/linear/links`: issue UUID → identifier and URL. */
  linearLinks?: Readonly<Record<string, LinearIssueLink>>;
  /** Each task's live (non-terminal) run state. */
  liveRunStateByTaskId?: ReadonlyMap<string, RunState>;
  /** Where a task's run stands in the merge queue (`landingStateByTaskId`). */
  landingByTaskId?: ReadonlyMap<string, MergeQueueEntryState>;
  /** Fan-out progress per epic: each child's phase, the session's state. */
  epicProgressById?: ReadonlyMap<string, EpicProgress>;
  /** Open asks per task (`needsYou().byTask`), for a container header. */
  asksByTaskId?: ReadonlyMap<string, number>;
  /** Unread messages to me per task. */
  unreadByTaskId?: ReadonlyMap<string, number>;
  /** Tasks whose dispatch is in flight (the optimistic `d`). */
  pendingDispatch?: ReadonlySet<string>;
  /** Why a task's last edit was not saved, by task id. */
  saveErrorByTaskId?: ReadonlyMap<string, string>;
  /** How many tasks sit under each parent (the sub-task count). */
  childCountByParent?: ReadonlyMap<string, number>;
  /** The clock every date is read against. */
  now: Date;
  /** Where a row opens (`taskHref`). */
  hrefFor: (taskId: string) => string;
}

export interface RowOptions {
  /** The project is already named, by the group header or the project column:
   * the milestone cell leaves its project out. */
  projectNamed?: boolean;
  /** A row of the Archived section: no overlay chips, no pending state and no
   * assignee tone; its labels and sub-task count stay. */
  archived?: boolean;
}

const PRIORITY_SCALE: Record<Priority, TaskPriority> = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

const PRIORITY_NAME: Record<TaskPriority, Priority> = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
};

/** Dispatch's priority word on the table's scale (0 none, 1 urgent … 4 low). */
export function toTaskPriority(priority: Priority): TaskPriority {
  return PRIORITY_SCALE[priority];
}

/** The table's priority back to Dispatch's word (a PriorityPicker's value). */
export function fromTaskPriority(priority: TaskPriority): Priority {
  return PRIORITY_NAME[priority];
}

// The Dispatch overlay: one chip per bucket, in the bucket's own hue. Needs
// you and Failed are the strong claims (tinted badges); the rest are dot pills.
// Ready and draft say nothing the state glyph does not.
const BUCKET_CHIP: Partial<Record<TaskBucket, TaskChipData>> = {
  'need-you': { label: 'Needs you', tone: 'warning', filled: true },
  failed: { label: 'Failed', tone: 'danger', filled: true },
  working: { label: 'Agent working', tone: 'info' },
  review: { label: 'Review', tone: 'info' },
  landing: { label: 'Landing', tone: 'info' },
  blocked: { label: 'Blocked', tone: 'warning' },
};

// A live run's state as a quiet chip, only where it says more than the bucket
// does: "Agent working" already covers `running`.
const RUN_STATE_CHIP: Partial<Record<RunState, string>> = {
  provisioning: 'Provisioning',
  'awaiting-approval': 'Awaiting approval',
};

// A fan-out phase's hue, following the old pill's tints: motion blue, a pause
// amber, a failure red.
const PHASE_TONE: Partial<Record<EpicChildPhase, UiTone>> = {
  working: 'info',
  reviewing: 'info',
  fixing: 'info',
  capped: 'warning',
  held: 'warning',
  waiting: 'warning',
  failed: 'danger',
  blocked: 'warning',
};

// The phases whose word the bucket chip already says, so the row does not
// print "Agent working" and "Working" side by side (a `waiting` child is one
// waiting on its blockers: "Blocked" already says it).
const PHASE_SAID_BY_BUCKET: Partial<Record<EpicChildPhase, TaskBucket>> = {
  working: 'working',
  waiting: 'blocked',
  failed: 'failed',
  blocked: 'blocked',
};

/** The containers on a task's parent chain: the nearest one of any kind, the
 * nearest milestone and the nearest project. A parent issue passes through to
 * its own parent; a dangling id or a cycle ends the walk. */
interface ContainersAbove {
  nearest?: TaskListItem;
  milestone?: TaskListItem;
  project?: TaskListItem;
}

// Walks up from `parentId` through `tasksById`. O(depth) per call, and the
// hierarchy is three deep at most (initiative › project › milestone › task).
function containersAbove(
  parentId: string | null,
  tasksById: ReadonlyMap<string, TaskListItem>
): ContainersAbove {
  const out: ContainersAbove = {};
  const seen = new Set<string>();
  let id = parentId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const node = tasksById.get(id);
    if (node === undefined) break;
    if (isContainerKind(node.meta.kind)) {
      out.nearest ??= node;
      const kind = canonicalKind(node.meta.kind);
      if (kind === 'milestone') out.milestone ??= node;
      if (kind === 'project') out.project ??= node;
    }
    id = node.meta.parent;
  }
  return out;
}

// Each fan-out's children by id, built once per progress snapshot (the
// snapshot object is stable until the query refetches), so a row's phase is
// one map lookup instead of a scan of the epic's children.
const childIndex = new WeakMap<EpicProgress, Map<string, EpicProgressChild>>();

function phaseOf(
  doc: TaskListItem,
  ctx: RowContext
): EpicProgressChild | undefined {
  if (doc.meta.parent === null) return undefined;
  const progress = ctx.epicProgressById?.get(doc.meta.parent);
  if (progress === undefined) return undefined;
  let byId = childIndex.get(progress);
  if (byId === undefined) {
    byId = new Map(progress.children.map((child) => [child.id, child]));
    childIndex.set(progress, byId);
  }
  return byId.get(doc.meta.id);
}

interface DueFacts {
  label: string;
  tone?: UiTone;
  note?: string;
}

// A due date against `now`: red with "Overdue" once past, amber with "Today" /
// "Tomorrow" on the day and the eve, plain otherwise; a finished task's date is
// never coloured (it is no longer a deadline).
function dueFacts(dueDate: string, now: Date, done: boolean): DueFacts {
  const info = dueDateInfo(dueDate, now, done);
  if (done) return { label: info.date };
  if (info.overdue)
    return { label: info.date, tone: 'danger', note: 'Overdue' };
  if (info.relative === 'Today' || info.relative === 'Tomorrow') {
    return { label: info.date, tone: 'warning', note: info.relative };
  }
  return { label: info.date };
}

// The row's chips in a fixed order: the task's labels as plain chips, then
// the Dispatch overlay (the bucket; a live run's state when informative; the
// merge-queue step, folded into the Landing chip when that is the bucket; the
// fan-out phase when it adds a word), then the sub-task and unread counts.
function rowChips(
  doc: TaskListItem,
  bucket: TaskBucket | null,
  ctx: RowContext,
  archived: boolean
): TaskChipData[] {
  const id = doc.meta.id;
  const chips: TaskChipData[] = doc.meta.labels.map((label) => ({ label }));
  if (!archived) {
    const landing = ctx.landingByTaskId?.get(id);
    const live = ctx.liveRunStateByTaskId?.get(id);
    // The working bucket also covers a started status with no run (a person
    // moved it); "Agent working" is only claimed over a live run, the state
    // glyph says "Working" either way.
    const bucketChip =
      bucket === null || (bucket === 'working' && live === undefined)
        ? undefined
        : BUCKET_CHIP[bucket];
    if (bucketChip !== undefined) {
      chips.push(
        bucket === 'landing' && landing !== undefined
          ? { ...bucketChip, label: landingBadgeTitle(landing) }
          : bucketChip
      );
    }
    const runWord = live === undefined ? undefined : RUN_STATE_CHIP[live];
    if (runWord !== undefined) chips.push({ label: runWord, tone: 'muted' });
    if (landing !== undefined && bucket !== 'landing') {
      chips.push({ label: landingBadgeTitle(landing), tone: 'info' });
    }
    const phase = phaseOf(doc, ctx);
    if (
      phase !== undefined &&
      showsPhasePill(phase.phase) &&
      PHASE_SAID_BY_BUCKET[phase.phase] !== bucket
    ) {
      chips.push({
        label: PHASE_LABEL[phase.phase],
        tone: PHASE_TONE[phase.phase],
      });
    }
  }
  const children = ctx.childCountByParent?.get(id) ?? 0;
  if (children > 0) {
    chips.push({
      label: `${children} sub-task${children === 1 ? '' : 's'}`,
      tone: 'muted',
    });
  }
  const unread = ctx.unreadByTaskId?.get(id) ?? 0;
  if (unread > 0) chips.push({ label: `${unread} unread`, tone: 'accent' });
  return chips;
}

/**
 * One list row as the table draws it. The key is the Linear identifier when
 * the task is linked and the links map knows it (the ↗ then opens the issue in
 * Linear), else the task id; the state is the status's label and workflow type
 * (an unknown status types as backlog, as core does); the project and
 * milestone cells name the nearest containers above the task; the due date
 * is toned against `ctx.now`; the chips are `rowChips`; an open, specified
 * task with nobody on it reads "Needs assignee" in amber (a draft is not yet
 * anyone's to pick up, and a container or finished task needs nobody); a
 * pending dispatch marks the row busy with "Dispatching…", a failed save
 * prints "Not saved · why" in red. `indent` is the group's nesting.
 */
export function toTaskRow(
  row: ListGroupRow,
  ctx: RowContext,
  opts: RowOptions = {}
): TaskRowData & { indent?: 0 | 1 } {
  const { doc } = row;
  const { meta } = doc;
  const id = meta.id;
  const archived = opts.archived === true;
  const done = isDoneStatus(meta.status, ctx.model);
  const link =
    ctx.linearLinks === undefined
      ? null
      : resolveLinearLink(meta.external, ctx.linearLinks);
  const above = containersAbove(meta.parent, ctx.tasksById);
  const bucket = archived ? null : ctx.bucketOf(doc);
  const who = assigneeDisplay(meta.assignee, ctx.personFor);
  const unassigned = assigneeRef(meta.assignee) === null;
  const out: TaskRowData & { indent?: 0 | 1 } = {
    id,
    key: link?.identifier ?? id,
    title: meta.title,
    href: ctx.hrefFor(id),
    state: statusLabel(meta.status),
    stateKind: statusType(meta.status, ctx.model),
    priority: toTaskPriority(meta.priority),
    priorityLabel: priorityLabel(meta.priority),
    assignee: unassigned ? null : who.label,
    milestone: above.milestone?.meta.title ?? null,
    done,
    indent: row.indent,
  };
  if (link !== null) {
    out.externalHref = link.url;
    out.externalLabel = `Open ${link.identifier} in Linear`;
  }
  if (above.project !== undefined) {
    out.project = above.project.meta.title;
    if (above.milestone !== undefined && opts.projectNamed !== true) {
      out.milestoneProject = above.project.meta.title;
    }
  }
  if (meta.dueDate !== null) {
    const due = dueFacts(meta.dueDate, ctx.now, done);
    out.due = due.label;
    if (due.tone !== undefined) {
      out.dueTone = due.tone;
      out.dueNote = due.note;
    }
  }
  const chips = rowChips(doc, bucket, ctx, archived);
  if (chips.length > 0) out.chips = chips;
  if (unassigned && bucket !== null && bucket !== 'draft') {
    out.assigneeTone = 'warning';
    out.unassignedLabel = NEEDS_ASSIGNEE_LABEL;
  }
  if (!archived) {
    const saveError = ctx.saveErrorByTaskId?.get(id);
    if (ctx.pendingDispatch?.has(id) === true) {
      out.pending = true;
      out.note = { text: 'Dispatching…' };
    } else if (saveError !== undefined) {
      out.note = { text: `Not saved · ${saveError}`, tone: 'danger' };
    }
  }
  return out;
}

export interface GroupOptions {
  /** The project column is shown: milestone cells leave their project out
   * (a container group's header names it anyway). */
  projectNamed?: boolean;
  /** A group's footer: its text and the host's actions (the fan-out verbs,
   * "Show more"). Actions carry callbacks, so the view supplies them; none
   * draws no footer. */
  footerFor?: (group: ListGroup) => TaskGroupData['footer'] | undefined;
}

// What an empty group says, by what it groups.
const EMPTY_LABEL: Record<ListGroup['kind'], string> = {
  status: 'No issues in this status',
  epic: 'No issues here yet',
  milestone: 'No issues here yet',
  assignee: 'Nothing assigned',
  priority: 'No issues at this priority',
  none: 'No issues',
  archived: 'Nothing archived',
};

// The progress rule's hue follows the header's diamond: red overdue, amber
// needing attention, green once everything landed, the accent otherwise.
const PROGRESS_TONE: Partial<Record<UiStatus, UiTone>> = {
  overdue: 'danger',
  at_risk: 'warning',
  done: 'success',
};

const NO_ASKS: ReadonlyMap<string, number> = new Map();

// A container group's header facts: the diamond and its words from the rows'
// rolled-up status (`projectMark`, the sidebar's reading: done once every
// child landed, overdue past its due date, at risk with asks or failures,
// on track otherwise, missing with no rows), the done/total progress, the due
// date with how far off it is, "Paused" while the fan-out session is paused,
// and muted once finished.
function containerHeading(
  container: TaskListItem,
  group: ListGroup,
  ctx: RowContext
): Partial<TaskGroupData> {
  const status = containerStatus(
    group.rows.map((row) => row.doc),
    {
      bucketOf: ctx.bucketOf,
      asksByTask: ctx.asksByTaskId ?? NO_ASKS,
      model: ctx.model,
    }
  );
  const finished = status.health === 'finished';
  const dueDate = container.meta.dueDate;
  const mark = projectMark(status, dueDate, ctx.now);
  const out: Partial<TaskGroupData> = {
    status: mark.status,
    statusLabel: mark.label,
  };
  if (status.total > 0) {
    out.progress = {
      done: status.done,
      total: status.total,
      tone: PROGRESS_TONE[mark.status],
    };
  }
  if (dueDate !== null) {
    const info = dueDateInfo(dueDate, ctx.now, finished);
    out.dueLabel = info.date;
    out.daysLeftLabel = finished ? 'Done' : info.relative;
    if (info.overdue) out.dueTone = 'danger';
    else if (
      !finished &&
      (info.relative === 'Today' || info.relative === 'Tomorrow')
    ) {
      out.dueTone = 'warning';
    }
  }
  const session = ctx.epicProgressById?.get(container.meta.id)?.session;
  if (session?.state === 'paused') out.tags = ['Paused'];
  if (finished) out.muted = true;
  return out;
}

// The glyph in a non-container group's header: the state ring, the priority
// bars or the avatar (blank for Unassigned). A container group shows its
// status diamond instead, and "No epic" nothing.
function groupMark(group: ListGroup, ctx: RowContext): PickerMark | undefined {
  const icon = group.icon;
  if (icon === null) return undefined;
  switch (icon.kind) {
    case 'status':
      return { kind: 'state', state: statusType(icon.status, ctx.model) };
    case 'priority':
      return { kind: 'priority', priority: toTaskPriority(icon.priority) };
    case 'assignee':
      return {
        kind: 'avatar',
        name:
          assigneeRef(icon.assignee) === null
            ? ''
            : assigneeDisplay(icon.assignee, ctx.personFor).label,
      };
    case 'epic':
    case 'milestone':
      return undefined;
  }
}

/**
 * One group as the table draws it: keyed by the ListGroup's key (so collapse
 * state and drop targets line up), titled by its container (an assignee group
 * by the person's name, the headerless `all` group "All issues"), with the
 * parent container as its eyebrow and `containerHeading`'s facts when it
 * stands for an epic or a milestone, else a state, priority or avatar mark.
 * Status, epic and milestone groups take drops (`dropTargetFor` says what a
 * drop does); the Archived group is muted and takes none.
 */
export function toTaskGroup(
  group: ListGroup,
  ctx: RowContext,
  opts: GroupOptions = {}
): TaskGroupData {
  const container =
    group.epicId === null ? undefined : ctx.tasksById.get(group.epicId);
  const byContainer = group.kind === 'epic' || group.kind === 'milestone';
  const rowOpts: RowOptions = {
    projectNamed: byContainer || opts.projectNamed === true,
    archived: group.archived,
  };
  const rows = group.rows.map((row) => toTaskRow(row, ctx, rowOpts));
  const out: TaskGroupData = {
    id: group.key,
    title: groupTitle(group, container, ctx),
    rows,
    count: rows.length,
    droppable: (byContainer || group.kind === 'status') && !group.archived,
    emptyLabel: EMPTY_LABEL[group.kind],
  };
  if (container !== undefined) {
    const outer = containersAbove(container.meta.parent, ctx.tasksById).nearest;
    if (outer !== undefined) out.eyebrow = outer.meta.title;
    Object.assign(out, containerHeading(container, group, ctx));
  }
  const mark = groupMark(group, ctx);
  if (mark !== undefined) out.mark = mark;
  if (group.archived) out.muted = true;
  const footer = opts.footerFor?.(group);
  if (footer !== undefined) out.footer = footer;
  return out;
}

function groupTitle(
  group: ListGroup,
  container: TaskListItem | undefined,
  ctx: RowContext
): string {
  if (container !== undefined) return container.meta.title;
  if (group.key === 'all') return 'All issues';
  if (group.icon?.kind === 'assignee') {
    return assigneeDisplay(group.icon.assignee, ctx.personFor).label;
  }
  return group.label;
}

export interface SectionOptions extends Pick<GroupOptions, 'footerFor'> {
  /** The columns the table shows (`columnsForPrefs`): with a project column
   * the milestone cells leave their project out. */
  columns?: readonly TaskColumnId[];
}

/**
 * The table's sections: every live group under one unnamed "issues" section
 * (no divider), and the Archived group, when the toggle shows it, under a
 * labelled "archived" section. No groups at all gives no sections, so the
 * table shows its empty message.
 */
export function toTaskSections(
  groups: readonly ListGroup[],
  ctx: RowContext,
  opts: SectionOptions = {}
): TaskSectionData[] {
  const groupOpts: GroupOptions = {
    projectNamed: opts.columns?.includes('project') ?? false,
    footerFor: opts.footerFor,
  };
  const issues: TaskGroupData[] = [];
  const archived: TaskGroupData[] = [];
  for (const group of groups) {
    (group.archived ? archived : issues).push(
      toTaskGroup(group, ctx, groupOpts)
    );
  }
  const sections: TaskSectionData[] = [];
  if (issues.length > 0) sections.push({ id: 'issues', groups: issues });
  if (archived.length > 0) {
    sections.push({ id: 'archived', label: 'Archived', groups: archived });
  }
  return sections;
}

/** Every row id in drawn order (a Shift-range and the j/k walk read it). */
export function rowIdsInOrder(sections: readonly TaskSectionData[]): string[] {
  const ids: string[] = [];
  for (const section of sections) {
    for (const group of section.groups) {
      for (const row of group.rows) ids.push(row.id);
    }
  }
  return ids;
}

/** Each row's group id, built once so a drop or a menu finds a row's group
 * without scanning the sections. */
export function rowGroupIndex(
  sections: readonly TaskSectionData[]
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const section of sections) {
    for (const group of section.groups) {
      for (const row of group.rows) index.set(row.id, group.id);
    }
  }
  return index;
}

/** What dropping rows on a group does: move them to a status, or re-parent
 * them (null = no parent, the "No epic" / "No milestone" group). */
export type DropTarget =
  | { kind: 'status'; status: string }
  | { kind: 'parent'; parentId: string | null };

/**
 * The drop a group key stands for: `status:<s>` moves to that status;
 * `epic:<id>` and `milestone:<id>` re-parent under that container,
 * `epic:none` under nothing. Assignee, priority, `all` and `archived` groups
 * take no drops (null), as `toTaskGroup` marks them.
 */
export function dropTargetFor(groupId: string): DropTarget | null {
  const colon = groupId.indexOf(':');
  if (colon === -1) return null;
  const kind = groupId.slice(0, colon);
  const value = groupId.slice(colon + 1);
  if (value === '') return null;
  if (kind === 'status') return { kind: 'status', status: value };
  if (kind === 'epic') {
    return { kind: 'parent', parentId: value === 'none' ? null : value };
  }
  if (kind === 'milestone') return { kind: 'parent', parentId: value };
  return null;
}

/** Why dropping `rowIds` on a group would do nothing, or `true` when the
 * table may take the drop: the group must stand for a status or a container
 * (`dropTargetFor`), no dragged row may be a container itself (projects and
 * milestones move through their own pages), and a container group cannot take
 * its own row. The words are shown in the group header while the drag is
 * over it. */
export function dropVerdict(
  rowIds: readonly string[],
  groupId: string,
  tasksById: ReadonlyMap<string, TaskListItem>
): true | string {
  const target = dropTargetFor(groupId);
  if (target === null) return 'Drop on a status or a milestone';
  for (const id of rowIds) {
    const doc = tasksById.get(id);
    if (doc !== undefined && isContainerKind(doc.meta.kind)) {
      return 'Projects and milestones stay where they are';
    }
    if (target.kind === 'parent' && target.parentId === id) {
      return 'A task cannot hold itself';
    }
  }
  return true;
}

export interface PresetTabsExtra {
  /** The preset the list shows. */
  current: TasksPreset;
  /** Tasks assigned to me (the Mine preset's count). */
  mine: number;
  /** Starred tasks. */
  starred: number;
  /** Tasks with an ask of mine; the need-you bucket's count by default. */
  needsYou?: number;
  /** Each tab's link; a tab without one is drawn as not followable, so a
   * view that navigates itself passes `onFollow` on the result instead. */
  hrefFor?: (preset: TasksPreset) => string;
}

// A preset's count: its bucket's, the landed total, or the extra the view
// counted. All carries none (the list's own count is the receipt).
function presetCount(
  preset: TasksPreset,
  counts: TaskStatusCounts,
  extra: PresetTabsExtra
): number | undefined {
  switch (preset) {
    case 'all':
      return undefined;
    case 'mine':
      return extra.mine;
    case 'needs-you':
      return extra.needsYou ?? counts.buckets['need-you'];
    case 'failed':
      return counts.buckets.failed;
    case 'moving':
      return counts.buckets.working;
    case 'review':
      return counts.buckets.review;
    case 'ready':
      return counts.buckets.ready;
    case 'landing':
      return counts.buckets.landing;
    case 'landed':
      return counts.landed;
    case 'starred':
      return extra.starred;
  }
}

/** The preset strip as NavTabs: `TASKS_PRESETS` in order, each with its
 * count and the current one marked. */
export function presetTabs(
  counts: TaskStatusCounts,
  extra: PresetTabsExtra
): NavTabItem[] {
  return TASKS_PRESETS.map(({ id, label }) => {
    const item: NavTabItem = { id, label, current: id === extra.current };
    const count = presetCount(id, counts, extra);
    if (count !== undefined) item.count = count;
    if (extra.hrefFor !== undefined) item.href = extra.hrefFor(id);
    return item;
  });
}

/** One applied filter as FilterChips draws it, without the callbacks (the
 * view attaches `onRemove` and `renderEditor` by `index`). */
export interface FilterChipModel {
  /** Stable per clause position: `status:0`. */
  id: string;
  /** The clause's index in the filter set (`removeFilterClause`'s argument). */
  index: number;
  facet: FilterFacet;
  op: FilterOp;
  /** The facet's name: "Status". */
  field: string;
  /** Read after the chip's "is": the values, "not …", "before …", "after …". */
  summary: string;
  /** An epic the window does not know (deleted, or in another project). */
  unknown?: boolean;
  removeLabel: string;
}

// The chip prints "<field> is <summary>", so an operator other than `is`
// goes into the summary: "Status is not Done", "Created is after Sep 1".
// `includes` reads as `is` ("Labels is ui, api"): the chip has no room for
// the "has every one of" distinction, which the filter menu keeps.
function chipSummary(op: FilterOp, values: string): string {
  switch (op) {
    case 'is':
    case 'includes':
      return values;
    case 'is not':
      return `not ${values}`;
    case 'before':
    case 'after':
      return `${op} ${values}`;
  }
}

/** The applied filters as chip data, one per clause in set order, with the
 * values in their reading labels (`clauseParts`). */
export function filterChips(
  filters: TaskFilterSet,
  ctx: FilterContext = {}
): FilterChipModel[] {
  return filters.clauses.map((clause, index) => {
    const parts = clauseParts(clause, ctx);
    const chip: FilterChipModel = {
      id: `${clause.facet}:${index}`,
      index,
      facet: clause.facet,
      op: clause.op,
      field: parts.facet,
      summary: chipSummary(clause.op, parts.values),
      removeLabel: `Remove ${parts.facet.toLowerCase()} filter`,
    };
    const titles = ctx.epicTitleById;
    if (
      clause.facet === 'epic' &&
      titles !== undefined &&
      clause.values.some((value) => value !== FILTER_NONE && !titles.has(value))
    ) {
      chip.unknown = true;
    }
    return chip;
  });
}
