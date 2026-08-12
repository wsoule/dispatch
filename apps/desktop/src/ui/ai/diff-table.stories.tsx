import { DiffTable, type DiffTableRow } from './diff-table';
import type { GalleryStory } from '@/views/galleryStories';

const TASK_TABLE_COLUMNS = [
  { key: 'title', label: 'Task' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'status', label: 'Status' },
];

const TASK_TABLE_ROWS: DiffTableRow[] = [
  {
    id: 't-2dfa1d',
    kind: 'change',
    cells: {
      title: { old: 'See all agents', next: 'See all agents across repos' },
      assignee: { next: 'claude' },
      status: { old: 'todo', next: 'in_progress' },
    },
  },
  {
    id: 't-716d89',
    kind: 'change',
    cells: {
      status: { old: 'in_progress', next: 'review' },
    },
  },
  {
    id: 't-cafe27',
    kind: 'change',
    cells: {
      title: {
        old: 'Boot force-fail must say why',
        next: 'Boot force-fail must say why and surface the reason',
      },
    },
  },
  {
    id: 't-9b41aa',
    kind: 'add',
    cells: {
      title: { next: 'Add diff table primitive' },
      assignee: { next: 'sonnet' },
      status: { next: 'todo' },
    },
  },
  {
    id: 't-71c0e2',
    kind: 'add',
    cells: {
      title: { next: 'Wire accept-all to review queue' },
      assignee: { next: 'sonnet' },
      status: { next: 'todo' },
    },
  },
  {
    id: 't-e04c11',
    kind: 'remove',
    cells: {
      title: { old: 'Stale duplicate sync task' },
      assignee: { old: 'unassigned' },
      status: { old: 'blocked' },
    },
  },
];

/** Task 16's gallery stories, kept in this file rather than `galleryStories.tsx` per
 * the parallel-wave convention — the integration step folds these into the shared
 * catalog once every sibling primitive has landed. */
export const diffTableStories: GalleryStory[] = [
  {
    id: 'diff-table-task-edits',
    title: 'Diff table — task board edits',
    note: 'Six-row mixed diff over the task table: two edited rows (old → next per changed cell), two new tasks, one removed duplicate. Hover a row to accept/reject it individually, or Accept all.',
    render: () => (
      <DiffTable
        columns={TASK_TABLE_COLUMNS}
        rows={TASK_TABLE_ROWS}
        onAccept={() => {}}
        onReject={() => {}}
        onAcceptAll={() => {}}
      />
    ),
  },
];
