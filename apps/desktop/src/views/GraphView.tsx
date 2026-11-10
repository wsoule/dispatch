import type { TaskListItem } from '@dispatch-foo/core/browser';
import {
  graphContainer,
  graphScopeFor,
  NO_INITIATIVE_ID,
} from '@dispatch/planning';
import type {
  GraphContainer,
  GraphLevel,
  GraphScope,
} from '@dispatch/planning';
import { EmptyState, NavTabs, TaskCrumbs } from '@dispatch/ui';
import { useCallback, useMemo } from 'react';

import { graphHref, graphTrail, levelTabs } from '../adapters/graphScope';
import type { ChartUnit } from '../components/graph/ChartInspector';
import {
  GraphTooLarge,
  type GraphTooLargeModel,
} from '../components/graph/GraphTooLarge';
import {
  type ChartView,
  MilestoneMapView,
  TASK_DRAW_CAP,
} from '../components/graph/MilestoneMap';
import { useShellActions } from '../components/shell/ShellActionsContext';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { usePlanningContext } from '../hooks/usePlanning';
import type { NavAction, TaskTab } from '../lib/appNav';
import { cardParents, upperLevelGroups } from '../lib/graphLevels';
import { ISSUES_DISPLAY } from '../lib/issuesPrefs';
import { groupTasks } from '../lib/listGrouping';
import { useStatusModelOf } from '../lib/statusModel';
import type { TaskBucket } from '../lib/taskStatus';
import styles from './GraphView.module.css';

// The Graph destination: the ELK dependency chart (components/graph/MilestoneMap) at
// the route's level. Initiatives, Projects and Milestones draw cards with the task waits
// between them counted; Issues lays every linked task out. A click traces what a box waits
// on (amber) and what it unblocks (teal), and a double-click on a card drills a level down
// (initiative → its projects → a project's milestones → a milestone's tasks). The route
// (`#/graph?initiative=…&project=…&milestone=…&chain=…&level=…`) names the container and
// the level; the trail above the chart climbs back up, and `?node=` selects a task on
// arrival. Opening a task quick-looks it in the shell's drawer.

/** How many milestones the too-large state offers to narrow to. */
const NARROW_ROWS = 12;

/** Each card level's words, and its way down. */
const UNIT: Record<Exclude<GraphLevel, 'issue'>, ChartUnit> = {
  initiative: {
    one: 'initiative',
    many: 'initiatives',
    drill: 'Show its projects',
  },
  project: { one: 'project', many: 'projects', drill: 'Show its milestones' },
  milestone: { one: 'milestone', many: 'milestones', drill: 'Show its tasks' },
};
const CARDS: readonly ChartView[] = ['milestones'];
const TASKS: readonly ChartView[] = ['tasks'];

export interface GraphViewProps {
  /** The window's tasks, containers and asks. */
  data: Pick<DispatchProjectData, 'tasks' | 'milestones' | 'config'>;
  /** An open task's one bucket (App's `itemBucket` over the window's asks,
   * failures, runs and merge queue): the chart's state words read it. */
  bucketOf: (task: TaskListItem) => TaskBucket | null;
  /** Open asks per task, for each card's attention count. */
  asksByTask: ReadonlyMap<string, number>;
  /** Keys the chart's remembered display choices per project. */
  projectKey: string;
  /** The scope drawn: the page's route (`#/graph?project=…&level=…`). */
  scope: GraphScope;
  /** The task a link selected on arrival, when it named one (`?node=`). */
  nodeId: string | null;
  /** Dispatches a nav action: a level tab, a drill, the trail. */
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
  const level = scope.level;
  const byId = useMemo(() => {
    const out = new Map<string, TaskListItem>();
    for (const doc of data.milestones) out.set(doc.meta.id, doc);
    for (const doc of data.tasks) out.set(doc.meta.id, doc);
    return out;
  }, [data.tasks, data.milestones]);
  const hasInitiatives = useMemo(
    () => data.milestones.some((doc) => doc.meta.kind === 'initiative'),
    [data.milestones]
  );

  // The tasks a narrowed scope holds: the issue boxes of the planning's graph of it at the
  // issue level (its own issues and the outside ones they wait on or unblock). The
  // workspace, or a window without a planning, draws every task.
  const scopedTasks = useMemo((): readonly TaskListItem[] => {
    if (container.kind === 'workspace' || planning === null) return data.tasks;
    const graph = planning.graph(graphScopeFor(container, 'issue'));
    const ids = new Set(graph.nodes.map((node) => node.id));
    return data.tasks.filter((task) => ids.has(task.meta.id));
  }, [container, planning, data.tasks]);

  const groups = useMemo(() => {
    if (level === 'initiative' || level === 'project') {
      return upperLevelGroups(scopedTasks, data.milestones, level);
    }
    return groupTasks([...scopedTasks], ISSUES_DISPLAY, {
      statuses: data.config?.statuses ?? [],
      milestones: data.milestones,
      model,
    });
  }, [level, scopedTasks, data.milestones, data.config, model]);

  // "Box by …": a project in its initiative, a milestone in its project.
  const parents = useMemo(() => {
    if (level === 'project' && hasInitiatives) {
      return {
        of: cardParents(groups, data.milestones, 'initiative'),
        one: 'initiative',
      };
    }
    if (level === 'milestone') {
      return {
        of: cardParents(groups, data.milestones, 'project'),
        one: 'project',
      };
    }
    return undefined;
  }, [level, hasInitiatives, groups, data.milestones]);

  const dueDateOf = useCallback(
    (id: string) => byId.get(id)?.meta.dueDate ?? null,
    [byId]
  );

  const onOpenTask = useCallback(
    (id: string, tab?: TaskTab) => {
      if (!byId.has(id)) return;
      if (tab === undefined) peekTask(id);
      else openTask(id, tab);
    },
    [byId, peekTask, openTask]
  );

  const go = useCallback(
    (next: GraphScope) =>
      onNavigate({ type: 'openGraph', scope: next, nodeId: null }),
    [onNavigate]
  );

  // A card's way down: an initiative's projects, a project's milestones, a milestone's
  // tasks (a project's own loose tasks, on the Milestones level, open its Issues).
  const onDrill = useCallback(
    (id: string) => {
      const kind =
        id === NO_INITIATIVE_ID ? 'initiative' : byId.get(id)?.meta.kind;
      let next: GraphContainer | null = null;
      if (kind === 'initiative') next = { kind: 'initiative', id };
      else if (kind === 'project') next = { kind: 'project', id };
      else if (kind === 'milestone' || kind === 'task') {
        next = { kind: 'milestone', id };
      }
      if (next === null) return;
      const below: GraphLevel =
        next.kind === 'initiative'
          ? 'project'
          : next.kind === 'project' && level === 'project'
            ? 'milestone'
            : 'issue';
      go(graphScopeFor(next, below));
    },
    [byId, level, go]
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
        message: `${count} tasks is more than the chart draws at once (${TASK_DRAW_CAP}). Hide landed tasks under Display, use the Milestones level, or open one milestone's chart.`,
        title: 'Open one milestone',
        rows,
      };
      return <GraphTooLarge tooLarge={tooLarge} />;
    },
    [groups]
  );

  const tabs = useMemo(
    () => levelTabs(scope, { hasInitiatives, graph: graphHref }),
    [scope, hasInitiatives]
  );
  const trail = useMemo(
    () =>
      planning === null ? [] : graphTrail(planning.snapshot, scope, graphHref),
    [planning, scope]
  );
  const chartKey = `${projectKey}|${graphHref(scope)}`;

  return (
    <div className={styles.root} data-testid="graph-view">
      <header className={styles.head}>
        <h1 className={styles.title}>Graph</h1>
        {trail.length > 0 && (
          <div className={styles.trail}>
            <TaskCrumbs breadcrumb={trail} taskKey="" label="Graph scope" />
          </div>
        )}
        {tabs.length > 0 && (
          <NavTabs
            label="Graph level"
            size="sm"
            items={tabs}
            className={styles.levels}
          />
        )}
      </header>
      {data.config === null ? (
        <EmptyState>The graph is not available here.</EmptyState>
      ) : (
        <MilestoneMapView
          // A new project, scope or level starts from its own remembered state.
          key={chartKey}
          groups={groups}
          bucketOf={bucketOf}
          asksByTask={asksByTask}
          projectKey={chartKey}
          dueDateOf={dueDateOf}
          views={level === 'issue' ? TASKS : CARDS}
          unit={level === 'issue' ? undefined : UNIT[level]}
          onDrill={level === 'issue' ? undefined : onDrill}
          cardParents={parents}
          arrivalTaskId={
            level === 'issue' && nodeId !== null && byId.has(nodeId)
              ? nodeId
              : null
          }
          renderTooLarge={renderTooLarge}
          onOpenTask={onOpenTask}
        />
      )}
    </div>
  );
}
