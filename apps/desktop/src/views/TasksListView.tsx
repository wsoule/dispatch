import type { EpicProgress } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { ChevronRight, SearchX, Waypoints } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { MergeLadderDot } from '../components/runs/MergeLadderDot';
import { DispatchDialog } from '../components/tasks/DispatchDialog';
import { EpicDagModal } from '../components/tasks/EpicDagModal';
import {
  AssigneeControl,
  PriorityControl,
  StatusControl,
} from '../components/tasks/PropertyControls';
import { StackBadge } from '../components/tasks/StackRail';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { deriveEpicPulse } from '../lib/epicPulse';
import { resolveListKeyCommand } from '../lib/keyboard';
import { Input } from '../ui/input';
import { cn } from '@/lib/utils';
import {
  type RecordsColumn,
  type RecordsGroup,
  type RecordsRow,
  RecordsTable,
} from '@/ui/ai/records-table';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { StateDot } from '@/ui/chrome/StateDot';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

interface TasksListViewProps {
  data: DispatchProjectData;
  onSelectTask: (taskId: string) => void;
}

// A group of rows under one epic-grouping header: `epicId` is `null` for the catch-all "No
// epic" bucket (always rendered last) — everything else is keyed by the parent id the tasks
// in it actually carry, even if that id doesn't resolve to a known epic (a dangling parent
// reference still needs somewhere honest to render, rather than silently joining "No epic").
interface EpicGroup {
  epicId: string | null;
  title: string;
  progress: EpicProgress | undefined;
  tasks: TaskDoc[];
  /** True only for the trailing "Archived" bucket — its rows render muted and read-only. */
  archived?: boolean;
}

const NO_EPIC_KEY = '__no-epic__';
// The "Archived" bucket's key — kept apart from `NO_EPIC_KEY` and every real epic id.
const ARCHIVED_GROUP_KEY = '__archived__';

// Case-insensitive substring match against a task's id and title — a plain narrowing filter
// (not the palette's fuzzy ranking), since a dense grouped list benefits more from a
// predictable "contains" filter than from fuzzy re-ordering.
function matchesFilter(doc: TaskDoc, filter: string): boolean {
  if (filter.trim() === '') return true;
  const needle = filter.toLowerCase();
  return (
    doc.meta.id.toLowerCase().includes(needle) ||
    doc.meta.title.toLowerCase().includes(needle)
  );
}

// `RecordsTable` columns for the list — priority/status/assignee are blank-labelled since
// they render as bare inline-picker glyphs (see `renderTaskCell`), matching the dense
// board-card/list-row anatomy those glyphs use everywhere else in the app. No column carries
// a `RecordsCellKind` that would sort meaningfully on its own for priority/status/assignee
// (they're objects-shaped-as-scalars edited via a picker, not compared), so — like the
// pre-reskin row — this list has no header-click sort; `sort`/`onSortChange` are omitted.
const COLUMNS: RecordsColumn[] = [
  { key: 'priority', label: '' },
  { key: 'id', label: 'ID' },
  { key: 'status', label: 'Status' },
  { key: 'title', label: 'Title' },
  { key: 'tags', label: 'Tags', kind: 'tags' },
  { key: 'assignee', label: '' },
  { key: 'updated', label: 'Updated', kind: 'time' },
];

/**
 * Linear's dense grouped list: one section per epic (project order, "No epic" last), each a
 * full-width collapsible header (chevron + epic title + done/total progress, reusing the same
 * `epicProgressById` data `TaskBoard`'s epic cards show), then ~36px rows — priority · id ·
 * status · title (+ epic breadcrumb, + stack badge) · labels · assignee · relative "updated"
 * time. Rendered through `RecordsTable`'s `groups`/`selectable`/`renderCell` extensions (see
 * `records-table.tsx`) so the table styling — sticky header, hairline rows, hover wash — comes
 * from the shared primitive while every pre-reskin capability (bulk-select + dispatch,
 * per-epic collapsible grouping, inline priority/status/assignee pickers, the epic
 * dependency-graph modal, the stack badge, j/k roving focus) stays intact; those live in this
 * view, composed around/into the table rather than baked into it. The caller (`BoardView`, now
 * the single "Tasks" nav destination) owns the page header/New task button and the List/Board
 * toggle; this component only ever renders once there's at least one task in the project, so
 * it doesn't duplicate that container's own empty-project state — it only needs its own empty
 * state for "the search filter matched nothing."
 */
export function TasksListView({ data, onSelectTask }: TasksListViewProps) {
  const [filter, setFilter] = useState('');
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  );
  // View-local modal state for the epic dependency-graph view — which epic's graph is open, or
  // `null` when closed. Not lifted to App-level nav state since nothing outside this list needs
  // to know the graph is open.
  const [dagEpicId, setDagEpicId] = useState<string | null>(null);
  // Multi-select for bulk actions. Kept here rather than lifted: nothing outside this list
  // needs to know what is ticked, and it should clear when you navigate away.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const epicById = useMemo(() => {
    const map = new Map<string, TaskDoc>();
    for (const epic of data.epics) map.set(epic.meta.id, epic);
    return map;
  }, [data.epics]);

  const epicTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const epic of data.epics) map.set(epic.meta.id, epic.meta.title);
    return map;
  }, [data.epics]);

  // The dag modal always graphs an epic's *full* child set, independent of the list's own
  // search filter — narrowing the filter shouldn't make edges disappear from the graph.
  const dagEpic = dagEpicId !== null ? (epicById.get(dagEpicId) ?? null) : null;
  // Memoized so this array is referentially stable across re-renders while the modal is open —
  // otherwise a new array every render would bust EpicDagView's own `[tasks]` memo on every
  // parent re-render (mirrors TaskDetailPanel's `epicChildren` memo for the same shape of
  // derivation).
  const dagTasks = useMemo(
    () =>
      dagEpicId !== null
        ? data.tasks.filter((t) => t.meta.parent === dagEpicId)
        : [],
    [data.tasks, dagEpicId]
  );

  // Buckets every filtered task under its `parent` epic id in one pass, then orders the
  // resulting groups: known epics first (in the project's own epic order, skipping any epic
  // with zero matching tasks so an empty header never renders), then any dangling parent ids
  // that don't resolve to a known epic, then "No epic" last.
  const groups = useMemo<EpicGroup[]>(() => {
    if (data.config === null) return [];
    const filtered = data.tasks.filter((doc) => matchesFilter(doc, filter));

    const byParent = new Map<string, TaskDoc[]>();
    const noEpic: TaskDoc[] = [];
    for (const doc of filtered) {
      const parent = doc.meta.parent;
      if (parent === null) {
        noEpic.push(doc);
        continue;
      }
      const bucket = byParent.get(parent);
      if (bucket !== undefined) bucket.push(doc);
      else byParent.set(parent, [doc]);
    }

    const result: EpicGroup[] = [];
    const seenParents = new Set<string>();
    for (const epic of data.epics) {
      const bucket = byParent.get(epic.meta.id);
      if (bucket === undefined) continue;
      seenParents.add(epic.meta.id);
      result.push({
        epicId: epic.meta.id,
        title: epic.meta.title,
        progress: data.epicProgressById.get(epic.meta.id),
        tasks: bucket,
      });
    }
    for (const [parentId, bucket] of byParent) {
      if (seenParents.has(parentId)) continue;
      result.push({
        epicId: parentId,
        title: parentId,
        progress: undefined,
        tasks: bucket,
      });
    }
    if (noEpic.length > 0) {
      result.push({
        epicId: null,
        title: 'No epic',
        progress: undefined,
        tasks: noEpic,
      });
    }
    // With the toggle on, archived tasks get their own trailing group rather than
    // rejoining their original epic bucket.
    if (data.showArchived) {
      const archived = data.archivedTasks.filter((doc) =>
        matchesFilter(doc, filter)
      );
      if (archived.length > 0) {
        result.push({
          epicId: ARCHIVED_GROUP_KEY,
          title: 'Archived',
          progress: undefined,
          tasks: archived,
          archived: true,
        });
      }
    }
    return result;
  }, [
    data.tasks,
    data.config,
    data.epics,
    data.epicProgressById,
    data.showArchived,
    data.archivedTasks,
    filter,
  ]);

  // Every task currently rendered, keyed by id — `renderTaskCell` looks the full `TaskDoc` back
  // up from a `RecordsRow`'s bare `id`, since a row's `cells` only carry plain sortable/
  // displayable values, not the doc itself.
  const docById = useMemo(() => {
    const map = new Map<string, TaskDoc>();
    for (const g of groups)
      for (const doc of g.tasks) map.set(doc.meta.id, doc);
    return map;
  }, [groups]);

  // Ids in the trailing "Archived" group — read by `rowClassName`/`renderTaskCell` to dim
  // those rows and skip the attention wash, without needing every row to carry its own group
  // back-reference.
  const archivedRowIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) {
      if (g.archived === true) for (const doc of g.tasks) set.add(doc.meta.id);
    }
    return set;
  }, [groups]);

  // j/k roving-focus + Enter-to-open only ever considers rows in expanded groups — a collapsed
  // group's tasks are no more reachable by keyboard than they are visible.
  const orderedIds = useMemo(
    () =>
      groups.flatMap((g) =>
        collapsedGroups.has(g.epicId ?? NO_EPIC_KEY)
          ? []
          : g.tasks.map((t) => t.meta.id)
      ),
    [groups, collapsedGroups]
  );

  // The selection, resolved back to tasks — and the subset that can actually start, which is
  // what the bar's label has to name. Selecting a blocked task is normal; pretending it will
  // dispatch is not.
  const selectedTasks = useMemo(
    () => data.tasks.filter((t) => selectedIds.has(t.meta.id)),
    [data.tasks, selectedIds]
  );
  const selectedReady = useMemo(
    () => selectedTasks.filter((t) => data.readyIds.has(t.meta.id)),
    [selectedTasks, data.readyIds]
  );

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // Keeps the cursor pointed at a visible row whenever the filter narrows/widens the result
  // set — falls back to the first visible row rather than leaving the cursor stuck on a row
  // that just scrolled out of the filtered set.
  useEffect(() => {
    if (orderedIds.length === 0) {
      setFocusedTaskId(null);
    } else if (focusedTaskId === null || !orderedIds.includes(focusedTaskId)) {
      setFocusedTaskId(orderedIds[0] ?? null);
    }
  }, [orderedIds, focusedTaskId]);

  useEffect(() => {
    if (focusedTaskId === null) return;
    listRef.current
      ?.querySelector(`[data-row-id="${focusedTaskId}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [focusedTaskId]);

  function handleListKeyDown(e: React.KeyboardEvent) {
    const command = resolveListKeyCommand(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
      { isTyping: false }
    );
    if (command === null || orderedIds.length === 0) return;
    e.preventDefault();
    if (command === 'list-confirm') {
      if (focusedTaskId !== null) onSelectTask(focusedTaskId);
      return;
    }
    const currentIndex =
      focusedTaskId !== null ? orderedIds.indexOf(focusedTaskId) : -1;
    const nextIndex =
      command === 'list-down'
        ? Math.min(currentIndex + 1, orderedIds.length - 1)
        : Math.max(currentIndex - 1, 0);
    setFocusedTaskId(orderedIds[Math.max(nextIndex, 0)] ?? null);
  }

  // The inline priority/status/title(+breadcrumb+stack badge)/assignee cells — everything a
  // generic `kind` can't express. Returns `undefined` for every other column, falling back to
  // `RecordsTable`'s own default rendering (id as plain text, tags as chips, updated as a
  // relative timestamp).
  function renderTaskCell(
    row: RecordsRow,
    column: RecordsColumn
  ): ReactNode | undefined {
    const doc = docById.get(row.id);
    if (doc === undefined) return undefined;
    if (column.key === 'priority') {
      return (
        <PriorityControl
          value={doc.meta.priority}
          onChange={(p) => void data.handleUpdate(doc.meta.id, { priority: p })}
        />
      );
    }
    if (column.key === 'status') {
      return (
        <StatusControl
          value={doc.meta.status}
          statuses={data.config?.statuses ?? []}
          onChange={(status) => void data.moveTaskStatus(doc.meta.id, status)}
        />
      );
    }
    if (column.key === 'title') {
      const epicTitle =
        doc.meta.parent !== null
          ? epicTitleById.get(doc.meta.parent)
          : undefined;
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <MergeLadderDot meta={data.latestRunByTaskId.get(doc.meta.id)} />
          <span className="text-foreground min-w-0 flex-1 truncate text-[13px]">
            {doc.meta.title}
            {epicTitle !== undefined && (
              <span className="text-muted-foreground"> › {epicTitle}</span>
            )}
          </span>
          <StackBadge
            tasks={data.tasksIncludingArchived}
            taskId={doc.meta.id}
          />
        </span>
      );
    }
    if (column.key === 'assignee') {
      return (
        <AssigneeControl
          value={doc.meta.assignee}
          onChange={(a) => void data.handleUpdate(doc.meta.id, { assignee: a })}
        />
      );
    }
    return undefined;
  }

  // Selected rows wash blue, the roving j/k cursor washes a lighter accent, an unreviewed
  // run's row washes amber, and an archived row (read-only, from the "Archived" toggle) dims —
  // in that priority order, matching the pre-reskin row's own ternary exactly.
  function taskRowClassName(row: RecordsRow): string {
    const archived = archivedRowIds.has(row.id);
    const selected = selectedIds.has(row.id);
    const focused = row.id === focusedTaskId;
    const needsAttention = !archived && data.attentionByTaskId.has(row.id);
    return cn(
      selected
        ? 'bg-accent/20'
        : focused
          ? 'bg-accent/50'
          : needsAttention
            ? 'bg-state-waiting-surface'
            : '',
      archived && 'opacity-55 saturate-50'
    );
  }

  // Each `EpicGroup` becomes one `RecordsGroup`: the header is the same collapsible
  // chevron/title/progress/pulse/dag-button row the pre-reskin list rendered, now spanning the
  // table's full width instead of sitting above a plain `<div>` of rows.
  const recordsGroups = useMemo<RecordsGroup[]>(
    () =>
      groups.map((group) => {
        const key = group.epicId ?? NO_EPIC_KEY;
        const collapsed = collapsedGroups.has(key);
        const doneCount =
          group.progress?.children.filter(
            (c) => c.status === 'done' || c.status === 'cancelled'
          ).length ?? 0;
        const totalCount = group.progress?.children.length ?? 0;
        const pulse = deriveEpicPulse(
          group.tasks,
          data.latestRunByTaskId,
          data.readyIds
        );
        return {
          key,
          header: (
            <div className="flex w-full items-center gap-1.5 px-1 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => toggleGroup(key)}
                aria-expanded={!collapsed}
                className="group h-auto min-w-0 flex-1 justify-start gap-1.5 px-0 text-left text-[length:inherit] font-normal hover:bg-transparent has-[>svg]:px-0"
              >
                <ChevronRight
                  className={cn(
                    'text-muted-foreground size-3.5 shrink-0 transition-transform',
                    !collapsed && 'rotate-90'
                  )}
                />
                <span className="text-muted-foreground min-w-0 truncate text-[11px] font-medium">
                  {group.title}
                </span>
                <span className="text-muted-foreground/60 shrink-0 font-mono text-[11px]">
                  {group.tasks.length}
                </span>
                {totalCount > 0 && (
                  <span className="text-muted-foreground/70 shrink-0 text-[11px]">
                    {doneCount}/{totalCount} done
                  </span>
                )}
                {/* The single most actionable fact about this epic, rather than a tally of
                    everything — see deriveEpicPulse for why the ordering matters. */}
                <span className="flex shrink-0 items-center gap-1.5">
                  {pulse.state !== null && <StateDot state={pulse.state} />}
                  <span
                    className={cn(
                      'dense-meta',
                      pulse.state === 'waiting' && 'text-state-waiting'
                    )}
                  >
                    {pulse.label}
                  </span>
                </span>
              </Button>
              {/* Only for a group keyed by a real, known epic (not the dangling-parent or
                  "No epic" buckets) — there's no epic to graph otherwise. A sibling of the
                  toggle button above, not nested inside it (button-in-button isn't valid
                  HTML). */}
              {group.epicId !== null && epicTitleById.has(group.epicId) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setDagEpicId(group.epicId)}
                      aria-label={`View dependency graph for ${group.title}`}
                      className="text-muted-foreground hover:text-foreground size-auto shrink-0 p-1"
                    >
                      <Waypoints className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>View dependency graph</TooltipContent>
                </Tooltip>
              )}
            </div>
          ),
          rows: collapsed
            ? []
            : group.tasks.map((doc) => ({
                id: doc.meta.id,
                cells: {
                  priority: doc.meta.priority,
                  id: doc.meta.id,
                  status: doc.meta.status,
                  title: doc.meta.title,
                  tags: doc.meta.labels,
                  assignee: doc.meta.assignee,
                  updated: doc.meta.updated,
                },
              })),
        };
      }),
    [
      groups,
      collapsedGroups,
      data.latestRunByTaskId,
      data.readyIds,
      epicTitleById,
    ]
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          className="text-[13px]"
          placeholder="Filter by id or title…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {orderedIds.length === 0 ? (
        <EmptyState
          icon={SearchX}
          message="No tasks match this filter."
          className="flex-1 justify-center gap-3 p-0 text-[13px] [&>[data-slot=empty-description]]:text-[length:inherit]"
        />
      ) : (
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={handleListKeyDown}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <RecordsTable
            columns={COLUMNS}
            groups={recordsGroups}
            sort={null}
            onRowClick={(row) => onSelectTask(row.id)}
            selectable
            selectedIds={selectedIds}
            onToggleSelect={toggleSelected}
            selectLabel={(row) =>
              `Select ${docById.get(row.id)?.meta.title ?? row.id}`
            }
            renderCell={renderTaskCell}
            rowClassName={taskRowClassName}
          />
        </div>
      )}

      {/* Only appears once something is ticked, so the list is not permanently wearing a
          toolbar for an action most visits never take. */}
      {selectedIds.size > 0 && (
        <div className="bg-accent/15 shadow-hairline-strong sticky bottom-0 flex items-center gap-2 rounded-lg px-3 py-2">
          <span className="text-[12.5px]">{selectedIds.size} selected</span>
          <span className="dense-meta">
            {selectedReady.length} ready to dispatch
          </span>
          <span className="flex-1" />
          <Button
            size="xs"
            disabled={selectedReady.length === 0}
            onClick={() => setDispatchOpen(true)}
            className="bg-accent text-accent-foreground hover:bg-accent h-auto px-2.5 py-1 text-[12px] font-normal"
          >
            Dispatch {selectedReady.length}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setSelectedIds(new Set())}
            className="shadow-hairline h-auto px-2.5 py-1 text-[12px] font-normal hover:bg-transparent"
          >
            Clear
          </Button>
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
          defaultConcurrency={data.config?.orchestrator.epicConcurrency ?? 3}
          onCancel={() => setDispatchOpen(false)}
          onConfirm={async (concurrency) => {
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

      <EpicDagModal
        epic={dagEpic}
        tasks={dagTasks}
        onOpenTask={onSelectTask}
        onClose={() => setDagEpicId(null)}
      />
    </div>
  );
}
