import type { ReactNode } from 'react';

import { PageHeader } from '@/ui/ai/page-header';

/** The chip every Two views page under Tasks leads with; it returns to the list. */
export function TasksBackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      data-testid="tasks-back"
      onClick={onBack}
      className="rounded-control border-border-chip text-muted-foreground hover:bg-surface-hover focus-visible:ring-ring h-6 shrink-0 border-[0.5px] px-2 text-[12px] font-medium outline-none focus-visible:ring-2"
    >
      ‹ tasks
    </button>
  );
}

/** A side page's header in Two views: "‹ tasks", then a compact crumb and its actions. */
export function TasksPageHeader({
  onBack,
  crumb,
  actions,
}: {
  onBack: () => void;
  crumb: ReactNode[];
  actions?: ReactNode;
}) {
  return (
    <PageHeader
      leading={<TasksBackButton onBack={onBack} />}
      crumb={crumb}
      actions={actions}
    />
  );
}

/** A crumb segment that walks back up, such as "All docs" above an open doc. */
export function CrumbLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:text-foreground truncate outline-none focus-visible:underline"
    >
      {children}
    </button>
  );
}
