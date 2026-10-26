import type { TaskListItem, UpdatePatch } from '@dispatch-foo/core/browser';
import { isDoneStatus } from '@dispatch-foo/core/browser';
import {
  BulkBar,
  type TaskColumnId,
  type TaskGroupData,
  TaskGroupTable,
  type TaskRowData,
  type TaskSectionData,
  useBulkBarHeight,
  useOptionalCommandPalette,
} from '@dispatch/ui';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { COLUMN_LABELS, columnsForPrefs } from '../adapters/columns';
import {
  dropTargetFor,
  dropVerdict,
  type RowContext,
  rowIdsInOrder,
  toTaskSections,
} from '../adapters/rows';
import { usePeople } from '../components/people/PeopleContext';
import { useDeepLinkActions } from '../components/shell/DeepLinkContext';
import { useShellActions } from '../components/shell/ShellActionsContext';
import { DispatchDialog } from '../components/tasks/DispatchDialog';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { liveClaimsFrom } from '../lib/dispatchPreview';
import type { WorkEpicOptions } from '../lib/epicSession';
import { fanoutVerbs } from '../lib/fanoutVerbs';
import { filterBySearch } from '../lib/issueSearch';
import { resolveListKeyCommand } from '../lib/keyboard';
import { landingStateByTaskId } from '../lib/landingBadge';
import { resolveLinearLink } from '../lib/linearSettings';
import { groupTasks, type ListGroup } from '../lib/listGrouping';
import type { NeedsYou } from '../lib/needsYou';
import { taskHref } from '../lib/shellRoutes';
import { useStatusModelOf } from '../lib/statusModel';
import type { TasksDisplayPrefs } from '../lib/tasksPrefs';
import type { TaskBucket } from '../lib/taskStatus';
import styles from './IssuesView.module.css';
import {
  assigneeChoices,
  BulkActions,
  type BulkChange,
  bulkChangeLabel,
  type GroupAction,
  GroupMenu,
  IssueCell,
  milestoneChoices,
  type PickerContext,
  pickerForColumn,
  type RowAction,
  type RowMenuInput,
  RowMenuSlot,
  type RowPickerKind,
  rowTitleElement,
  stateChoices,
  useControlStore,
  useEventCallback,
} from './IssuesViewMenus';

// The Issues list proper: @dispatch/ui's TaskGroupTable over the grouped
// tasks (lib/listGrouping, through the pure adapters in adapters/rows and
// adapters/columns), with Dispatch's own things on top: the cell pickers and
// the row menu (IssuesViewMenus), multi-select with the bulk bar, drag between
// status and container groups, the single-key commands (s / p / a / m open a
// picker, d dispatches, Space quick-looks, ⌘C copies the id, f and ⇧V ask the
// hub for its menus) and the fan-out verbs on container headers.

const NO_SELECTION: ReadonlySet<string> = new Set();

/** From this many selected rows a bulk change asks first. */
const BULK_CONFIRM_AT = 20;

/** The columns that give way first when the list is narrow; the status (the
 * reason for most of the groups) never does. */
// Dropped in this order as the table narrows: the container columns first
// (the group header already names them), then the priority glyph, then the
// assignee; the due date stays longest because its overdue tone is what a
// narrow list must still show. At a 1280px window with the sidebar open two
// columns go.
const DROP_COLUMNS: readonly TaskColumnId[] = [
  'project',
  'milestone',
  'priority',
  'assignee',
  'due',
];

/** The group ids folded on first use: finished statuses and the archive. */
function defaultCollapsedGroups(
  groups: readonly ListGroup[],
  isDone: (status: string) => boolean
): string[] {
  const keys: string[] = [];
  for (const group of groups) {
    if (group.archived) keys.push(group.key);
    else if (
      group.kind === 'status' &&
      group.icon?.kind === 'status' &&
      isDone(group.icon.status)
    ) {
      keys.push(group.key);
    }
  }
  return keys;
}

/** The dialog over the list: Send agents at a set of tasks, or at a
 * container's children (the group menu's Send agents…). */
type Dialog =
  | { kind: 'tasks'; ids: readonly string[] }
  | { kind: 'epic'; epicId: string };

const BULK_BAR_OFFSET_PX = 20;
const BULK_BAR_LINE_PX = 44;
const BULK_BAR_GAP_PX = 24;

/** Room after the rows while the bulk bar floats over the end of the list,
 * so the last rows still scroll above it (the bar's offset, its measured
 * height, a gap). Its own component, so the height arriving redraws this
 * alone. */
function BulkBarRoom({ shown }: { shown: boolean }): ReactNode {
  const height = useBulkBarHeight();
  if (!shown) return null;
  return (
    <div
      aria-hidden="true"
      data-bulk-bar-room=""
      style={{
        height:
          BULK_BAR_OFFSET_PX + (height ?? BULK_BAR_LINE_PX) + BULK_BAR_GAP_PX,
      }}
    />
  );
}

export interface IssuesTableProps {
  data: DispatchProjectData;
  /** The preset and the filter clauses as one predicate; omitted passes
   * everything. */
  taskFilter?: (doc: TaskListItem) => boolean;
  /** The toolbar's search text, matched on the client before grouping. */
  search: string;
  /** The Display popover's model: grouping, ordering, which properties show. */
  prefs: TasksDisplayPrefs;
  needs: NeedsYou;
  bucketOf: (doc: TaskListItem) => TaskBucket | null;
  /** Unread messages to me per task, for the row's unread chip. */
  speechByTask?: ReadonlyMap<string, { count: number; mention: boolean }>;
  /** The task in the quick-look drawer (the accent row). */
  activeTaskId?: string;
  /** A click on a row: the quick-look drawer (Space goes through the shell's
   * peek verb, the same drawer). */
  onSelectTask: (taskId: string) => void;
  /** Enter, `o` and the row menu's Open: the full page. */
  onOpenTask: (taskId: string) => void;
  /** `f` on a row: the hub opens its Filter menu. */
  onRequestFilter: () => void;
  /** `⇧V` on a row: the hub opens its Display popover. */
  onRequestDisplay: () => void;
  /** Groups that are not task groups (notes, pull requests, docs), after the
   * rows. */
  footer?: ReactNode;
}

/**
 * The grouped issue table and everything that acts on its rows. The grouping,
 * ordering and properties come from `prefs` (`groupTasks`, the model the board
 * reads too); the rows carry Dispatch's overlay chips; a right-click or the
 * "…" opens the row menu; `x`, the checkboxes and shift ranges select, and the
 * bulk bar acts on the selection (asking first from BULK_CONFIRM_AT rows); a
 * drag drops rows on a status or container group. A request-tier window reads
 * only: plain cells, no selection, no drag, a menu of opens and copies. The
 * caller owns the toolbar, the tabs and the chips above.
 */
export function IssuesTable({
  data,
  taskFilter,
  search,
  prefs,
  needs,
  bucketOf,
  speechByTask,
  activeTaskId,
  onSelectTask,
  onOpenTask,
  onRequestFilter,
  onRequestDisplay,
  footer,
}: IssuesTableProps) {
  const shell = useShellActions();
  // `null` outside App's provider (the harness, view tests): no Copy link then.
  const deepLink = useDeepLinkActions();
  const directory = usePeople();
  const model = useStatusModelOf(data.config);
  const palette = useOptionalCommandPalette();
  const editable = data.myTier !== 'request';
  const controls = useControlStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  // The list's own scroll column (the view scrolls inside AppShell's main,
  // which does not), for the table's row windowing; stable, as the table
  // reads it when windowing starts.
  const scrollParentOf = useCallback(() => scrollRef.current, []);

  const [selected, setSelected] = useState<ReadonlySet<string>>(NO_SELECTION);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<BulkChange | null>(null);
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  // Tasks whose `d` is in flight, and why a task's last change did not save.
  const [pendingDispatch, setPendingDispatch] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [saveErrors, setSaveErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );

  // ---- the rows -----------------------------------------------------------

  const linearLinks = data.linearLinks;
  const keyOf = useCallback(
    (doc: TaskListItem) =>
      resolveLinearLink(doc.meta.external, linearLinks)?.identifier,
    [linearLinks]
  );
  const passes = useCallback(
    (doc: TaskListItem) => taskFilter?.(doc) ?? true,
    [taskFilter]
  );
  const visibleTasks = useMemo(
    () => filterBySearch(data.tasks.filter(passes), search, keyOf),
    [data.tasks, passes, search, keyOf]
  );
  const visibleArchived = useMemo(
    () =>
      data.showArchived
        ? filterBySearch(data.archivedTasks.filter(passes), search, keyOf)
        : undefined,
    [data.showArchived, data.archivedTasks, passes, search, keyOf]
  );
  const groups = useMemo<ListGroup[]>(() => {
    if (data.config === null) return [];
    return groupTasks(visibleTasks, prefs, {
      statuses: data.config.statuses,
      epics: data.epics,
      archivedTasks: visibleArchived,
      model,
    });
  }, [data.config, data.epics, visibleTasks, visibleArchived, prefs, model]);
  const groupByKey = useMemo(
    () => new Map(groups.map((group) => [group.key, group])),
    [groups]
  );

  // Every task the window knows, by id: the hierarchy walk, the pickers'
  // current values and the drop rules read it.
  const tasksById = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const doc of data.tasks) map.set(doc.meta.id, doc);
    for (const doc of data.archivedTasks) map.set(doc.meta.id, doc);
    return map;
  }, [data.tasks, data.archivedTasks]);
  const childCountByParent = useMemo(() => {
    const map = new Map<string, number>();
    for (const doc of data.tasks) {
      if (doc.meta.parent === null) continue;
      map.set(doc.meta.parent, (map.get(doc.meta.parent) ?? 0) + 1);
    }
    return map;
  }, [data.tasks]);
  const landingByTaskId = useMemo(
    () => landingStateByTaskId(data.mergeQueue),
    [data.mergeQueue]
  );
  const unreadByTaskId = useMemo(() => {
    if (speechByTask === undefined) return undefined;
    const map = new Map<string, number>();
    for (const [id, speech] of speechByTask) {
      if (speech.count > 0) map.set(id, speech.count);
    }
    return map;
  }, [speechByTask]);
  // Dates are read against the clock as of the last task refresh (the one
  // dependency is the refresh itself).
  const now = useMemo(() => {
    void data.tasks;
    return new Date();
  }, [data.tasks]);
  const ctx = useMemo<RowContext>(
    () => ({
      model,
      tasksById,
      personFor: directory.personFor,
      bucketOf,
      linearLinks,
      liveRunStateByTaskId: data.liveRunStateByTaskId,
      landingByTaskId,
      epicProgressById: data.epicProgressById,
      asksByTaskId: needs.byTask,
      unreadByTaskId,
      pendingDispatch,
      saveErrorByTaskId: saveErrors,
      childCountByParent,
      now,
      hrefFor: taskHref,
    }),
    [
      model,
      tasksById,
      directory.personFor,
      bucketOf,
      linearLinks,
      data.liveRunStateByTaskId,
      landingByTaskId,
      data.epicProgressById,
      needs.byTask,
      unreadByTaskId,
      pendingDispatch,
      saveErrors,
      childCountByParent,
      now,
    ]
  );
  const columns = useMemo(() => columnsForPrefs(prefs), [prefs]);
  // The "+" on every live group header pre-fills the creator with the group's
  // status or container, as the old header's did.
  const sections = useMemo<TaskSectionData[]>(() => {
    const built = toTaskSections(groups, ctx, { columns });
    for (const section of built) {
      for (const group of section.groups) {
        const source = groupByKey.get(group.id);
        if (source === undefined || source.archived) continue;
        group.addLabel = `New task in ${group.title}`;
        group.onAdd = () => shell.openCreateTask(source.preset);
      }
    }
    return built;
  }, [groups, ctx, columns, groupByKey, shell]);
  const defaultCollapsed = useMemo(
    () =>
      defaultCollapsedGroups(groups, (status) => isDoneStatus(status, model)),
    [groups, model]
  );

  // The latest render's facts, for the stable slots and callbacks below (a
  // row that skipped a redraw still acts on current data).
  const latest = useRef({ tasksById, groupByKey, sections, selected, data });
  latest.current = { tasksById, groupByKey, sections, selected, data };

  // ---- writes -------------------------------------------------------------

  // Every change goes through here, so a failure prints "Not saved · why" on
  // the row (and still rejects, so a picker shows it too) and a success clears
  // the last one.
  const noteResult = useEventCallback(
    async (id: string, work: Promise<void>): Promise<void> => {
      try {
        await work;
        setSaveErrors((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'The daemon refused the change.';
        setSaveErrors((prev) => new Map(prev).set(id, message));
        throw err;
      }
    }
  );
  const update = useEventCallback((id: string, patch: UpdatePatch) =>
    noteResult(id, latest.current.data.handleUpdate(id, patch))
  );
  const moveStatus = useEventCallback((id: string, status: string) =>
    noteResult(id, latest.current.data.moveTaskStatus(id, status))
  );

  // In place and optimistic, like the Cockpit's `d`: the row reads
  // "Dispatching…" at once; when the regroup unmounts the focused row, the row
  // that took its place gets the focus, so `d` `d` `d` walks down a group.
  const handoff = useRef<number | null>(null);
  const dispatchOne = useEventCallback((taskId: string) => {
    const current = latest.current;
    if (!current.data.readyIds.has(taskId)) return;
    const active = document.activeElement;
    if (active !== null && rowTitleElement(taskId)?.contains(active) === true) {
      handoff.current = rowIdsInOrder(current.sections).indexOf(taskId);
    }
    setPendingDispatch((prev) => new Set(prev).add(taskId));
    void current.data
      .handleDispatch(taskId, undefined, undefined, { optimistic: true })
      .catch(() => {
        // The window's own dispatch path toasts the failure.
      })
      .finally(() => {
        setPendingDispatch((prev) => {
          if (!prev.has(taskId)) return prev;
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      });
  });
  useEffect(() => {
    const index = handoff.current;
    if (index === null) return;
    handoff.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const ids = rowIdsInOrder(sections);
    const next = ids[Math.min(index, ids.length - 1)];
    if (next !== undefined) rowTitleElement(next)?.focus();
  }, [sections]);

  // The list takes focus on mount, so the keys work without a click first.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(
        '[data-nav-item="row"] [data-nav-target] > a, [data-nav-item="row"] [data-nav-target] > button'
      )
      ?.focus();
  }, []);

  // ---- the pickers' choices -----------------------------------------------

  const people = useMemo(
    () =>
      assigneeChoices({
        people: data.people,
        executors: data.executors?.executors ?? [],
        me: data.me,
      }),
    [data.people, data.executors, data.me]
  );
  const statuses = data.config?.statuses;
  const states = useMemo(
    () => stateChoices(statuses, model),
    [statuses, model]
  );
  const milestones = useMemo(() => milestoneChoices(data.epics), [data.epics]);
  const pickerCtx = useMemo<PickerContext>(
    () => ({
      states,
      people,
      meId: data.me,
      milestones,
      onUpdate: update,
      onMoveStatus: moveStatus,
    }),
    [states, people, data.me, milestones, update, moveStatus]
  );

  // ---- the slots ----------------------------------------------------------

  const archivedGroup = useCallback(
    (group: TaskGroupData) =>
      latest.current.groupByKey.get(group.id)?.archived === true,
    []
  );

  // Stable while what they draw is (TaskGroupTable redraws every row when a
  // slot changes identity); the task is read at render time, so a row that
  // redraws for its own data sees the current task.
  const renderCell = useCallback(
    (column: TaskColumnId, row: TaskRowData, group: TaskGroupData) => {
      if (!editable || archivedGroup(group)) return undefined;
      const kind = pickerForColumn(column);
      if (kind === undefined) return undefined;
      const doc = latest.current.tasksById.get(row.id);
      if (doc === undefined) return undefined;
      return (
        <IssueCell
          kind={kind}
          row={row}
          doc={doc}
          store={controls}
          ctx={pickerCtx}
        />
      );
    },
    [editable, archivedGroup, controls, pickerCtx]
  );

  const onRowAction = useEventCallback(
    (action: RowAction, row: TaskRowData) => {
      const id = row.id;
      const current = latest.current;
      switch (action) {
        case 'open':
          onOpenTask(id);
          return;
        case 'peek':
          shell.peekTask(id);
          return;
        case 'dispatch':
          setDialog({
            kind: 'tasks',
            ids:
              current.selected.has(id) && current.selected.size > 1
                ? [...current.selected]
                : [id],
          });
          return;
        case 'copy-id':
          shell.copyTaskId(id);
          return;
        case 'copy-link':
          deepLink?.copyTaskLink(id);
          return;
        case 'archive':
          void update(id, { archivedAt: new Date().toISOString() }).catch(
            () => {}
          );
          return;
        case 'drop':
          void moveStatus(id, model.roles.dropped).catch(() => {});
      }
    }
  );
  const canCopyLink = deepLink !== null;
  const menuFor = useEventCallback(
    (row: TaskRowData, group: TaskGroupData): RowMenuInput => ({
      editable: editable && !archivedGroup(group),
      ready: latest.current.data.readyIds.has(row.id),
      canCopyLink,
    })
  );
  const rowActions = useCallback(
    (row: TaskRowData, group: TaskGroupData) => {
      const doc = latest.current.tasksById.get(row.id);
      if (doc === undefined) return null;
      return (
        <RowMenuSlot
          row={row}
          doc={doc}
          store={controls}
          ctx={pickerCtx}
          menu={menuFor(row, group)}
          onAction={onRowAction}
        />
      );
    },
    [controls, pickerCtx, menuFor, onRowAction]
  );

  const onGroupAction = useEventCallback(
    (action: GroupAction, group: TaskGroupData) => {
      const source = latest.current.groupByKey.get(group.id);
      if (source === undefined) return;
      const epicId = source.epicId;
      switch (action) {
        case 'new-task':
          shell.openCreateTask(source.preset);
          return;
        case 'open-plan':
          if (epicId !== null) shell.openTask(epicId, 'plan');
          return;
        case 'send':
          if (epicId !== null) setDialog({ kind: 'epic', epicId });
          return;
        case 'pause':
          if (epicId !== null) void data.handlePauseEpic(epicId);
          return;
        case 'resume':
          if (epicId !== null) void data.handleResumeEpic(epicId);
          return;
        case 'stop':
          if (epicId !== null) void data.handleStopEpic(epicId);
          return;
        case 'land':
          if (epicId !== null) void data.handleLandEpic(epicId);
      }
    }
  );
  const epicProgressById = data.epicProgressById;
  const groupActions = useCallback(
    (group: TaskGroupData) => {
      const source = groupByKey.get(group.id);
      if (source === undefined || source.archived) return null;
      const container =
        source.epicId === null ? undefined : tasksById.get(source.epicId);
      const verbs =
        container !== undefined && editable
          ? fanoutVerbs(
              container,
              model,
              epicProgressById.get(container.meta.id),
              childCountByParent.get(container.meta.id) ?? 0
            )
          : [];
      return (
        <GroupMenu
          group={group}
          verbs={verbs}
          container={container !== undefined}
          onAction={onGroupAction}
        />
      );
    },
    [
      groupByKey,
      tasksById,
      editable,
      model,
      epicProgressById,
      childCountByParent,
      onGroupAction,
    ]
  );

  // ---- selection and the bulk bar -----------------------------------------

  const selectedTasks = useMemo(
    () => data.tasks.filter((t) => selected.has(t.meta.id)),
    [data.tasks, selected]
  );
  const selectedReady = useMemo(
    () => selectedTasks.filter((t) => data.readyIds.has(t.meta.id)),
    [selectedTasks, data.readyIds]
  );

  // Puts focus back in the list once the bar goes (its own buttons unmount
  // with it): the open row, else the first row.
  const clearSelection = useEventCallback(() => {
    setSelected(NO_SELECTION);
    setBulkConfirm(null);
    const first = rowIdsInOrder(latest.current.sections)[0];
    const target =
      (activeTaskId !== undefined ? rowTitleElement(activeTaskId) : null) ??
      (first !== undefined ? rowTitleElement(first) : null);
    target?.focus();
  });

  async function runBulk(change: BulkChange) {
    const ids = [...selected];
    setBulkConfirm(null);
    setBulkBusy(
      `${change.kind === 'archive' ? 'Archiving' : 'Updating'} ${ids.length} ${
        ids.length === 1 ? 'issue' : 'issues'
      }…`
    );
    try {
      for (const id of ids) {
        try {
          switch (change.kind) {
            case 'status':
              await moveStatus(id, change.status);
              break;
            case 'priority':
              await update(id, { priority: change.priority });
              break;
            case 'assignee':
              await update(id, { assignee: change.assignee });
              break;
            case 'archive':
              await update(id, { archivedAt: new Date().toISOString() });
              break;
          }
        } catch {
          // Noted on the row by noteResult; the rest of the batch goes on.
        }
      }
    } finally {
      setBulkBusy(null);
      setSelected(NO_SELECTION);
    }
  }

  // A change to a large selection asks first.
  function onBulkChange(change: BulkChange) {
    if (selected.size >= BULK_CONFIRM_AT) setBulkConfirm(change);
    else void runBulk(change);
  }

  // ---- the row's keys -----------------------------------------------------

  // What the table leaves to the host: Enter / o open the page, Space quick-looks,
  // s / p / a / m open the matching picker (the cell's when its column is
  // shown, else in the "…" slot), d dispatches, ⌘C copies the id, f and ⇧V ask
  // the hub for its menus, Escape clears the selection. A pending G chord
  // belongs to the shell (it prevents the key first).
  function onRowKeyDown(
    event: KeyboardEvent<HTMLElement>,
    row: TaskRowData,
    group: TaskGroupData
  ) {
    if (event.defaultPrevented) return;
    if (palette?.isSequencePending() === true) return;
    const id = row.id;
    if ((event.metaKey || event.ctrlKey) && event.key === 'c') {
      // A text selection keeps the native copy; only a bare ⌘C takes the id.
      if ((window.getSelection()?.toString() ?? '') === '') {
        event.preventDefault();
        shell.copyTaskId(id);
      }
      return;
    }
    const command = resolveListKeyCommand(
      { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
      { isTyping: false }
    );
    if (command === null) return;
    const openPicker = (kind: RowPickerKind) => {
      if (!editable || archivedGroup(group)) return;
      event.preventDefault();
      controls.set({
        rowId: id,
        kind,
        slot: columns.includes(kind) ? 'cell' : 'menu',
        point: null,
        fromKey: true,
      });
    };
    switch (command) {
      case 'list-confirm':
      case 'list-open':
        // Prevented, so the table does not also activate the row's link
        // (its click path, the quick look).
        event.preventDefault();
        onOpenTask(id);
        return;
      case 'list-peek':
        event.preventDefault();
        shell.peekTask(id);
        return;
      case 'list-set-status':
        openPicker('state');
        return;
      case 'list-set-priority':
        openPicker('priority');
        return;
      case 'list-set-assignee':
        openPicker('assignee');
        return;
      case 'list-set-epic':
      case 'list-set-milestone':
        openPicker('milestone');
        return;
      case 'list-dispatch':
        if (!editable) return;
        event.preventDefault();
        dispatchOne(id);
        return;
      case 'list-open-filter':
        event.preventDefault();
        onRequestFilter();
        return;
      case 'list-open-display':
        event.preventDefault();
        onRequestDisplay();
        return;
      case 'list-escape':
        if (selected.size === 0) return;
        event.preventDefault();
        clearSelection();
        return;
      default:
        // j/k, x and labels are the table's or nobody's.
        return;
    }
  }

  function onRowContextMenu(event: MouseEvent<HTMLElement>, row: TaskRowData) {
    event.preventDefault();
    controls.set({
      rowId: row.id,
      kind: 'menu',
      slot: 'menu',
      point: { x: event.clientX, y: event.clientY },
      fromKey: false,
    });
  }

  // ---- drag ---------------------------------------------------------------

  const drag = useMemo(
    () =>
      editable
        ? {
            canDrop: (rowIds: readonly string[], groupId: string) =>
              dropVerdict(rowIds, groupId, latest.current.tasksById),
            onDrop: (rowIds: readonly string[], groupId: string) => {
              const target = dropTargetFor(groupId);
              if (target === null) return;
              for (const id of rowIds) {
                const work =
                  target.kind === 'status'
                    ? moveStatus(id, target.status)
                    : update(id, { parent: target.parentId });
                void work.catch(() => {});
              }
            },
            label: (n: number) => (n === 1 ? '1 issue' : `${n} issues`),
          }
        : undefined,
    [editable, moveStatus, update]
  );

  // ---- render -------------------------------------------------------------

  const emptyMessage =
    data.tasks.length === 0 && data.epics.length === 0
      ? 'No tasks yet'
      : 'No tasks match';
  const dialogTasks =
    dialog === null
      ? []
      : dialog.kind === 'tasks'
        ? dialog.ids
            .map((id) => tasksById.get(id))
            .filter((doc): doc is TaskListItem => doc !== undefined)
        : data.tasks.filter((t) => t.meta.parent === dialog.epicId);
  const dialogTitle =
    dialog === null
      ? ''
      : dialog.kind === 'tasks'
        ? `Send agents at ${dialogTasks.length} selected ${
            dialogTasks.length === 1 ? 'task' : 'tasks'
          }`
        : `Send agents · ${tasksById.get(dialog.epicId)?.meta.title ?? dialog.epicId}`;

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      data-testid="issues-table"
      data-read-only={editable ? undefined : 'true'}
    >
      <TaskGroupTable
        sections={sections}
        scrollParent={scrollParentOf}
        columns={columns}
        columnLabels={COLUMN_LABELS}
        dropColumns={DROP_COLUMNS}
        label="Tasks"
        headingLevel={2}
        storageKey="dispatch:issues-collapsed"
        storage="session"
        defaultCollapsed={defaultCollapsed}
        emptyMessage={emptyMessage}
        onOpenRow={(row) => onSelectTask(row.id)}
        activeRowId={activeTaskId}
        onRowKeyDown={onRowKeyDown}
        selection={
          editable
            ? { selected, onChange: setSelected, hideOnTouch: true }
            : undefined
        }
        renderCell={renderCell}
        rowActions={rowActions}
        onRowContextMenu={onRowContextMenu}
        groupActions={groupActions}
        drag={drag}
      />
      {footer}
      <BulkBarRoom shown={editable && selected.size > 0} />
      {editable ? (
        <BulkBar
          count={selected.size}
          busy={bulkBusy}
          confirm={
            bulkConfirm === null
              ? null
              : {
                  message: `${bulkChangeLabel(bulkConfirm)} on ${selected.size} issues?`,
                  confirmLabel: `${bulkChangeLabel(bulkConfirm)} · ${selected.size}`,
                  onConfirm: () => void runBulk(bulkConfirm),
                  onCancel: () => setBulkConfirm(null),
                }
          }
          onClear={clearSelection}
        >
          <BulkActions
            ready={selectedReady.length}
            states={states}
            people={people}
            onDispatch={() => setDialog({ kind: 'tasks', ids: [...selected] })}
            onChange={onBulkChange}
          />
        </BulkBar>
      ) : null}
      {dialog !== null && (
        <DispatchDialog
          title={dialogTitle}
          tasks={dialogTasks}
          readyIds={data.readyIds}
          runningNow={data.liveRunStateByTaskId.size}
          liveClaims={liveClaimsFrom(data.runs)}
          defaultConcurrency={data.config?.orchestrator.epicConcurrency ?? 3}
          maxConcurrency={data.config?.orchestrator.maxConcurrency}
          runCostEstimateUsd={data.config?.orchestrator.runCostEstimateUsd}
          fixLoopAuto={data.config?.fixLoop.auto}
          onCancel={() => setDialog(null)}
          onConfirm={async (opts: WorkEpicOptions) => {
            if (dialog.kind === 'epic') {
              await data.handleWorkEpic(dialog.epicId, opts);
            } else {
              // Dispatched one at a time up to the chosen concurrency, matching
              // what the preview promised — the per-task endpoint is the only one
              // that takes an arbitrary set. Marking a real batch keeps the app in
              // the list instead of following each run in turn; starting exactly
              // one is an ordinary single dispatch and still jumps to its Chat.
              const starting = dialogTasks
                .filter((t) => data.readyIds.has(t.meta.id))
                .slice(0, opts.concurrency);
              const batch = starting.length > 1;
              for (const task of starting) {
                await data.handleDispatch(task.meta.id, undefined, undefined, {
                  batch,
                });
              }
            }
            setDialog(null);
            setSelected(NO_SELECTION);
          }}
        />
      )}
    </div>
  );
}
