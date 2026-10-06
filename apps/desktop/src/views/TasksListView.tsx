import type {
  Assignee,
  Priority,
  TaskListItem,
} from '@dispatch-foo/core/browser';
import { PRIORITY_ORDER } from '@dispatch-foo/core/browser';
import {
  Archive,
  ArrowUpRight,
  Ban,
  CircleDot,
  Copy,
  Eye,
  Link2,
  Milestone,
  Play,
  SearchX,
  SignalHigh,
  Tag,
  Target,
  User,
  Waypoints,
} from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePeople } from '../components/people/PeopleContext';
import { useDeepLinkActions } from '../components/shell/DeepLinkContext';
import { useShellActions } from '../components/shell/ShellActionsContext';
import { AssigneeAvatar } from '../components/tasks/AssigneeAvatar';
import { DispatchDialog } from '../components/tasks/DispatchDialog';
import { PriorityIcon } from '../components/tasks/PriorityIcon';
import { StatusIcon } from '../components/tasks/StatusIcon';
import {
  VirtualRows,
  type VirtualRowsHandle,
} from '../components/virtual/VirtualRows';
import { useCursorHandoff } from '../hooks/useCursorHandoff';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  COLLAPSED_GROUPS_STORAGE_KEY,
  readCollapsedGroups,
  toggleCollapsedGroup,
  writeCollapsedGroups,
} from '../lib/collapsedEpics';
import { landingStateByTaskId } from '../lib/landingBadge';
import {
  type GroupIcon,
  groupTasks,
  type ListGroup,
  type ListGroupRow,
  visibleRowIds,
} from '../lib/listGrouping';
import { colorForEpic } from '../lib/projectColor';
import { useStatusModelOf } from '../lib/statusModel';
import { assigneeLabel, priorityLabel, statusLabel } from '../lib/taskDisplay';
import {
  DEFAULT_TASKS_DISPLAY,
  type TasksDisplayPrefs,
} from '../lib/tasksPrefs';
import { type FlatRow, flattenGroups } from '../lib/virtualRows';
import {
  handleTaskListKeyDown,
  type OpenPicker,
  TaskListRow,
} from './TaskListRow';
import { liveClaimsFrom } from '@/lib/dispatchPreview';
import { GroupHeader } from '@/ui/ai/group-header';
import { IconButton } from '@/ui/ai/icon-button';
import { PillButton } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/ui/context-menu';

interface TasksListViewProps {
  data: DispatchProjectData;
  onSelectTask: (taskId: string) => void;
  /** The Tasks page's shared filters (status/priority facets), applied before grouping.
   * Omitted passes everything. */
  taskFilter?: (doc: TaskListItem) => boolean;
  /** The Display popover's model — grouping, ordering, which properties a row shows. */
  display?: TasksDisplayPrefs;
  /** `f` on the list: the page header opens its filter menu. No-op until wired. */
  onRequestFilter?: () => void;
  /** `⇧V` on the list: the page header opens its Display popover. No-op until wired. */
  onRequestDisplay?: () => void;
}

const PRIORITIES = Object.keys(PRIORITY_ORDER) as Priority[];
const ASSIGNEES: Assignee[] = ['agent', 'human', 'none'];

// Stable fallback while the config loads, so rows' `statuses` prop never churns.
const NO_STATUSES: string[] = [];

/** One virtual row: a group's 36px header or one of its 36px task rows. */
type ListRowModel = FlatRow<ListGroup, ListGroupRow>;

// Headers and rows are both 36px (`GroupHeader`, `ListRow`).
const ROW_HEIGHT = 36;
const rowHeight = () => ROW_HEIGHT;
const listRowKey = (row: ListRowModel) => row.key;
const taskRowKey = (row: ListGroupRow) => row.doc.meta.id;

/** The DOM id `aria-activedescendant` points at for one row; the view prefix keeps ids
 * unique across view switches. */
function rowDomId(id: string): string {
  return `task-row-${id}`;
}

/**
 * Linear's list layout for Tasks: rows straight on the panel (no card, no column header, no
 * dividers), grouped under status-tinted 36px `GroupHeader`s with a `+` each, every row a
 * 36px `ListRow` — priority glyph, sans id, status glyph, title, then the right-aligned pills
 * (labels, epic chip, sub-task count, live run mark, assignee) and the absolute date. The
 * grouping/ordering/properties come from `display` (`groupTasks`), the same model the board
 * and Milestones read. A right-click menu and the single-key shortcuts (`s p a e` pickers,
 * `x` select, `d` dispatch, `o`/Enter open, Space peek, `⌘C` copy id, `j/k`) work on the
 * focused row; bulk selection surfaces a dispatch bar at the bottom. The caller owns the
 * page header, view tabs and filter/display controls; this only renders once the project
 * has tasks, so its own empty state covers "the filter matched nothing".
 */
export function TasksListView({
  data,
  onSelectTask,
  taskFilter,
  display,
  onRequestFilter,
  onRequestDisplay,
}: TasksListViewProps) {
  const shell = useShellActions();
  const model = useStatusModelOf(data.config);
  // `null` outside App's provider (the harness, view tests): no `Copy link` row then.
  const deepLink = useDeepLinkActions();
  const directory = usePeople();
  // The Assignee submenu: everyone in the registry plus the agent pool and nobody, or the
  // three fixed kinds when there is no registry.
  const assigneeChoices = useMemo<Assignee[]>(
    () =>
      directory.assignable.length === 0
        ? ASSIGNEES
        : [...directory.assignable.map((p) => p.ref), 'agent', 'none'],
    [directory.assignable]
  );
  const prefs = display ?? DEFAULT_TASKS_DISPLAY;

  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() =>
    readCollapsedGroups(COLLAPSED_GROUPS_STORAGE_KEY)
  );
  // Multi-select for bulk actions. Kept here rather than lifted: nothing outside this list
  // needs to know what is ticked, and it should clear when you navigate away.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [picker, setPicker] = useState<OpenPicker | null>(null);
  // The row the context menu was opened on — set by the row's own `onContextMenu` before
  // the (single, list-wide) menu trigger handles the same event.
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The scroller as state too: the virtual track needs it once it exists (see VirtualRows).
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const attachList = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    setListEl(node);
  }, []);
  const virtualRef = useRef<VirtualRowsHandle>(null);

  const epicById = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const epic of data.epics) map.set(epic.meta.id, epic);
    return map;
  }, [data.epics]);

  // Children per parent, for the epic row's `▶ N` sub-task count.
  const childCountByParent = useMemo(() => {
    const map = new Map<string, number>();
    for (const doc of data.tasks) {
      if (doc.meta.parent === null) continue;
      map.set(doc.meta.parent, (map.get(doc.meta.parent) ?? 0) + 1);
    }
    return map;
  }, [data.tasks]);

  // Every label in use, for the context menu's Labels submenu.
  const allLabels = useMemo(() => {
    const set = new Set<string>();
    for (const doc of data.tasks) for (const l of doc.meta.labels) set.add(l);
    return [...set].sort();
  }, [data.tasks]);

  const groups = useMemo<ListGroup[]>(() => {
    if (data.config === null) return [];
    const passes = (doc: TaskListItem) => taskFilter?.(doc) ?? true;
    return groupTasks(data.tasks.filter(passes), prefs, {
      statuses: data.config.statuses,
      epics: data.epics,
      archivedTasks: data.showArchived
        ? data.archivedTasks.filter(passes)
        : undefined,
      model,
    });
  }, [
    data.tasks,
    data.config,
    data.epics,
    data.showArchived,
    data.archivedTasks,
    taskFilter,
    prefs,
    model,
  ]);

  const landingByTaskId = useMemo(
    () => landingStateByTaskId(data.mergeQueue),
    [data.mergeQueue]
  );

  const docById = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const g of groups)
      for (const r of g.rows) map.set(r.doc.meta.id, r.doc);
    return map;
  }, [groups]);

  const archivedIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) {
      if (g.archived) for (const r of g.rows) set.add(r.doc.meta.id);
    }
    return set;
  }, [groups]);

  // j/k only walks rows in expanded groups — a collapsed group's tasks are no more reachable
  // by keyboard than they are visible.
  const orderedIds = useMemo(
    () => visibleRowIds(groups, collapsed),
    [groups, collapsed]
  );

  // Headers and rows as one flat, virtualized array. `none` grouping draws no header.
  const flatRows = useMemo<ListRowModel[]>(
    () =>
      flattenGroups(
        groups.map((g) => ({
          key: g.key,
          header: g.kind === 'none' ? null : g,
          items: g.rows,
        })),
        collapsed,
        taskRowKey
      ),
    [groups, collapsed]
  );
  const groupByKey = useMemo(
    () => new Map(groups.map((g) => [g.key, g])),
    [groups]
  );
  // The cursor's row stays mounted wherever the list scrolls: the grid's
  // `aria-activedescendant` points at it.
  const pinnedKeys = useMemo(
    () => (focusedTaskId === null ? [] : [focusedTaskId]),
    [focusedTaskId]
  );

  const selectedTasks = useMemo(
    () => data.tasks.filter((t) => selectedIds.has(t.meta.id)),
    [data.tasks, selectedIds]
  );
  const selectedReady = useMemo(
    () => selectedTasks.filter((t) => data.readyIds.has(t.meta.id)),
    [selectedTasks, data.readyIds]
  );

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  // The row's right-click: remember it for the list-wide menu and move the cursor there.
  const openRowMenu = useCallback((id: string) => {
    setMenuTaskId(id);
    setFocusedTaskId(id);
  }, []);
  // The labels picker's vocabulary, gathered only while one is open.
  const labelCandidates = useMemo(
    () =>
      picker?.kind === 'labels'
        ? [...new Set(data.tasks.flatMap((t) => t.meta.labels))].sort()
        : undefined,
    [picker?.kind, data.tasks]
  );
  const statuses = data.config?.statuses ?? NO_STATUSES;

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = toggleCollapsedGroup(prev, key);
      writeCollapsedGroups(COLLAPSED_GROUPS_STORAGE_KEY, next);
      return next;
    });
  }

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // Keeps the cursor on a visible row whenever the filter or grouping changes.
  useEffect(() => {
    if (orderedIds.length === 0) {
      setFocusedTaskId(null);
    } else if (focusedTaskId === null || !orderedIds.includes(focusedTaskId)) {
      setFocusedTaskId(orderedIds[0] ?? null);
    }
  }, [orderedIds, focusedTaskId]);

  // In place and optimistic, like the Cockpit's `d`: the row shows as started at once, and
  // when that regroups it the cursor stays where it was.
  const handOffCursor = useCursorHandoff(orderedIds, setFocusedTaskId);
  function dispatchOne(taskId: string) {
    if (!data.readyIds.has(taskId)) return;
    if (taskId === focusedTaskId) handOffCursor(taskId);
    void data.handleDispatch(taskId, undefined, undefined, {
      optimistic: true,
    });
  }

  // Only a keyboard move scrolls — a hover that set the cursor must not shift the list under
  // the pointer (which would hand the cursor to the next row and scroll again).
  function moveCursor(id: string | null) {
    setFocusedTaskId(id);
    if (id !== null) virtualRef.current?.scrollToKey(id);
  }

  function handleListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    handleTaskListKeyDown(e, {
      orderedIds,
      focusedTaskId,
      setFocusedTaskId: moveCursor,
      onOpen: onSelectTask,
      onPeek: shell.peekTask,
      onSelectToggle: toggleSelected,
      onDispatch: dispatchOne,
      onCopyId: shell.copyTaskId,
      setPicker,
      onEscape: () => {
        if (selectedIds.size === 0 && picker === null) return false;
        setSelectedIds(new Set());
        setPicker(null);
        return true;
      },
      onRequestFilter,
      onRequestDisplay,
    });
  }

  const groupIcon = (icon: GroupIcon): ReactNode => {
    if (icon === null) return undefined;
    switch (icon.kind) {
      case 'status':
      case 'milestone':
        return <StatusIcon status={icon.status} />;
      case 'epic':
        return icon.epicId === null ? (
          <Milestone className="text-muted-foreground size-3.5" />
        ) : (
          <span
            aria-hidden
            className="size-2.5 rounded-[3px]"
            style={{ backgroundColor: colorForEpic(icon.epicId) }}
          />
        );
      case 'assignee':
        return <AssigneeAvatar assignee={icon.assignee} size={16} />;
      case 'priority':
        return <PriorityIcon priority={icon.priority} />;
    }
  };

  // Under an epic or milestone header the ` › epic` chip repeats the header.
  const showEpicChip =
    prefs.grouping !== 'epic' && prefs.grouping !== 'milestone';

  const menuDoc = menuTaskId !== null ? docById.get(menuTaskId) : undefined;
  const menuEditable =
    menuDoc !== undefined && !archivedIds.has(menuDoc.meta.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Keyed on the groups, not the visible rows: collapsing every group must leave the
          headers (and their chevrons) in place. */}
      {groups.length === 0 ? (
        <EmptyState
          icon={SearchX}
          heading="No tasks match"
          description="Nothing passes the current filter. Clear it to see the project's tasks."
          className="flex-1"
        />
      ) : (
        <ContextMenu
          onOpenChange={(open) => {
            if (!open) setMenuTaskId(null);
          }}
        >
          <ContextMenuTrigger
            render={
              <div
                ref={attachList}
                tabIndex={0}
                role="grid"
                aria-label="Tasks"
                aria-activedescendant={
                  focusedTaskId !== null ? rowDomId(focusedTaskId) : undefined
                }
                onKeyDown={handleListKeyDown}
                className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 outline-none"
              />
            }
          >
            <VirtualRows
              rows={flatRows}
              rowKey={listRowKey}
              estimateSize={rowHeight}
              scrollElement={listEl}
              pinnedKeys={pinnedKeys}
              handleRef={virtualRef}
              renderRow={(row) => {
                if (row.kind === 'header') {
                  const group = row.header;
                  const knownEpic =
                    group.epicId !== null && epicById.has(group.epicId);
                  return (
                    <div data-group-key={group.key}>
                      <GroupHeader
                        tint={group.tint ?? undefined}
                        icon={groupIcon(group.icon)}
                        name={group.label}
                        count={group.rows.length}
                        collapsed={row.collapsed}
                        onToggle={() => toggleGroup(group.key)}
                        onAdd={
                          group.archived
                            ? undefined
                            : () => shell.openCreateTask(group.preset)
                        }
                        addLabel={`New task in ${group.label}`}
                        actions={
                          knownEpic ? (
                            <IconButton
                              label={`Open the flight plan for ${group.label}`}
                              onClick={() => {
                                if (group.epicId !== null) {
                                  shell.openTask(group.epicId, 'plan');
                                }
                              }}
                            >
                              <Waypoints aria-hidden />
                            </IconButton>
                          ) : undefined
                        }
                      />
                    </div>
                  );
                }
                const id = row.key;
                const listRow = row.item;
                const archived =
                  groupByKey.get(row.groupKey)?.archived ?? false;
                return (
                  <TaskListRow
                    doc={listRow.doc}
                    prefs={prefs}
                    run={data.latestRunByTaskId.get(id)}
                    live={data.liveRunStateByTaskId.has(id)}
                    needsYou={data.attentionByTaskId.has(id)}
                    landing={landingByTaskId.get(id)}
                    statuses={statuses}
                    epics={data.epics}
                    labelCandidates={
                      picker?.taskId === id ? labelCandidates : undefined
                    }
                    onUpdate={data.handleUpdate}
                    onMoveStatus={data.moveTaskStatus}
                    indent={listRow.indent}
                    archived={archived}
                    epic={
                      listRow.doc.meta.parent !== null
                        ? epicById.get(listRow.doc.meta.parent)
                        : undefined
                    }
                    childCount={childCountByParent.get(id) ?? 0}
                    showEpicChip={showEpicChip}
                    picker={picker?.taskId === id ? picker : null}
                    onPickerChange={setPicker}
                    selected={selectedIds.has(id)}
                    focused={focusedTaskId === id}
                    onOpen={onSelectTask}
                    onFocus={setFocusedTaskId}
                    onContextMenu={openRowMenu}
                    onSelectToggle={toggleSelected}
                    rowProps={{ domId: rowDomId(id) }}
                  />
                );
              }}
            />
          </ContextMenuTrigger>
          {menuDoc !== undefined && (
            <ContextMenuContent className="min-w-[180px]">
              {menuEditable && (
                <>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <CircleDot />
                      Status
                      <ContextMenuShortcut>S</ContextMenuShortcut>
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {(data.config?.statuses ?? []).map((status) => (
                        <ContextMenuItem
                          key={status}
                          onClick={() =>
                            void data.moveTaskStatus(menuDoc.meta.id, status)
                          }
                        >
                          <StatusIcon status={status} />
                          {statusLabel(status)}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <SignalHigh />
                      Priority
                      <ContextMenuShortcut>P</ContextMenuShortcut>
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {PRIORITIES.map((priority) => (
                        <ContextMenuItem
                          key={priority}
                          onClick={() =>
                            void data.handleUpdate(menuDoc.meta.id, {
                              priority,
                            })
                          }
                        >
                          <PriorityIcon priority={priority} />
                          {priorityLabel(priority)}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <User />
                      Assignee
                      <ContextMenuShortcut>A</ContextMenuShortcut>
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {assigneeChoices.map((assignee) => (
                        <ContextMenuItem
                          key={assignee}
                          onClick={() =>
                            void data.handleUpdate(menuDoc.meta.id, {
                              assignee,
                            })
                          }
                        >
                          <AssigneeAvatar assignee={assignee} size={16} />
                          {directory.personFor(assignee)?.name ??
                            assigneeLabel(assignee)}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Tag />
                      Labels
                      <ContextMenuShortcut>L</ContextMenuShortcut>
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {allLabels.length === 0 ? (
                        <ContextMenuItem disabled>
                          No labels yet
                        </ContextMenuItem>
                      ) : (
                        allLabels.map((label) => (
                          <ContextMenuCheckboxItem
                            key={label}
                            checked={menuDoc.meta.labels.includes(label)}
                            onCheckedChange={(checked) =>
                              void data.handleUpdate(menuDoc.meta.id, {
                                labels: checked
                                  ? [...menuDoc.meta.labels, label]
                                  : menuDoc.meta.labels.filter(
                                      (l) => l !== label
                                    ),
                              })
                            }
                          >
                            {label}
                          </ContextMenuCheckboxItem>
                        ))
                      )}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Milestone />
                      Epic
                      <ContextMenuShortcut>E</ContextMenuShortcut>
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem
                        onClick={() =>
                          void data.handleUpdate(menuDoc.meta.id, {
                            parent: null,
                          })
                        }
                      >
                        No epic
                      </ContextMenuItem>
                      {data.epics.map((epic) => (
                        <ContextMenuItem
                          key={epic.meta.id}
                          onClick={() =>
                            void data.handleUpdate(menuDoc.meta.id, {
                              parent: epic.meta.id,
                            })
                          }
                        >
                          {epic.meta.title}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  {/* Milestone = epic today (e-be4827): the same choices, the same field. */}
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Target />
                      Milestone
                      <ContextMenuShortcut>M</ContextMenuShortcut>
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {data.epics.map((epic) => (
                        <ContextMenuItem
                          key={epic.meta.id}
                          onClick={() =>
                            void data.handleUpdate(menuDoc.meta.id, {
                              parent: epic.meta.id,
                            })
                          }
                        >
                          {epic.meta.title}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem onClick={() => onSelectTask(menuDoc.meta.id)}>
                <ArrowUpRight />
                Open
                <ContextMenuShortcut>O</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onClick={() => shell.peekTask(menuDoc.meta.id)}>
                <Eye />
                Peek
                <ContextMenuShortcut>Space</ContextMenuShortcut>
              </ContextMenuItem>
              {menuEditable && (
                <ContextMenuItem
                  disabled={!data.readyIds.has(menuDoc.meta.id)}
                  onClick={() => dispatchOne(menuDoc.meta.id)}
                >
                  <Play />
                  Dispatch
                  <ContextMenuShortcut>D</ContextMenuShortcut>
                </ContextMenuItem>
              )}
              <ContextMenuItem
                onClick={() => shell.copyTaskId(menuDoc.meta.id)}
              >
                <Copy />
                Copy id
                <ContextMenuShortcut>⌘C</ContextMenuShortcut>
              </ContextMenuItem>
              {deepLink !== null && (
                <ContextMenuItem
                  onClick={() => deepLink.copyTaskLink(menuDoc.meta.id)}
                >
                  <Link2 />
                  Copy link
                </ContextMenuItem>
              )}
              {menuEditable && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={() =>
                      void data.handleUpdate(menuDoc.meta.id, {
                        archivedAt: new Date().toISOString(),
                      })
                    }
                  >
                    <Archive />
                    Archive
                  </ContextMenuItem>
                  <ContextMenuItem
                    variant="destructive"
                    onClick={() =>
                      void data.moveTaskStatus(
                        menuDoc.meta.id,
                        model.roles.dropped
                      )
                    }
                  >
                    <Ban />
                    Drop
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          )}
        </ContextMenu>
      )}

      {/* Only appears once something is ticked, so the list is not permanently wearing a
          toolbar for an action most visits never take. */}
      {selectedIds.size > 0 && (
        <div className="bg-surface-quaternary rounded-card border-border-strong sticky bottom-0 mx-2 mb-2 flex h-9 items-center gap-2 border-[0.5px] px-3">
          <span className="text-[13px] font-medium">
            {selectedIds.size} selected
          </span>
          <span className="font-book text-muted-foreground text-[12px]">
            {selectedReady.length} ready to dispatch
          </span>
          <span className="flex-1" />
          <Button
            disabled={selectedReady.length === 0}
            onClick={() => setDispatchOpen(true)}
          >
            Dispatch {selectedReady.length}
          </Button>
          <PillButton onClick={() => setSelectedIds(new Set())}>
            Clear
          </PillButton>
        </div>
      )}

      {dispatchOpen && (
        <DispatchDialog
          title={`Send agents at ${selectedIds.size} selected ${
            selectedIds.size === 1 ? 'task' : 'tasks'
          }`}
          tasks={selectedTasks}
          readyIds={data.readyIds}
          runningNow={data.liveRunStateByTaskId.size}
          liveClaims={liveClaimsFrom(data.runs)}
          defaultConcurrency={data.config?.orchestrator.epicConcurrency ?? 3}
          onCancel={() => setDispatchOpen(false)}
          onConfirm={async ({ concurrency }) => {
            // Dispatched one at a time up to the chosen concurrency, matching what the preview
            // promised — the per-task endpoint is the only one that takes an arbitrary set.
            const starting = selectedReady.slice(0, concurrency);
            // Marking a real batch keeps the app in the list instead of following each run
            // in turn as the loop creates it (see DispatchOptions). Starting exactly one is
            // an ordinary single dispatch and still jumps to its Chat.
            const batch = starting.length > 1;
            for (const task of starting) {
              await data.handleDispatch(task.meta.id, undefined, undefined, {
                batch,
              });
            }
            setDispatchOpen(false);
            setSelectedIds(new Set());
          }}
        />
      )}
    </div>
  );
}
