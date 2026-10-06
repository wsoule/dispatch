import { Plus } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';

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
import {
  type PresetContext,
  presetMatcher,
  TASKS_PRESETS,
  type TasksPreset,
} from '../lib/tasksPresets';
import type { TaskStatusCounts } from '../lib/taskStatus';
import type { RefAction } from '../lib/threadSources';
import type { TasksMode, TasksPage } from '../lib/twoViews';
import { MilestoneBranchesView } from './MilestoneBranchesView';
import { TasksListView } from './TasksListView';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

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
  /** Narrows the list and graph to one question; All shows everything. */
  preset: TasksPreset;
  onPreset: (preset: TasksPreset) => void;
  presetContext: PresetContext;
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
  preset,
  onPreset,
  presetContext,
  onSelectTask,
  onNewTask,
  onOpenRef,
  onOpenDecision,
  renderPage,
  onClosePage,
  composer,
}: TasksViewProps) {
  const split = page.kind === 'task' && !page.full;
  const taskFilter = useMemo(
    () => presetMatcher(preset, presetContext),
    [preset, presetContext]
  );
  const presetLabel =
    TASKS_PRESETS.find((p) => p.id === preset)?.label ?? 'All';
  const full = page.kind !== 'list' && !split;

  return (
    <div data-testid="tasks-view" className="flex h-full min-h-0 flex-col">
      <div className="border-border flex items-center gap-3 border-b-[0.5px] px-4 py-2">
        <span className="shrink-0 text-[13px] font-medium">All work</span>
        <TasksStrip counts={counts} preset={preset} onPreset={onPreset} />
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
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="tasks-preset"
            className="rounded-control border-border-chip text-muted-foreground hover:bg-surface-hover shrink-0 border-[0.5px] px-2 py-0.5 text-[12px]"
          >
            view: {presetLabel} ▾
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[160px]">
            <DropdownMenuRadioGroup
              value={preset}
              onValueChange={(value) => {
                const next = TASKS_PRESETS.find((p) => p.id === value);
                if (next !== undefined) onPreset(next.id);
              }}
            >
              {TASKS_PRESETS.map((p) => (
                <DropdownMenuRadioItem key={p.id} value={p.id}>
                  {p.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
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
            {preset !== 'all' && (
              <div
                data-testid="tasks-filter"
                className="text-muted-foreground flex items-center gap-2 px-4 pt-1 pb-1 text-[12px]"
              >
                <span>Showing {presetLabel} only</span>
                <button
                  type="button"
                  onClick={() => onPreset('all')}
                  className="text-(--accent) hover:underline"
                >
                  Clear
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              {mode === 'graph' ? (
                <MilestoneBranchesView
                  data={data}
                  onOpenTask={onSelectTask}
                  taskFilter={taskFilter}
                />
              ) : (
                <TasksListView
                  data={data}
                  onSelectTask={(taskId) => onSelectTask(taskId)}
                  display={BY_MILESTONE}
                  taskFilter={taskFilter}
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
