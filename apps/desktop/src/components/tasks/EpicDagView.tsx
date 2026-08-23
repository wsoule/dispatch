import type { TaskDoc } from '@dispatch/core/browser';
import { useMemo } from 'react';

import { dagTaskFromDoc } from '../../lib/dagLayout';
import { DependencyGraph } from '../graph/DependencyGraph';

export interface EpicDagViewProps {
  /** The epic's children — see `DependencyGraph` for how edges outside this set are treated. */
  tasks: TaskDoc[];
  /** Opens the clicked node's task in the peek/detail dialog. Omitted renders every node as
   * plain, non-interactive text — matching StackRail's `onOpenTask`-optional convention. */
  onOpenTask?: (taskId: string) => void;
  className?: string;
}

/**
 * The epic flavor of the shared `DependencyGraph`: adapts real TaskDocs to the graph's
 * minimal node shape (StackRail linearizes diamonds; this renders them as actual branches).
 */
export function EpicDagView({
  tasks,
  onOpenTask,
  className,
}: EpicDagViewProps) {
  const dagTasks = useMemo(() => tasks.map(dagTaskFromDoc), [tasks]);
  return (
    <DependencyGraph
      tasks={dagTasks}
      onOpenNode={onOpenTask}
      ariaLabel="Epic dependency graph"
      className={className}
    />
  );
}
