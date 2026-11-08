import type { OverseerAction, RunMeta } from '@dispatch/client';

/** The Overseer tools whose card is a list of tasks: what they propose, then what they made. */
const TASK_TOOLS: ReadonlySet<string> = new Set([
  'create_plan',
  'create_task',
  'dispatch_task',
]);

/** One row of an Overseer task card: a task by id once it exists, or by its proposed title. */
interface TaskCardEntry {
  /** The task's id; absent for a task a pending plan has not created yet. */
  taskId?: string;
  title: string;
  /** The task's latest run, when it has one: its dot and status line. */
  run?: RunMeta;
}

/** What a task card shows: its rows and the head's proposed and started counts. */
export interface TaskCardModel {
  entries: TaskCardEntry[];
  proposed: number;
  started: number;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Whether an action's tool proposes tasks, so its card lists them. */
export function isTaskTool(tool: string | undefined): boolean {
  return tool !== undefined && TASK_TOOLS.has(tool);
}

// Each task's newest run, by createdAt.
function latestRuns(runs: readonly RunMeta[]): Map<string, RunMeta> {
  const latest = new Map<string, RunMeta>();
  for (const run of runs) {
    const seen = latest.get(run.taskId);
    if (seen === undefined || run.createdAt > seen.createdAt) {
      latest.set(run.taskId, run);
    }
  }
  return latest;
}

function model(entries: TaskCardEntry[]): TaskCardModel {
  return {
    entries,
    proposed: entries.length,
    started: entries.filter((e) => e.run !== undefined).length,
  };
}

/**
 * The tasks a still-pending action proposes, read from its validated input:
 * a plan's task titles, one new task's title, or the existing task a dispatch
 * names (with its current run). Null for any other tool, or an input of a
 * shape this build does not know.
 */
export function proposedTaskCard(
  action: OverseerAction,
  taskTitle: (taskId: string) => string | undefined,
  runs: readonly RunMeta[]
): TaskCardModel | null {
  const input = record(action.input);
  if (action.tool === 'create_plan') {
    const tasks = Array.isArray(input.tasks) ? input.tasks : [];
    const titles = tasks
      .map((t) => str(record(t).title))
      .filter((t) => t !== undefined);
    return titles.length === 0
      ? null
      : model(titles.map((title) => ({ title })));
  }
  if (action.tool === 'create_task') {
    const title = str(input.title);
    return title === undefined ? null : model([{ title }]);
  }
  if (action.tool === 'dispatch_task') {
    const taskId = str(input.taskId);
    if (taskId === undefined) return null;
    return appliedTaskCard([taskId], taskTitle, runs);
  }
  return null;
}

/**
 * The tasks an applied action created or dispatched (its transcript entry's
 * `taskIds`), each with its newest run. A task the board no longer lists
 * keeps its id as its title.
 */
export function appliedTaskCard(
  taskIds: readonly string[],
  taskTitle: (taskId: string) => string | undefined,
  runs: readonly RunMeta[]
): TaskCardModel {
  const latest = latestRuns(runs);
  return model(
    taskIds.map((taskId) => {
      const run = latest.get(taskId);
      return {
        taskId,
        title: taskTitle(taskId) ?? run?.taskTitle ?? taskId,
        ...(run === undefined ? {} : { run }),
      };
    })
  );
}

/** The head's heading: "3 suggested tasks". */
export function taskCardHeading(proposed: number): string {
  return `${proposed} suggested ${proposed === 1 ? 'task' : 'tasks'}`;
}

/** The head's quiet note: "2 started". */
export function taskCardNote(started: number): string {
  return `${started} started`;
}
