import type { Priority, TaskDoc } from '@dispatch/core';

import { PriorityChip, StatusPill } from './TaskCard';

export interface ListViewProps {
  tasks: TaskDoc[];
  statuses: string[];
  readyIds: Set<string>;
  blockedIds: Set<string>;
  onSelect: (id: string) => void;
}

// Mirrors core/graph.ts's PRIORITY_ORDER purely for client-side sort order —
// see taskGraph.ts for why this package reimplements small bits of core's
// value-level logic instead of importing it (types-only import rule).
const PRIORITY_ORDER: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

// Dense table sorted by status (in config order) then priority — the same
// grouping as the board, just linear instead of columnar. Same click-through
// to the detail drawer as Board.
export function ListView({
  tasks,
  statuses,
  readyIds,
  blockedIds,
  onSelect,
}: ListViewProps) {
  const statusRank = new Map(statuses.map((s, i) => [s, i]));
  const sorted = [...tasks].sort((a, b) => {
    const rankA = statusRank.get(a.meta.status) ?? statuses.length;
    const rankB = statusRank.get(b.meta.status) ?? statuses.length;
    if (rankA !== rankB) return rankA - rankB;
    const byPriority =
      PRIORITY_ORDER[a.meta.priority] - PRIORITY_ORDER[b.meta.priority];
    if (byPriority !== 0) return byPriority;
    return a.meta.created.localeCompare(b.meta.created);
  });

  return (
    <table className="list-table">
      <thead>
        <tr>
          <th>Id</th>
          <th>Title</th>
          <th>Status</th>
          <th>Priority</th>
          <th>Kind</th>
          <th>Epic</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((doc) => (
          <tr
            key={doc.meta.id}
            data-ready={readyIds.has(doc.meta.id)}
            onClick={() => onSelect(doc.meta.id)}
          >
            <td className="mono">{doc.meta.id}</td>
            <td>
              {doc.meta.title}
              {blockedIds.has(doc.meta.id) && (
                <span className="badge badge--blocked badge--inline">
                  blocked
                </span>
              )}
            </td>
            <td>
              <StatusPill status={doc.meta.status} />
            </td>
            <td>
              <PriorityChip priority={doc.meta.priority} />
            </td>
            <td>{doc.meta.kind}</td>
            <td className="mono">{doc.meta.parent ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
