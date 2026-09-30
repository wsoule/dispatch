import { createContext, useContext } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { TaskTab } from '../../lib/appNav';
import { FlightPlan } from './FlightPlanView';

/**
 * What a Flight Plan needs from the shell: the project's cached data and its dispatch and
 * navigation verbs. App provides it once, so any surface can drop in
 * `<ContainerFlightPlanSection containerId>` without threading the project through.
 */
export interface FlightPlanHost {
  data: DispatchProjectData;
  /** Dispatches without following the run; rejects on failure. */
  dispatchTask: (taskId: string) => Promise<void>;
  onDispatchFailed: (taskId: string, message: string) => void;
  onOpenTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  onPeekTask: (taskId: string) => void;
}

export const FlightPlanHostContext = createContext<FlightPlanHost | null>(null);

export interface ContainerFlightPlanSectionProps {
  /** Any container: a milestone, a parent issue, a project or an initiative. */
  containerId: string;
  /** Where a node opens: a split pane beside the plan (default) or the task page — pass
   * `page` when the section itself sits in a pane. */
  openIn?: 'pane' | 'page';
  /** The branch lane beneath the plan; on by default. */
  showBranches?: boolean;
  /** Take keyboard focus once on screen — for a surface where the plan is the page. */
  focusOnMount?: boolean;
  className?: string;
}

/**
 * A container's full Flight Plan, fed from the app's `FlightPlanHostContext`. Fills its
 * parent (a flex column with a bounded height). Renders nothing outside the host — a test
 * or the gallery — rather than throwing.
 */
export function ContainerFlightPlanSection({
  containerId,
  openIn,
  showBranches,
  focusOnMount,
  className,
}: ContainerFlightPlanSectionProps) {
  const host = useContext(FlightPlanHostContext);
  if (host === null) return null;
  return (
    <FlightPlan
      containerId={containerId}
      data={host.data}
      dispatchTask={host.dispatchTask}
      onDispatchFailed={host.onDispatchFailed}
      onOpenTask={host.onOpenTask}
      onPeekTask={host.onPeekTask}
      openIn={openIn}
      showBranches={showBranches}
      focusOnMount={focusOnMount}
      className={className}
    />
  );
}
