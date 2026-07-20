import type { Priority, TaskDoc } from '@dispatch/core';

// Color mapping lives in theme.css keyed off `data-status` (the six
// built-ins get a named color; anything else — a custom status from
// .dispatch/config.yml — falls through to the neutral default rule). This
// component never hardcodes which statuses exist, only how to color the
// ones it recognizes.
export function StatusPill({ status }: { status: string }) {
  return (
    <span className="status-pill" data-status={status}>
      {status}
    </span>
  );
}

// Only urgent/high get a color treatment; medium/low/none stay silent so the
// one accent color and the two priority colors don't compete for attention
// on a dense board. 'none' renders nothing at all — the common case for most
// tasks shouldn't cost a chip.
export function PriorityChip({ priority }: { priority: Priority }) {
  if (priority === 'none') return null;
  return (
    <span className="priority-chip" data-priority={priority}>
      {priority}
    </span>
  );
}

export interface TaskCardProps {
  doc: TaskDoc;
  ready: boolean;
  blocked: boolean;
  onClick: () => void;
}

// A single board/list card: id (mono, dim), priority, title, and badges for
// anything that changes how someone should treat the task — blocked, or
// belonging to an epic. The accent border-left marks "ready to start" cards,
// the one place besides the primary button the sparse accent color shows up.
export function TaskCard({ doc, ready, blocked, onClick }: TaskCardProps) {
  return (
    <button
      type="button"
      className="task-card"
      data-ready={ready}
      onClick={onClick}
    >
      <div className="task-card__top">
        <span className="task-card__id mono">{doc.meta.id}</span>
        <PriorityChip priority={doc.meta.priority} />
      </div>
      <div className="task-card__title">{doc.meta.title}</div>
      <div className="task-card__meta">
        {blocked && <span className="badge badge--blocked">blocked</span>}
        {doc.meta.parent !== null && (
          <span className="badge badge--epic">{doc.meta.parent}</span>
        )}
      </div>
    </button>
  );
}
