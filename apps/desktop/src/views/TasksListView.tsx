import type { EpicProgress } from '@dispatch/client';
import type { TaskDoc, UpdatePatch } from '@dispatch/core';
import { ChevronDown, ChevronRight, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  AssigneeControl,
  PriorityControl,
  StatusControl,
} from '../components/tasks/PropertyControls';
import { StackBadge } from '../components/tasks/StackRail';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import { resolveListKeyCommand } from '../lib/keyboard';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';

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
}

const NO_EPIC_KEY = '__no-epic__';

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
  const listRef = useRef<HTMLDivElement>(null);

  const epicTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const epic of data.epics) map.set(epic.meta.id, epic.meta.title);
    return map;
  }, [data.epics]);

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
    return result;
  }, [data.tasks, data.config, data.epics, data.epicProgressById, filter]);

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
      <Input
        className="text-[13px]"
        placeholder="Filter by id or title…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

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
            return (
              <div key={key} className="mb-1">
                <button
                  type="button"
                  onClick={() => toggleGroup(key)}
                  aria-expanded={!collapsed}
                  className="bg-background sticky top-0 z-10 flex w-full items-center gap-1.5 px-1 py-1.5 text-left"
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
                </button>
                {!collapsed && (
                  <div className="flex flex-col">
                    {group.tasks.map((doc) => (
                      <TaskListRow
                        key={doc.meta.id}
                        doc={doc}
                        tasks={data.tasks}
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
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface TaskListRowProps {
  doc: TaskDoc;
  /** Full project task list, passed through to `StackBadge` so it can derive this row's
   * stack position without the list needing its own precomputed map. */
  tasks: TaskDoc[];
  epicTitle?: string;
  statuses: string[];
  focused: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  onStatusChange: (status: string) => void;
  onEditTask: (patch: UpdatePatch) => void;
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
  epicTitle,
  statuses,
  focused,
  onClick,
  onMouseEnter,
  onStatusChange,
  onEditTask,
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
      className={`flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors duration-150 ${
        focused ? 'bg-accent/50' : 'hover:bg-accent/30'
      }`}
    >
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
