import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';

import { NeedsYouBlock } from '../components/tasks/NeedsYouBlock';
import { TasksStrip } from '../components/tasks/TasksStrip';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskTab } from '../lib/appNav';
import type { DecisionItem } from '../lib/decisionFeed';
import type { NeedsYou } from '../lib/needsYou';
import {
  DEFAULT_TASKS_DISPLAY,
  type TasksDisplayPrefs,
} from '../lib/tasksPrefs';
import type { TaskStatusCounts } from '../lib/taskStatus';
import type { RefAction } from '../lib/threadSources';
import type { TasksMode, TasksPage } from '../lib/twoViews';
import { MilestoneBranchesView } from './MilestoneBranchesView';
import { TasksListView } from './TasksListView';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

// One list grouped by milestone, the No milestone group included.
const BY_MILESTONE: TasksDisplayPrefs = {
  ...DEFAULT_TASKS_DISPLAY,
  layout: 'list',
  grouping: 'milestone',
};

const MODES: { id: TasksMode; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'graph', label: 'Graph' },
];

/** A page that is not the list: a task, a doc, a PR, a draft or a door to Classic. */
export type TasksSidePage = Exclude<TasksPage, { kind: 'list' }>;

export interface TasksViewProps {
  data: DispatchProjectData;
  needs: NeedsYou;
  counts: TaskStatusCounts;
  page: TasksPage;
  mode: TasksMode;
  onModeChange: (mode: TasksMode) => void;
  onSelectTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  onNewTask: () => void;
  onOpenRef: (action: RefAction) => void;
  onOpenDecision: (item: DecisionItem) => void;
  renderPage: (page: TasksSidePage) => ReactNode;
  /** Back to the list from a full page. */
  onClosePage: () => void;
  composer: ReactNode;
}

/** Tasks: the strip, every ask pinned on top, the work by milestone, and its pages. */
export function TasksView({
  data,
  needs,
  counts,
  page,
  mode,
  onModeChange,
  onSelectTask,
  onNewTask,
  onOpenRef,
  onOpenDecision,
  renderPage,
  onClosePage,
  composer,
}: TasksViewProps) {
  const split = page.kind === 'task' && !page.full;
  const full = page.kind !== 'list' && !split;

  return (
    <div data-testid="tasks-view" className="flex h-full min-h-0 flex-col">
      <div className="border-border flex items-center gap-3 border-b-[0.5px] px-4 py-2">
        <span className="shrink-0 text-[13px] font-medium">All work</span>
        <TasksStrip counts={counts} />
        <span className="flex-1" />
        <div
          role="radiogroup"
          aria-label="Tasks layout"
          className="rounded-control border-border-chip bg-surface-secondary flex shrink-0 gap-0.5 border-[0.5px] p-0.5"
        >
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              onClick={() => onModeChange(m.id)}
              className={cn(
                'rounded-[6px] px-2.5 py-0.5 text-[12px]',
                mode === m.id
                  ? 'bg-background font-medium shadow-card'
                  : 'text-muted-foreground'
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={onNewTask} className="shrink-0">
          <Plus className="size-3.5" />
          New task
        </Button>
      </div>
      {full ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {page.kind !== 'task' && (
            <button
              type="button"
              onClick={onClosePage}
              className="text-muted-foreground self-start px-4 pt-2 text-[12px] hover:underline"
            >
              ‹ tasks
            </button>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            {renderPage(page as TasksSidePage)}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className={
              split
                ? 'border-border flex w-[520px] shrink-0 flex-col border-r-[0.5px]'
                : 'flex min-w-0 flex-1 flex-col'
            }
          >
            <div className="max-h-[45%] shrink-0 overflow-y-auto">
              <NeedsYouBlock
                data={data}
                needs={needs}
                onOpenRef={onOpenRef}
                onOpenDecision={onOpenDecision}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {mode === 'graph' ? (
                <MilestoneBranchesView data={data} onOpenTask={onSelectTask} />
              ) : (
                <TasksListView
                  data={data}
                  onSelectTask={(taskId) => onSelectTask(taskId)}
                  display={BY_MILESTONE}
                  needsYouIds={needs.taskIds}
                />
              )}
            </div>
          </div>
          {split && (
            <section aria-label="Task" className="flex min-w-0 flex-1 flex-col">
              {renderPage(page)}
            </section>
          )}
        </div>
      )}
      {composer}
    </div>
  );
}
