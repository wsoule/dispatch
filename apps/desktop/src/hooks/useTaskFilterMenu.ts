import { useMemo } from 'react';

import type { FilterMenuContext } from '../components/tasks/FilterMenu';
import {
  EMPTY_TASK_FILTER_SET,
  type FilterContext,
  type TaskFilterSet,
  taskFilterSetFromValue,
} from '../lib/taskFilters';
import type { DispatchProjectData } from './useDispatchProject';

interface TaskFilterMenu {
  /** What a clause reads beyond the task itself: live run states and milestone titles. */
  filterContext: FilterContext;
  /** The values the Filter menu offers, from the project's own vocabulary. */
  menuContext: FilterMenuContext;
  /** The menu's AI row; `undefined` without a client, which hides the row. */
  aiFilter: ((sentence: string) => Promise<TaskFilterSet>) | undefined;
}

/** The Filter menu's inputs for one project, for the Tasks page's header. */
export function useTaskFilterMenu(data: DispatchProjectData): TaskFilterMenu {
  const milestoneTitleById = useMemo(
    () => new Map(data.milestones.map((e) => [e.meta.id, e.meta.title])),
    [data.milestones]
  );
  const filterContext = useMemo<FilterContext>(
    () => ({
      liveRunStateByTaskId: data.liveRunStateByTaskId,
      milestoneTitleById,
    }),
    [data.liveRunStateByTaskId, milestoneTitleById]
  );
  const menuContext = useMemo<FilterMenuContext>(() => {
    const labels = new Set<string>();
    for (const doc of data.tasks) {
      for (const l of doc.meta.labels) labels.add(l);
    }
    return {
      statuses: data.config?.statuses ?? [],
      milestones: data.milestones,
      labels: [...labels].sort(),
    };
  }, [data.tasks, data.config, data.milestones]);
  // The daemon turns a sentence into clauses, parsed like a stored set so an invented facet
  // drops rather than leaking into a `switch`.
  const client = data.client;
  const aiFilter = useMemo(
    () =>
      client === null
        ? undefined
        : async (sentence: string) =>
            taskFilterSetFromValue(await client.aiFilterTasks(sentence)) ??
            EMPTY_TASK_FILTER_SET,
    [client]
  );
  return { filterContext, menuContext, aiFilter };
}
