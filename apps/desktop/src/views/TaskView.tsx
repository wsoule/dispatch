import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';

import { RunStatePill } from '../components/runs/RunStatePill';
import { ErrorBoundary } from '../components/shell/ErrorBoundary';
import type { TaskDetailPanelProps } from '../components/tasks/detail';
import { TaskDetailPanel } from '../components/tasks/detail';
import { TaskChatTab } from '../components/tasks/TaskChatTab';
import { TaskDiffTab } from '../components/tasks/TaskDiffTab';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { ImpactSubjectRef, TaskTab } from '../lib/appNav';
import { formatRelativeTimeFromIso } from '../lib/format';
import { Button } from '@/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';

export interface TaskViewProps {
  data: DispatchProjectData;
  taskId: string;
  tab: TaskTab;
  activeRunId: string | null;
  onSetTab: (tab: TaskTab) => void;
  /** Dispatches `openTask` with the same task+tab and a new run selected. */
  onSelectRun: (runId: string) => void;
  onBack: () => void;
  /** The exact prop bundle `TaskDetailPanel` needs — shared with the peek dialog so both
   * mounts render identically. `undefined` when the caller's own lookup of `taskId` came up
   * empty; this component's `doc === null` branch below renders the same "gone" state first,
   * so the Details tab never actually needs it in that case. */
  panelProps: TaskDetailPanelProps | undefined;
  /** Opens the run's pull request on the PR review page. */
  onViewPr: (runId: string) => void;
  /** Opens `ImpactView` with a subject preselected — reaches the Diff tab's review case
   * panel, which is where the retired Review page used to offer this. */
  onOpenImpact: (subject: ImpactSubjectRef) => void;
}

/**
 * One task, full-window, with Details/Chat/Diff tabs. Details hosts the same
 * `TaskDetailPanel` the peek dialog uses; Chat hosts `TaskChatTab`; Diff hosts
 * `TaskDiffTab`.
 */
export function TaskView({
  data,
  taskId,
  tab,
  activeRunId,
  onSetTab,
  onSelectRun,
  onBack,
  panelProps,
  onViewPr,
  onOpenImpact,
}: TaskViewProps) {
  const doc =
    data.tasksIncludingArchived.find((t) => t.meta.id === taskId) ?? null;
  const taskRuns = useMemo(
    () =>
      data.runs
        .filter((r) => r.taskId === taskId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [data.runs, taskId]
  );
  const selectedRun = taskRuns.find((r) => r.id === activeRunId);
  if (doc === null)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-muted-foreground text-[13px]">
          That task is no longer available.
        </p>
        <Button size="sm" onClick={onBack}>
          Back
        </Button>
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border flex shrink-0 items-center gap-2 border-b pb-2">
        <Button variant="ghost" size="xs" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-3.5" />
        </Button>
        <span className="text-muted-foreground font-mono text-[11px]">
          {doc.meta.id}
        </span>
        <span className="min-w-0 truncate text-[13px] font-medium">
          {doc.meta.title}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {tab !== 'details' && taskRuns.length > 0 && (
            <Select value={selectedRun?.id ?? ''} onValueChange={onSelectRun}>
              <SelectTrigger size="sm" className="h-7 text-[12px]">
                {selectedRun !== undefined ? (
                  <span className="flex items-center gap-1.5">
                    <RunStatePill meta={selectedRun} />
                    <span className="font-mono text-[11px]">
                      {selectedRun.id}
                    </span>
                  </span>
                ) : (
                  'Pick a session'
                )}
              </SelectTrigger>
              <SelectContent>
                {taskRuns.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <RunStatePill meta={r} />
                    <span className="font-mono text-[11px]">{r.id}</span>
                    <span className="text-muted-foreground text-[11px]">
                      {formatRelativeTimeFromIso(r.updatedAt)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Tabs value={tab} onValueChange={(v) => onSetTab(v as TaskTab)}>
            <TabsList>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="diff">Diff</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col pt-3">
        {tab === 'details' && panelProps !== undefined && (
          <div className="border-border min-h-0 flex-1 overflow-hidden rounded-lg border">
            <ErrorBoundary label="this view">
              <TaskDetailPanel {...panelProps} />
            </ErrorBoundary>
          </div>
        )}
        {tab === 'chat' && (
          <ErrorBoundary label="this tab">
            <TaskChatTab
              data={data}
              doc={doc}
              selectedRun={selectedRun}
              onDispatch={() => void data.handleDispatch(doc.meta.id)}
            />
          </ErrorBoundary>
        )}
        {tab === 'diff' && (
          <ErrorBoundary label="this tab">
            <TaskDiffTab
              data={data}
              selectedRun={selectedRun}
              onViewPr={onViewPr}
              onOpenImpact={onOpenImpact}
            />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
