import type { TaskListItem } from '@dispatch-foo/core/browser';
import { graphContainer, graphScopeFor } from '@dispatch/planning';
import type { GraphScope } from '@dispatch/planning';
import { Button, EmptyState } from '@dispatch/ui';
import { useCallback, useMemo } from 'react';

import { graphHref } from '../adapters/graphScope';
import {
  GraphTooLarge,
  type GraphTooLargeModel,
} from '../components/graph/GraphTooLarge';
import {
  MilestoneMapView,
  TASK_DRAW_CAP,
} from '../components/graph/MilestoneMap';
import { useShellActions } from '../components/shell/ShellActionsContext';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { usePlanningContext } from '../hooks/usePlanning';
import {
  DEFAULT_GRAPH_SCOPE,
  type NavAction,
  type TaskTab,
} from '../lib/appNav';
import { ISSUES_DISPLAY } from '../lib/issuesPrefs';
import { groupTasks } from '../lib/listGrouping';
import { useStatusModelOf } from '../lib/statusModel';
import type { TaskBucket } from '../lib/taskStatus';
import styles from './GraphView.module.css';

// The Graph destination: the ELK dependency chart (components/graph/MilestoneMap)
// over the open project's tasks, grouped by milestone as the Issues list groups them.
// Milestones is the one-screen overview; Tasks lays every linked task out with elkjs. A
// click traces what a node waits on (amber) and what it unblocks (teal), and the inspector
// lists both. The page's `#/graph?…` route still narrows the chart: a link that names an
// initiative, a project, a milestone or one issue's chain (the Projects page writes them)
// draws only that scope's tasks, from the planning's own graph of it, and a link that names
// a box (`?node=`) selects that task on arrival. Opening a task quick-looks it in the
// shell's drawer.

/** How many milestones the too-large state offers to narrow to. */
const NARROW_ROWS = 12;

export interface GraphViewProps {
  /** The window's tasks, containers and asks. */
  data: Pick<DispatchProjectData, 'tasks' | 'milestones' | 'config'>;
  /** An open task's one bucket (App's `itemBucket` over the window's asks,
   * failures, runs and merge queue): the chart's state words read it. */
  bucketOf: (task: TaskListItem) => TaskBucket | null;
  /** Open asks per task, for each milestone's attention count. */
  asksByTask: ReadonlyMap<string, number>;
  /** Keys the chart's remembered view and display choices per project. */
  projectKey: string;
  /** The scope drawn: the page's route (`#/graph?project=…&level=…`). */
  scope: GraphScope;
  /** The task a link selected on arrival, when it named one (`?node=`). */
  nodeId: string | null;
  /** Dispatches a nav action: "Whole workspace" leaves a narrowed scope. */
  onNavigate: (action: NavAction) => void;
}

export function GraphView({
  data,
  bucketOf,
  asksByTask,
  projectKey,
  scope,
  nodeId,
  onNavigate,
}: GraphViewProps) {
  const planning = usePlanningContext();
  const { peekTask, openTask } = useShellActions();
  const model = useStatusModelOf(data.config);
  const container = graphContainer(scope);
  const tasksById = useMemo(
    () => new Map(data.tasks.map((task) => [task.meta.id, task])),
    [data.tasks]
  );

  // The tasks a narrowed scope holds: the issue boxes of the planning's graph of it at the
  // issue level (its own issues and the outside ones they wait on or unblock). The
  // workspace, or a window without a planning, draws every task.
  const scopedIds = useMemo((): ReadonlySet<string> | null => {
    if (container.kind === 'workspace' || planning === null) return null;
    const graph = planning.graph(graphScopeFor(container, 'issue'));
    return new Set(graph.nodes.map((node) => node.id));
  }, [container, planning]);

  const groups = useMemo(() => {
    if (data.config === null) return [];
    const tasks =
      scopedIds === null
        ? data.tasks
        : data.tasks.filter((task) => scopedIds.has(task.meta.id));
    return groupTasks(tasks, ISSUES_DISPLAY, {
      statuses: data.config.statuses,
      milestones: data.milestones,
      model,
    });
  }, [data.config, data.tasks, data.milestones, scopedIds, model]);

  const dueDateOf = useCallback(
    (id: string) => tasksById.get(id)?.meta.dueDate ?? null,
    [tasksById]
  );

  const onOpenTask = useCallback(
    (id: string, tab?: TaskTab) => {
      if (!tasksById.has(id)) return;
      if (tab === undefined) peekTask(id);
      else openTask(id, tab);
    },
    [tasksById, peekTask, openTask]
  );

  // Past the draw cap: the milestones with the most tasks, each a link to its own chart.
  const renderTooLarge = useCallback(
    (count: number) => {
      const rows = groups
        .flatMap((group) =>
          group.milestoneId === null || group.rows.length === 0
            ? []
            : [
                {
                  id: group.milestoneId,
                  label: group.label,
                  count: group.rows.length,
                },
              ]
        )
        .sort((a, b) => b.count - a.count)
        .slice(0, NARROW_ROWS)
        .map((row) => ({
          ...row,
          href: graphHref(
            graphScopeFor({ kind: 'milestone', id: row.id }, 'issue')
          ),
        }));
      const tooLarge: GraphTooLargeModel = {
        message: `${count} tasks is more than the chart draws at once (${TASK_DRAW_CAP}). Hide landed tasks under Display, use the Milestones view, or open one milestone's chart.`,
        title: 'Open one milestone',
        rows,
      };
      return <GraphTooLarge tooLarge={tooLarge} />;
    },
    [groups]
  );

  const scopeTitle =
    container.kind === 'workspace'
      ? null
      : (tasksById.get(container.id)?.meta.title ?? container.id);
  const chartKey = `${projectKey}|${graphHref(scope)}`;

  return (
    <div className={styles.root} data-testid="graph-view">
      <header className={styles.head}>
        <h1 className={styles.title}>Dependencies</h1>
        {scopeTitle !== null ? (
          <p className={styles.receipts}>
            Showing{' '}
            {container.kind === 'chain'
              ? `the chain around ${scopeTitle}`
              : scopeTitle}
            .{' '}
            <Button
              variant="quiet"
              size="sm"
              onClick={() =>
                onNavigate({
                  type: 'openGraph',
                  scope: DEFAULT_GRAPH_SCOPE,
                  nodeId: null,
                })
              }
            >
              Whole workspace
            </Button>
          </p>
        ) : null}
      </header>
      {data.config === null ? (
        <EmptyState>The graph is not available here.</EmptyState>
      ) : (
        <MilestoneMapView
          // A new project or scope starts from its own remembered state.
          key={chartKey}
          groups={groups}
          bucketOf={bucketOf}
          asksByTask={asksByTask}
          projectKey={projectKey}
          dueDateOf={dueDateOf}
          arrivalTaskId={
            nodeId !== null && tasksById.has(nodeId) ? nodeId : null
          }
          renderTooLarge={renderTooLarge}
          onOpenTask={onOpenTask}
        />
      )}
    </div>
  );
}
