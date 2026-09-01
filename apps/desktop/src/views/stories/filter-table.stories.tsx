import { useMemo, useState } from 'react';

import {
  type FilterChipOption,
  FilterChips,
  filterRows,
} from '@/ui/ai/filter-table';
import { TaskRow, TaskRowList, type TaskRowState } from '@/ui/ai/task-rows';
import type { GalleryStory } from '@/views/galleryStories';

// Dispatch's three-status vocabulary for this demo. `filterRows`/`FilterChips` are
// status-agnostic — this mapping is what makes them speak "To do / In progress /
// Completed" for this particular table.
type DemoStatus = 'todo' | 'in-progress' | 'completed';

type DemoTask = {
  id: string;
  title: string;
  agent: string;
  status: DemoStatus;
  elapsedLabel: string;
};

// Reuses TaskRow's own state vocabulary (queued/running/done) to pick each row's dot
// color and shimmer behavior, driven by the demo's Dispatch status.
const STATUS_ROW_STATE: Record<DemoStatus, TaskRowState> = {
  todo: 'queued',
  'in-progress': 'running',
  completed: 'done',
};

const FILTER_OPTIONS: FilterChipOption[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'completed', label: 'Completed' },
];

const TASKS: DemoTask[] = [
  {
    id: 't-716d89',
    title: 'Rework the kanban columns',
    agent: 'Claude',
    status: 'todo',
    elapsedLabel: '0:00',
  },
  {
    id: 't-cafe27',
    title: 'Boot force-fail must say why',
    agent: 'Codex',
    status: 'in-progress',
    elapsedLabel: '2:14',
  },
  {
    id: 't-2dfa1d',
    title: 'See all agents that are working',
    agent: 'Claude',
    status: 'todo',
    elapsedLabel: '0:00',
  },
  {
    id: 'e-f00b6d',
    title: 'Origin-first merges the queue',
    agent: 'Codex',
    status: 'in-progress',
    elapsedLabel: '5:47',
  },
  {
    id: 't-mcp-review',
    title: 'Review dispatch MCP server exports',
    agent: 'Claude',
    status: 'completed',
    elapsedLabel: '8:03',
  },
];

// Counts how many demo tasks currently carry each status, for the chip badges.
function countByStatus(tasks: DemoTask[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

// Toggles a single status in/out of the active selection — the standard multi-select
// chip behavior FilterChips expects its caller to implement.
function toggleStatus(active: string[], id: string): string[] {
  return active.includes(id)
    ? active.filter((candidate) => candidate !== id)
    : [...active, id];
}

// Wires FilterChips + filterRows + TaskRowList/TaskRow together: chip clicks update the
// active selection, filterRows narrows the task list, and every row (matched or not)
// stays mounted inside a grid-rows/opacity transition so a filtered-out row collapses
// smoothly instead of popping out of the list.
function FilterTableDemo() {
  const [active, setActive] = useState<string[]>([]);
  const counts = useMemo(() => countByStatus(TASKS), []);
  const visibleIds = useMemo(
    () =>
      new Set(
        filterRows(TASKS, active, (task) => task.status).map((t) => t.id)
      ),
    [active]
  );

  return (
    <div className="w-full max-w-105">
      <FilterChips
        options={FILTER_OPTIONS}
        active={active}
        onToggle={(id) => setActive((current) => toggleStatus(current, id))}
        counts={counts}
      />
      <TaskRowList>
        {TASKS.map((task) => {
          const visible = visibleIds.has(task.id);
          return (
            <div
              key={task.id}
              aria-hidden={!visible}
              className="ease-out-expo grid transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none"
              style={{
                gridTemplateRows: visible ? '1fr' : '0fr',
                opacity: visible ? 1 : 0,
              }}
            >
              <div className="overflow-hidden">
                <TaskRow
                  title={task.title}
                  agent={task.agent}
                  state={STATUS_ROW_STATE[task.status]}
                  elapsedLabel={task.elapsedLabel}
                />
              </div>
            </div>
          );
        })}
      </TaskRowList>
    </div>
  );
}

export const filterTableStories: GalleryStory[] = [
  {
    id: 'filter-table-tasks',
    title: 'Filter table — Dispatch tasks',
    note: 'Status chips (To do / In progress / Completed) reorganize a live TaskRowList — click a chip to filter, click it again to clear. Filtered-out rows collapse via a grid-rows/opacity transition rather than disappearing instantly.',
    render: () => <FilterTableDemo />,
  },
];
