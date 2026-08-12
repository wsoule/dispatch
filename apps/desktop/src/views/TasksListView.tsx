import type { TaskDoc } from '@dispatch/core/browser';
import { SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { statusLabel } from '../lib/taskDisplay';
import { Input } from '../ui/input';
import {
  type RecordsRow,
  type RecordsSort,
  RecordsTable,
  sortRows,
} from '@/ui/ai/records-table';
import { EmptyState } from '@/ui/chrome';

interface TasksListViewProps {
  data: DispatchProjectData;
  onSelectTask: (taskId: string) => void;
}

// Case-insensitive substring match against a task's id and title — a plain narrowing filter
// (not the palette's fuzzy ranking), since a dense list benefits more from a predictable
// "contains" filter than from fuzzy re-ordering.
function matchesFilter(doc: TaskDoc, filter: string): boolean {
  if (filter.trim() === '') return true;
  const needle = filter.toLowerCase();
  return (
    doc.meta.id.toLowerCase().includes(needle) ||
    doc.meta.title.toLowerCase().includes(needle)
  );
}

const COLUMNS = [
  { key: 'title', label: 'Title' },
  { key: 'tags', label: 'Tags', kind: 'tags' as const },
  { key: 'state', label: 'State' },
  { key: 'updated', label: 'Updated', kind: 'time' as const },
];

/**
 * The dense "List view" of the project's tasks: a flat `RecordsTable` (title, tags, state,
 * updated), sortable per column, filterable by id/title. This is the reskin's simplified
 * replacement for the old grouped-by-epic, checkbox-multi-select list — `RecordsTable`'s
 * generic columns/rows contract has no room for per-row checkboxes, epic group headers, or
 * inline priority/assignee pickers, so that chrome is gone; a task's full detail (including
 * priority/assignee editing and bulk dispatch) lives one click away in the task detail view
 * that `onSelectTask` opens. The caller (`BoardView`) owns the page header and List/Board
 * toggle, so this only needs its own empty state for "the search filter matched nothing."
 */
export function TasksListView({ data, onSelectTask }: TasksListViewProps) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<RecordsSort>(null);

  const allTasks = useMemo(
    () =>
      data.showArchived ? [...data.tasks, ...data.archivedTasks] : data.tasks,
    [data.tasks, data.archivedTasks, data.showArchived]
  );

  const filtered = useMemo(
    () => allTasks.filter((doc) => matchesFilter(doc, filter)),
    [allTasks, filter]
  );

  const rows = useMemo<RecordsRow[]>(
    () =>
      filtered.map((doc) => ({
        id: doc.meta.id,
        cells: {
          title: doc.meta.title,
          tags: doc.meta.labels,
          state: statusLabel(doc.meta.status),
          updated: doc.meta.updated,
        },
      })),
    [filtered]
  );

  const sortedRows = useMemo(() => sortRows(rows, COLUMNS, sort), [rows, sort]);

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

      {sortedRows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          message="No tasks match this filter."
          className="flex-1 justify-center gap-3 p-0 text-[13px] [&>[data-slot=empty-description]]:text-[length:inherit]"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RecordsTable
            columns={COLUMNS}
            rows={sortedRows}
            sort={sort}
            onSortChange={setSort}
            onRowClick={(row) => onSelectTask(row.id)}
          />
        </div>
      )}
    </div>
  );
}
