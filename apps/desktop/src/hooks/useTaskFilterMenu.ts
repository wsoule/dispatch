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
  /** What a clause reads beyond the task itself: live run states and epic titles. */
  filterContext: FilterContext;
  /** The values the Filter menu offers, from the project's own vocabulary. */
  menuContext: FilterMenuContext;
  /** The menu's AI row; `undefined` without a client, which hides the row. */
  aiFilter: ((sentence: string) => Promise<TaskFilterSet>) | undefined;
}

/** The Filter menu's inputs for one project, shared by Classic's board and Two views' Tasks. */
export function useTaskFilterMenu(data: DispatchProjectData): TaskFilterMenu {
  const epicTitleById = useMemo(
    () => new Map(data.epics.map((e) => [e.meta.id, e.meta.title])),
    [data.epics]
  );
  const filterContext = useMemo<FilterContext>(
    () => ({ liveRunStateByTaskId: data.liveRunStateByTaskId, epicTitleById }),
    [data.liveRunStateByTaskId, epicTitleById]
  );
  const menuContext = useMemo<FilterMenuContext>(() => {
    const labels = new Set<string>();
    const milestones = new Set<string>();
    for (const doc of data.tasks) {
      for (const l of doc.meta.labels) labels.add(l);
      if (doc.meta.milestone !== null) milestones.add(doc.meta.milestone);
    }
    return {
      statuses: data.config?.statuses ?? [],
      epics: data.epics,
      labels: [...labels].sort(),
      milestones: [...milestones].sort(),
    };
  }, [data.tasks, data.config, data.epics]);
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
