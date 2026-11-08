import type { TaskListItem } from '@dispatch-foo/core/browser';
import { createContext, useContext } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { TaskTab } from '../../lib/appNav';
import type { TaskBucket } from '../../lib/taskStatus';
import { FlightPlan } from './FlightPlanView';

/**
 * What a Flight Plan needs from the shell: the project's cached data and its dispatch and
 * navigation verbs. App provides it once, so any surface can drop in
 * `<ContainerFlightPlanSection containerId>` without threading the project through.
 */
export interface FlightPlanHost {
  data: DispatchProjectData;
  /** An open task's one bucket, for the chart's state words. */
  bucketOf: (task: TaskListItem) => TaskBucket | null;
  /** Open asks per task. */
  asksByTask: ReadonlyMap<string, number>;
  /** The project's path: keys the chart's remembered choices. */
  projectKey: string;
  /** Dispatches without following the run; rejects on failure. */
  dispatchTask: (taskId: string) => Promise<void>;
  onDispatchFailed: (taskId: string, message: string) => void;
  onOpenTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  onPeekTask: (taskId: string) => void;
  /** A pending "open Send agents on this container" ask, from Plans' "Create &
   * send agents…". */
  sendAgents?: { milestoneId: string; nonce: number } | null;
  onSendAgentsServed?: (nonce: number) => void;
}

export const FlightPlanHostContext = createContext<FlightPlanHost | null>(null);

export interface ContainerFlightPlanSectionProps {
  /** Any container: a milestone, a parent issue, a project or an initiative. */
  containerId: string;
  /** Where a node opens: the quick-look slide-over (default) or the task page — pass
   * `page` when the section itself sits in a drawer. */
  openIn?: 'peek' | 'page';
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
      bucketOf={host.bucketOf}
      asksByTask={host.asksByTask}
      projectKey={host.projectKey}
      dispatchTask={host.dispatchTask}
      onDispatchFailed={host.onDispatchFailed}
      onOpenTask={host.onOpenTask}
      onPeekTask={host.onPeekTask}
      sendAgentsRequest={
        host.sendAgents?.milestoneId === containerId ? host.sendAgents : null
      }
      onSendAgentsServed={host.onSendAgentsServed}
      openIn={openIn}
      showBranches={showBranches}
      focusOnMount={focusOnMount}
      className={className}
    />
  );
}
