import type { ReactNode } from 'react';

import { PageHeader } from '@/ui/ai/page-header';
import { TextButton } from '@/ui/ai/text-button';
import { Button } from '@/ui/button';

/** The chip every Two views page under Tasks leads with; it returns to the list. */
export function TasksBackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button
      variant="outline"
      size="xs"
      data-testid="tasks-back"
      onClick={onBack}
    >
      ‹ tasks
    </Button>
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
    <TextButton onClick={onClick} className="hover:text-foreground">
      {children}
    </TextButton>
  );
}
