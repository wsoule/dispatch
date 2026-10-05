import type { TaskListItem } from '@dispatch-foo/core/browser';
import { isContainerKind, statusModelOf } from '@dispatch-foo/core/browser';
import { GitBranch, SearchX } from 'lucide-react';
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  BRANCH_LINE_HEIGHT,
  BranchGraph,
} from '../components/graph/BranchGraph';
import { RunStatePill } from '../components/runs/RunStatePill';
import { useShellActions } from '../components/shell/ShellActionsContext';
import { AssigneeAvatar } from '../components/tasks/AssigneeAvatar';
import { statusColor, StatusIcon } from '../components/tasks/StatusIcon';
import {
  VirtualRows,
  type VirtualRowsHandle,
} from '../components/virtual/VirtualRows';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { isTypingTarget } from '../hooks/useGlobalKeyboard';
import type { TaskTab } from '../lib/appNav';
import {
  type BranchLayout,
  branchLayout,
  type BranchPathSummary,
} from '../lib/branchLayout';
import {
  readCollapsedGroups,
  toggleCollapsedGroup,
  writeCollapsedGroups,
} from '../lib/collapsedEpics';
import { type DagTask, dagTaskFromDoc } from '../lib/dagLayout';
import { resolveListKeyCommand } from '../lib/keyboard';
import { groupTasks, type ListGroup } from '../lib/listGrouping';
import {
  isMilestoneFinished,
  rollupMilestoneStatus,
} from '../lib/milestoneRollup';
import {
  DEFAULT_TASKS_DISPLAY,
  type TasksDisplayPrefs,
} from '../lib/tasksPrefs';
import { cn } from '@/lib/utils';
import { GroupHeader } from '@/ui/ai/group-header';
import { EmptyState } from '@/ui/chrome';

/** The Branches page's folds. A stored milestone means "flipped from its default" (finished
 * ones start folded, the rest open), the Milestones page's convention under its own key so
 * the two pages fold independently. */
export const BRANCHES_TOGGLED_STORAGE_KEY = 'dispatch:branches-collapsed-v1';

interface MilestoneBranchesViewProps {
  data: DispatchProjectData;
  /** Opens a task; the same signature the Milestones layout takes so `BoardView` wires both
   * identically. */
  onOpenTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  /** The Display popover's model; the branches layout reads its row properties (the assignee
   * avatar) and sub-task visibility, and always groups by milestone. */
  display?: TasksDisplayPrefs;
  /** The Tasks page's shared filters, applied before layout — a filtered-out blocker is
   * simply not an edge. Omitted passes everything. */
  taskFilter?: (doc: TaskListItem) => boolean;
  onRequestFilter?: () => void;
  onRequestDisplay?: () => void;
  /** The empty state's `Plan work…`; omitted leaves only `New task`. */
  onPlanWork?: () => void;
}

/** One milestone ready to draw: its group (header tint, label, preset), the children as
 * layout nodes, the layout, its path summary and row order (the j/k sequence). */
interface MilestoneBranch {
  group: ListGroup;
  children: TaskListItem[];
  dagTasks: DagTask[];
  layout: BranchLayout;
  summary: BranchPathSummary;
  rowIds: string[];
  finished: boolean;
}

/** A virtual row: a milestone's header, or one band of its graph's lines. */
type BranchRowModel =
  | { kind: 'header'; key: string; branch: MilestoneBranch }
  | {
      kind: 'band';
      key: string;
      branch: MilestoneBranch;
      start: number;
      end: number;
    };

// A milestone's graph is cut into bands of this many lines, so a long one mounts only the
// bands on screen, plus one either side.
const BAND_LINES = 16;
const HEADER_HEIGHT = 36;
// The graph's padding above its first line and below its last.
const GRAPH_PAD = 4;

const bandKey = (groupKey: string, start: number) =>
  `band:${groupKey}:${start}`;
const branchRowKey = (row: BranchRowModel) => row.key;

function branchRowHeight(row: BranchRowModel): number {
  if (row.kind === 'header') return HEADER_HEIGHT;
  const pad =
    (row.start === 0 ? GRAPH_PAD : 0) +
    (row.end === row.branch.rowIds.length ? GRAPH_PAD : 0);
  return (row.end - row.start) * BRANCH_LINE_HEIGHT + pad;
}

/** The header's one-line reading of the path: how much of the trunk is still open and which
 * task to pick up next; `All landed` once nothing remains. */
export function pathSummaryLabel(summary: BranchPathSummary): string {
  if (summary.remaining === 0) return 'All landed';
  const remain = `${summary.remaining} of ${summary.total} on the path remain`;
  return summary.nextId === null
    ? remain
    : `${remain} · next ${summary.nextId}`;
}

/**
 * Branches: every milestone stacked as a status-tinted `GroupHeader` — the rolled-up status
 * glyph, the title and the path summary (`4 of 9 on the path remain · next t-xxxx`) — over a
 * `BranchGraph` of its children, the git-log gutter drawing the critical path on the trunk.
 * Tasks with no milestone have no path and are not shown; a finished milestone sinks to the
 * bottom and starts folded, the fold surviving a view switch in `sessionStorage`. `j`/`k`
 * walk the lines across milestones in drawn order, skipping folded ones; Enter/`o` open,
 * Space peeks, `f` and `⇧V` ask the page for its filter/display menus. Milestone = epic
 * here, as on the Milestones page.
 */
export function MilestoneBranchesView({
  data,
  onOpenTask,
  display,
  taskFilter,
  onRequestFilter,
  onRequestDisplay,
  onPlanWork,
}: MilestoneBranchesViewProps) {
  const shell = useShellActions();
  const prefs = useMemo<TasksDisplayPrefs>(
    () => ({ ...(display ?? DEFAULT_TASKS_DISPLAY), grouping: 'milestone' }),
    [display]
  );
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() =>
    readCollapsedGroups(BRANCHES_TOGGLED_STORAGE_KEY)
  );
  const listRef = useRef<HTMLDivElement | null>(null);
  // The scroller as state too: the virtual rows need it once it exists.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const setListEl = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    setScroller(node);
  }, []);
  const virtualRef = useRef<VirtualRowsHandle>(null);

  const filteredTasks = useMemo(
    () =>
      taskFilter === undefined ? data.tasks : data.tasks.filter(taskFilter),
    [data.tasks, taskFilter]
  );

  // Every milestone's children before the filter, keyed by epic id. The header's tint, glyph
  // and fold, and the finished-last order, read from these so a filter (say `Status is
  // landed`) narrows what is drawn without making every milestone look finished.
  const epicIds = useMemo(
    () => new Set(data.epics.map((e) => e.meta.id)),
    [data.epics]
  );
  const childrenByEpic = useMemo(() => {
    const map = new Map<string, TaskListItem[]>();
    for (const doc of data.tasks) {
      const parent = doc.meta.parent;
      if (
        isContainerKind(doc.meta.kind) ||
        parent === null ||
        !epicIds.has(parent)
      ) {
        continue;
      }
      const list = map.get(parent);
      if (list === undefined) map.set(parent, [doc]);
      else list.push(doc);
    }
    return map;
  }, [data.tasks, epicIds]);
  // Decides between "nothing to plan yet" and "the filter matched nothing".
  const anyMilestoneHasTasks = childrenByEpic.size > 0;

  // `groupTasks` by milestone gives the epics in project order, their labels and the `+`
  // preset; its tint, glyph and finished-last sink read the filtered rows, so those are
  // redone here from the unfiltered children. A bucket for a parent that is not an epic (a
  // sub-task's task) is no milestone and is dropped. The layout orders the rows itself, so
  // the group's own row order is only the input.
  const model = useMemo(() => statusModelOf(data.config), [data.config]);
  const branches = useMemo<MilestoneBranch[]>(() => {
    const open: MilestoneBranch[] = [];
    const finished: MilestoneBranch[] = [];
    const groups = groupTasks(
      filteredTasks,
      { ...prefs, showEmptyGroups: false },
      { statuses: data.config?.statuses ?? [], epics: data.epics }
    );
    for (const group of groups) {
      const all =
        group.epicId === null ? undefined : childrenByEpic.get(group.epicId);
      if (all === undefined) continue;
      const rollup = rollupMilestoneStatus(all, model);
      // The path runs through the container's own children; a sub-issue travels with its
      // parent issue, and stands in for it only when the filter hid that issue.
      const docs = group.rows.map((r) => r.doc);
      const inGroup = new Set(docs.map((doc) => doc.meta.id));
      const children = docs.filter(
        (doc) =>
          doc.meta.parent === group.epicId ||
          doc.meta.parent === null ||
          !inGroup.has(doc.meta.parent)
      );
      const dagTasks = children.map(dagTaskFromDoc);
      const layout = branchLayout(dagTasks, model);
      const branch: MilestoneBranch = {
        group: {
          ...group,
          tint: statusColor(rollup, model),
          icon: { kind: 'milestone', status: rollup },
        },
        children,
        dagTasks,
        layout,
        summary: layout.pathSummary,
        rowIds: layout.rows.map((r) => r.id),
        finished: isMilestoneFinished(all, model),
      };
      (branch.finished ? finished : open).push(branch);
    }
    return [...open, ...finished];
  }, [filteredTasks, prefs, data.config, data.epics, childrenByEpic, model]);

  // A finished milestone's default is folded, so its key in `toggled` means "opened".
  const collapsed = useMemo(() => {
    const set = new Set<string>();
    for (const b of branches) {
      if (b.finished !== toggled.has(b.group.key)) set.add(b.group.key);
    }
    return set;
  }, [branches, toggled]);

  const orderedIds = useMemo(
    () => branches.flatMap((b) => (collapsed.has(b.group.key) ? [] : b.rowIds)),
    [branches, collapsed]
  );

  // The virtual rows: each milestone's header, then its graph in bands of lines.
  const rows = useMemo<BranchRowModel[]>(() => {
    const out: BranchRowModel[] = [];
    for (const branch of branches) {
      const key = branch.group.key;
      out.push({ kind: 'header', key: `header:${key}`, branch });
      if (collapsed.has(key)) continue;
      const count = branch.rowIds.length;
      for (let start = 0; start < count; start += BAND_LINES) {
        const end = Math.min(count, start + BAND_LINES);
        out.push({
          kind: 'band',
          key: bandKey(key, start),
          branch,
          start,
          end,
        });
      }
    }
    return out;
  }, [branches, collapsed]);
  // Each drawn task's band, for scrolling the cursor into view.
  const bandOfTask = useMemo(() => {
    const map = new Map<string, string>();
    for (const branch of branches) {
      if (collapsed.has(branch.group.key)) continue;
      branch.rowIds.forEach((id, index) => {
        map.set(id, bandKey(branch.group.key, index - (index % BAND_LINES)));
      });
    }
    return map;
  }, [branches, collapsed]);

  useEffect(() => {
    if (orderedIds.length === 0) {
      setFocusedTaskId(null);
    } else if (focusedTaskId === null || !orderedIds.includes(focusedTaskId)) {
      setFocusedTaskId(orderedIds[0] ?? null);
    }
  }, [orderedIds, focusedTaskId]);

  const showList = branches.length > 0;

  // The grid takes focus once it is on screen so j/k work without a click first.
  useEffect(() => {
    if (showList) listRef.current?.focus();
  }, [showList]);

  function toggle(key: string) {
    setToggled((prev) => {
      const next = toggleCollapsedGroup(prev, key);
      writeCollapsedGroups(BRANCHES_TOGGLED_STORAGE_KEY, next);
      return next;
    });
  }

  // Only a keyboard move scrolls — the cursor never follows the pointer here. A line whose
  // band is not mounted has the band brought in first, then the line once it draws. Focus
  // on a control (a tabbed-to line, a header's button) returns to the grid: that control's
  // band unmounts once the cursor is a few bands away, and focus would drop to the body.
  function moveCursor(id: string | null) {
    const list = listRef.current;
    const active = document.activeElement;
    if (list !== null && active !== list && list.contains(active)) {
      list.focus({ preventScroll: true });
    }
    setFocusedTaskId(id);
    if (id === null) return;
    const lineOf = () =>
      listRef.current?.querySelector(`[data-task-id="${id}"]`) ?? null;
    const line = lineOf();
    if (line !== null) {
      line.scrollIntoView({ block: 'nearest' });
      return;
    }
    const band = bandOfTask.get(id);
    if (band !== undefined) virtualRef.current?.scrollToKey(band);
    requestAnimationFrame(() => lineOf()?.scrollIntoView({ block: 'nearest' }));
  }

  // Tab landing on a line's button moves the cursor there, so the mark and the focus ring
  // never point at two different lines.
  function handleFocus(e: FocusEvent<HTMLDivElement>) {
    const id = (e.target as HTMLElement).closest<HTMLElement>(
      '[data-slot="branch-line"]'
    )?.dataset['taskId'];
    if (id !== undefined) setFocusedTaskId(id);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Enter or Space on one of the view's own controls — a header's chevron or `+`, a line's
    // button — activates that control, not the focused line.
    const controlEl = (e.target as HTMLElement).closest(
      'button, a, select, input, textarea, [contenteditable="true"]'
    );
    const onControl =
      controlEl !== null &&
      controlEl !== e.currentTarget &&
      (e.key === 'Enter' || e.key === ' ');
    const command = resolveListKeyCommand(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
      { isTyping: isTypingTarget(e.target) }
    );
    if (command === null) return;
    if (command === 'list-open-filter') {
      e.preventDefault();
      onRequestFilter?.();
      return;
    }
    if (command === 'list-open-display') {
      e.preventDefault();
      onRequestDisplay?.();
      return;
    }
    if (orderedIds.length === 0) return;
    if (command === 'list-down' || command === 'list-up') {
      e.preventDefault();
      const currentIndex =
        focusedTaskId !== null ? orderedIds.indexOf(focusedTaskId) : -1;
      const nextIndex =
        command === 'list-down'
          ? Math.min(currentIndex + 1, orderedIds.length - 1)
          : Math.max(currentIndex - 1, 0);
      moveCursor(orderedIds[Math.max(nextIndex, 0)] ?? null);
      return;
    }
    if (onControl || focusedTaskId === null) return;
    if (command === 'list-confirm' || command === 'list-open') {
      e.preventDefault();
      onOpenTask(focusedTaskId);
      return;
    }
    if (command === 'list-peek') {
      e.preventDefault();
      shell.peekTask(focusedTaskId);
    }
  }

  // The trailing slot: a live run's mark first, else the assignee avatar when the Display
  // popover shows assignees.
  function accessoryFor(id: string, doc: TaskListItem): ReactNode {
    const run = data.latestRunByTaskId.get(id);
    if (run !== undefined && data.liveRunStateByTaskId.has(id)) {
      return <RunStatePill meta={run} compact />;
    }
    if (prefs.properties.has('assignee')) {
      return <AssigneeAvatar assignee={doc.meta.assignee} size={16} />;
    }
    return undefined;
  }

  if (!showList) {
    if (anyMilestoneHasTasks) {
      return (
        <EmptyState
          icon={SearchX}
          heading="No tasks match"
          description="Nothing passes the current filter. Clear it to see each milestone's path."
          className="h-full"
        />
      );
    }
    return (
      <EmptyState
        icon={GitBranch}
        heading="No milestones with tasks yet"
        description="A milestone's branch is the path through its tasks. Put tasks under one to draw it."
        primary={{
          label: 'New task',
          hint: 'C',
          onClick: () => shell.openCreateTask(),
        }}
        secondary={
          onPlanWork !== undefined
            ? { label: 'Plan work…', onClick: onPlanWork }
            : undefined
        }
        className="h-full"
      />
    );
  }

  const focusedBand =
    focusedTaskId === null ? undefined : bandOfTask.get(focusedTaskId);
  const renderRow = (row: BranchRowModel) => {
    const { branch } = row;
    const { group } = branch;
    if (row.kind === 'header') {
      const isCollapsed = collapsed.has(group.key);
      return (
        <div
          data-slot="milestone-branch"
          data-group-key={group.key}
          data-finished={branch.finished || undefined}
        >
          <GroupHeader
            tint={group.tint ?? undefined}
            icon={
              group.icon?.kind === 'milestone' ? (
                <StatusIcon status={group.icon.status} />
              ) : undefined
            }
            name={group.label}
            collapsed={isCollapsed}
            onToggle={() => toggle(group.key)}
            onAdd={() => shell.openCreateTask(group.preset)}
            addLabel={`New task in ${group.label}`}
            actions={
              <span
                data-slot="branch-path-summary"
                className="font-book mr-1 text-[12px] text-(--text-muted) tabular-nums"
              >
                {pathSummaryLabel(branch.summary)}
              </span>
            }
          />
        </div>
      );
    }
    const docById = new Map(branch.children.map((t) => [t.meta.id, t]));
    return (
      <div
        className={cn(
          row.start === 0 && 'pt-1',
          row.end === branch.rowIds.length && 'pb-1'
        )}
      >
        <BranchGraph
          tasks={branch.dagTasks}
          layout={branch.layout}
          band={{ start: row.start, end: row.end }}
          model={model}
          ariaLabel={`${group.label} branches`}
          focusedId={focusedTaskId}
          accessoryFor={(id) => {
            const doc = docById.get(id);
            return doc === undefined ? undefined : accessoryFor(id, doc);
          }}
          onOpenNode={(id) => onOpenTask(id)}
        />
      </div>
    );
  };

  return (
    <div
      ref={setListEl}
      tabIndex={0}
      role="grid"
      aria-label="Branches"
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
      className="flex h-full min-h-0 flex-col overflow-y-auto px-2 pb-2 outline-none"
    >
      <VirtualRows
        rows={rows}
        rowKey={branchRowKey}
        estimateSize={branchRowHeight}
        overscan={1}
        scrollElement={scroller}
        pinnedKeys={focusedBand === undefined ? undefined : [focusedBand]}
        handleRef={virtualRef}
        renderRow={renderRow}
      />
    </div>
  );
}
