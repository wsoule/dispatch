import type { EpicProgress, RunMeta } from '@dispatch/client';
import type { TaskDoc, UpdatePatch } from '@dispatch/core/browser';
import { ChevronDown, ChevronRight, SearchX, Waypoints } from 'lucide-react';
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
import { StateDot } from '../components/ui/StateDot';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { deriveEpicPulse } from '../lib/epicPulse';
import { formatRelativeTimeFromIso } from '../lib/format';
import { resolveListKeyCommand } from '../lib/keyboard';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { cn } from '@/lib/utils';

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

const MAX_VISIBLE_LABELS = 2;

/**
 * Linear's dense grouped list: one section per epic (project order, "No epic" last), each a
 * full-width collapsible header (chevron + epic title + done/total progress, reusing the same
 * `epicProgressById` data `TaskBoard`'s epic cards show), then ~36px rows — priority · id ·
 * StatusIcon · title (+ epic breadcrumb, + stack badge) · labels · assignee · relative
 * "updated" time. The caller (`BoardView`, now the single "Tasks" nav destination) owns the
 * page header/New task button and the List/Board toggle; this component only ever renders
 * once there's at least one task in the project, so it doesn't duplicate that container's own
 * empty-project state — it only needs its own empty state for "the search filter matched
 * nothing."
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
  // parent re-render (mirrors TaskDetailDialog's `epicChildren` memo for the same shape of
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
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <SearchX className="text-muted-foreground size-5" />
          <p className="text-muted-foreground text-[13px]">
            No tasks match this filter.
          </p>
        </div>
      ) : (
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={handleListKeyDown}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {groups.map((group) => {
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
            return (
              <div key={key} className="mb-1">
                <div className="bg-background sticky top-0 z-10 flex w-full items-center gap-1.5 px-1 py-1.5">
                  <button
                    type="button"
                    onClick={() => toggleGroup(key)}
                    aria-expanded={!collapsed}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    {collapsed ? (
                      <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
                    ) : (
                      <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                    )}
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
                  </button>
                  {/* Only for a group keyed by a real, known epic (not the dangling-parent or
                      "No epic" buckets) — there's no epic to graph otherwise. A sibling of the
                      toggle button above, not nested inside it (button-in-button isn't valid
                      HTML), so no stopPropagation is needed here the way the card entry points
                      below need it. */}
                  {group.epicId !== null && epicTitleById.has(group.epicId) && (
                    <button
                      type="button"
                      onClick={() => setDagEpicId(group.epicId)}
                      aria-label={`View dependency graph for ${group.title}`}
                      title="View dependency graph"
                      className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-md p-1 transition-colors duration-150"
                    >
                      <Waypoints className="size-3.5" />
                    </button>
                  )}
                </div>
                {!collapsed && (
                  <div className="flex flex-col">
                    {group.tasks.map((doc) => (
                      <TaskListRow
                        key={doc.meta.id}
                        doc={doc}
                        // Archived rows need their own doc present here for
                        // StackBadge to resolve them at all.
                        tasks={data.tasksIncludingArchived}
                        run={data.latestRunByTaskId.get(doc.meta.id)}
                        epicTitle={
                          doc.meta.parent !== null
                            ? epicTitleById.get(doc.meta.parent)
                            : undefined
                        }
                        statuses={data.config?.statuses ?? []}
                        focused={doc.meta.id === focusedTaskId}
                        onClick={() => onSelectTask(doc.meta.id)}
                        onMouseEnter={() => setFocusedTaskId(doc.meta.id)}
                        onStatusChange={(status) =>
                          void data.moveTaskStatus(doc.meta.id, status)
                        }
                        onEditTask={(patch) =>
                          void data.handleUpdate(doc.meta.id, patch)
                        }
                        selected={selectedIds.has(doc.meta.id)}
                        onToggleSelect={() => toggleSelected(doc.meta.id)}
                        archived={group.archived === true}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
          <button
            type="button"
            disabled={selectedReady.length === 0}
            onClick={() => setDispatchOpen(true)}
            className="bg-accent text-accent-foreground rounded-md px-2.5 py-1 text-[12px] disabled:opacity-50"
          >
            Dispatch {selectedReady.length}
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="shadow-hairline rounded-md px-2.5 py-1 text-[12px]"
          >
            Clear
          </button>
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
            for (const task of starting) {
              await data.handleDispatch(task.meta.id);
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

interface TaskListRowProps {
  doc: TaskDoc;
  /** Full project task list, passed through to `StackBadge` so it can derive this row's
   * stack position without the list needing its own precomputed map. */
  tasks: TaskDoc[];
  /** This task's latest run, if it has one — feeds the row's merge-ladder dot. */
  run: RunMeta | undefined;
  epicTitle?: string;
  statuses: string[];
  focused: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  onStatusChange: (status: string) => void;
  onEditTask: (patch: UpdatePatch) => void;
  selected: boolean;
  onToggleSelect: () => void;
  /** True for a row in the trailing "Archived" group — purely visual; the status
   *  move itself is gated in `useDispatchProject`. */
  archived?: boolean;
}

/** A single ~36px dense row: priority · id · status · title (+ epic breadcrumb, + stack badge)
 * · labels · assignee · relative "updated" time — Linear's list-row anatomy, with
 * priority/status/assignee editable inline (click the glyph → picker). `focused` is a
 * CSS-only highlight (this list's j/k cursor never moves real DOM focus off the list
 * container itself). The row is a `div role="button"` rather than a real `<button>` precisely
 * so those inline picker triggers can be nested interactive elements without invalid
 * button-in-button markup. */
function TaskListRow({
  doc,
  tasks,
  run,
  epicTitle,
  statuses,
  focused,
  onClick,
  onMouseEnter,
  onStatusChange,
  onEditTask,
  selected,
  onToggleSelect,
  archived = false,
}: TaskListRowProps) {
  const visibleLabels = doc.meta.labels.slice(0, MAX_VISIBLE_LABELS);
  const hiddenLabelCount = doc.meta.labels.length - visibleLabels.length;

  return (
    <div
      role="button"
      tabIndex={-1}
      data-row-id={doc.meta.id}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={`group flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 ${
        selected
          ? 'bg-accent/20'
          : focused
            ? 'bg-accent/50'
            : 'hover:bg-accent/30'
      } ${archived ? 'opacity-55 saturate-50' : ''}`}
    >
      {/* Hidden until you hover or select something, so an unused affordance does not add a
          column of empty boxes to every row. stopPropagation because selecting a task and
          opening it are different intents. */}
      <input
        type="checkbox"
        checked={selected}
        aria-label={`Select ${doc.meta.title}`}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        className={`accent-accent size-3.5 shrink-0 transition-opacity duration-150 ${
          selected ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
        }`}
      />
      <PriorityControl
        value={doc.meta.priority}
        onChange={(p) => onEditTask({ priority: p })}
      />
      <span className="text-muted-foreground w-14 shrink-0 truncate font-mono text-[11px]">
        {doc.meta.id}
      </span>
      <StatusControl
        value={doc.meta.status}
        statuses={statuses}
        onChange={onStatusChange}
      />
      <MergeLadderDot meta={run} />
      <span className="text-foreground min-w-0 flex-1 truncate text-[13px]">
        {doc.meta.title}
        {epicTitle !== undefined && (
          <span className="text-muted-foreground"> › {epicTitle}</span>
        )}
      </span>
      <StackBadge tasks={tasks} taskId={doc.meta.id} />
      {visibleLabels.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {visibleLabels.map((label) => (
            <Badge
              key={label}
              variant="outline"
              className="text-muted-foreground h-4 rounded px-1.5 py-0 text-[10px] font-normal"
            >
              {label}
            </Badge>
          ))}
          {hiddenLabelCount > 0 && (
            <span className="text-muted-foreground/70 text-[10px]">
              +{hiddenLabelCount}
            </span>
          )}
        </span>
      )}
      <AssigneeControl
        value={doc.meta.assignee}
        onChange={(a) => onEditTask({ assignee: a })}
      />
      <span className="text-muted-foreground/70 w-14 shrink-0 text-right text-[11px]">
        {formatRelativeTimeFromIso(doc.meta.updated)}
      </span>
    </div>
  );
}
