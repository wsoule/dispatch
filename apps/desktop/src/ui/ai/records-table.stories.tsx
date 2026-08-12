import { useState } from 'react';

import {
  type RecordsColumn,
  type RecordsRow,
  type RecordsSort,
  RecordsTable,
} from './records-table';
import type { GalleryStory } from '@/views/galleryStories';

const RECORDS_COLUMNS: RecordsColumn[] = [
  { key: 'title', label: 'Task', kind: 'text' },
  { key: 'tags', label: 'Tags', kind: 'tags' },
  { key: 'lastRun', label: 'Last run', kind: 'time' },
  { key: 'confidence', label: 'Confidence', kind: 'strength' },
];

// Six Dispatch-flavored tasks covering every cell kind and its edge states: many tags vs.
// none, a very recent run vs. a missing one, and the full 0-3 range of the strength meter.
const RECORDS_ROWS: RecordsRow[] = [
  {
    id: 't-716d89',
    cells: {
      title: 'Rework the kanban columns',
      tags: ['ui', 'kanban'],
      lastRun: '2026-08-11T06:30:00.000Z',
      confidence: 3,
    },
  },
  {
    id: 't-cafe27',
    cells: {
      title: 'Boot force-fail must say why',
      tags: ['dispatchd', 'boot'],
      lastRun: '2026-08-10T09:15:00.000Z',
      confidence: 2,
    },
  },
  {
    id: 't-2dfa1d',
    cells: {
      title: 'See all agents that are working',
      tags: ['agents', 'overview'],
      lastRun: '2026-08-11T02:00:00.000Z',
      confidence: 1,
    },
  },
  {
    id: 'e-f00b6d',
    cells: {
      title: 'Origin-first merges the queue',
      tags: ['merge-queue'],
      lastRun: '2026-08-02T12:00:00.000Z',
      confidence: 0,
    },
  },
  {
    id: 't-17-records',
    cells: {
      title: 'Records table primitive',
      tags: ['ui', 'primitives', 'gallery'],
      lastRun: '2026-08-11T07:58:00.000Z',
      confidence: 3,
    },
  },
  {
    id: 't-warden',
    cells: {
      title: 'Warden front and center',
      tags: [],
      lastRun: undefined,
      confidence: 2,
    },
  },
];

// RecordsTable is fully controlled — same stateful-wrapper pattern the other demos in
// galleryStories.tsx use — so the header chevrons actually re-sort when clicked.
function RecordsTableDemo() {
  const [sort, setSort] = useState<RecordsSort>({
    key: 'lastRun',
    dir: 'desc',
  });
  return (
    <RecordsTable
      columns={RECORDS_COLUMNS}
      rows={RECORDS_ROWS}
      sort={sort}
      onSortChange={setSort}
      onRowClick={() => {}}
    />
  );
}

export const recordsTableStories: GalleryStory[] = [
  {
    id: 'records-table-tasks',
    title: 'Records table — Dispatch tasks',
    note: 'Sticky muted header with sort chevrons (click a header to cycle asc/desc/off), hairline row dividers, hover wash. Covers text, tags (including an empty state), time (including a missing run), and the 0-3 strength meter.',
    render: () => <RecordsTableDemo />,
  },
];
