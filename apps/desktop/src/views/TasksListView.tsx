import type { TaskDoc, UpdatePatch } from '@dispatch/core';
import { Plus, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  AssigneeControl,
  PriorityControl,
  StatusControl,
} from '../components/tasks/PropertyControls';
import { StatusIcon } from '../components/tasks/StatusIcon';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { groupTasksByStatus } from '../lib/boardGrouping';
import { formatRelativeTimeFromIso } from '../lib/format';
import { resolveListKeyCommand } from '../lib/keyboard';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';

interface TasksListViewProps {
  data: DispatchProjectData;
  onSelectTask: (taskId: string) => void;
  /** Opens `CreateTaskModal` pre-set to a given status — wired to each group header's
   * hover-revealed "+" button, mirroring the board's column header. */
  onAddTask?: (status: string) => void;
}

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
 * Linear's dense grouped list: one section per tracker status (config order, same grouping
 * `TaskBoard` uses), each a full-width header (StatusIcon + name + count + hover "+"), then
 * ~36px rows — priority · id · StatusIcon · title (+ epic breadcrumb) · labels · assignee ·
 * relative "updated" time. The caller (`BoardView`, now the single "Tasks" nav destination)
 * owns the page header/New task button and the List/Board toggle; this component only ever
 * renders once there's at least one task in the project, so it doesn't duplicate that
 * container's own empty-project state — it only needs its own empty state for "the search
 * filter matched nothing."
 */
export function TasksListView({
  data,
  onSelectTask,
  onAddTask,
}: TasksListViewProps) {
  const [filter, setFilter] = useState('');
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const epicTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const epic of data.epics) map.set(epic.meta.id, epic.meta.title);
    return map;
  }, [data.epics]);

  const groups = useMemo(() => {
    if (data.config === null) return [];
    const filtered = data.tasks.filter((doc) => matchesFilter(doc, filter));
    return groupTasksByStatus(filtered, data.config.statuses);
  }, [data.tasks, data.config, filter]);

  const orderedIds = useMemo(
    () => groups.flatMap((g) => g.tasks.map((t) => t.meta.id)),
    [groups]
  );

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
          {groups.map(
            (group) =>
              group.tasks.length > 0 && (
                <div key={group.status} className="mb-1">
                  <div className="group/header bg-background sticky top-0 z-10 flex items-center gap-1.5 px-1 py-1.5">
                    <StatusIcon status={group.status} />
                    <span className="text-muted-foreground text-[11px] font-medium">
                      {group.status}
                    </span>
                    <span className="text-muted-foreground/60 font-mono text-[11px]">
                      {group.tasks.length}
                    </span>
                    {onAddTask !== undefined && (
                      <button
                        type="button"
                        onClick={() => onAddTask(group.status)}
                        aria-label={`New task in ${group.status}`}
                        className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto rounded-md p-0.5 opacity-0 transition-opacity duration-150 group-hover/header:opacity-100 focus-visible:opacity-100"
                      >
                        <Plus className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-col">
                    {group.tasks.map((doc) => (
                      <TaskListRow
                        key={doc.meta.id}
                        doc={doc}
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
                </div>
              )
          )}
        </div>
      )}
    </div>
  );
}

interface TaskListRowProps {
  doc: TaskDoc;
  epicTitle?: string;
  statuses: string[];
  focused: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  onStatusChange: (status: string) => void;
  onEditTask: (patch: UpdatePatch) => void;
}

/** A single ~36px dense row: priority · id · status · title (+ epic breadcrumb) · labels ·
 * assignee · relative "updated" time — Linear's list-row anatomy, with priority/status/assignee
 * editable inline (click the glyph → picker). `focused` is a CSS-only highlight (this list's
 * j/k cursor never moves real DOM focus off the list container itself). The row is a
 * `div role="button"` rather than a real `<button>` precisely so those inline picker triggers
 * can be nested interactive elements without invalid button-in-button markup. */
function TaskListRow({
  doc,
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
