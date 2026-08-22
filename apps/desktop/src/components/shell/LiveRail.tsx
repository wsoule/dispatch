import type { RepoPr, RunMeta, RunQuestion } from '@dispatch/client';
import { useMemo } from 'react';

import type { TaskTab } from '../../lib/appNav';
import { deriveFeedState } from '../../lib/feedState';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { buildLiveRail } from '../../lib/liveRail';
import { Button } from '@/ui/button';
import { StateDot } from '@/ui/chrome/StateDot';

interface LiveRailProps {
  runs: RunMeta[];
  repoPrs: RepoPr[];
  openQuestions: ReadonlyMap<string, RunQuestion[]>;
  /** Opens the full task view on a run's chat tab — `openTaskView` in App.tsx. */
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  /** Navigates to the Inbox project view. */
  onOpenInbox: () => void;
  /** Whether the sidebar hosting this section is collapsed to its icon-only strip. */
  collapsed: boolean;
}

/**
 * The live-agents section of the left sidebar (it was a standalone right-hand rail until the
 * shell consolidated on one rail): one row per currently-running agent, with the attention
 * strip on top as the only part that comes and goes — it is the only thing here that still
 * asks for you. In the collapsed icon strip it narrows to the two essentials: the attention
 * count and that agents are running at all.
 */
export function LiveRail({
  runs,
  repoPrs,
  openQuestions,
  onOpenTask,
  onOpenInbox,
  collapsed,
}: LiveRailProps) {
  const { attentionCount, live } = useMemo(
    () => buildLiveRail(runs, repoPrs, openQuestions),
    [runs, repoPrs, openQuestions]
  );

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 pb-2">
        {attentionCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onOpenInbox}
            aria-label={`${attentionCount} waiting on you`}
            title={`${attentionCount} waiting on you`}
            className="bg-state-waiting/10 text-state-waiting size-6 rounded-md p-0 text-[11px] font-medium"
          >
            {attentionCount}
          </Button>
        )}
        {live.length > 0 && (
          // The one thing the strip cannot drop: that agents are running at all.
          <span
            className="flex flex-col items-center gap-1"
            title={`${live.length} agent${live.length === 1 ? '' : 's'} running`}
          >
            <StateDot state="working" pulse />
            <span className="dense-meta">{live.length}</span>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-2 pb-2">
      <span className="dense-label">Live agents</span>

      {attentionCount > 0 && (
        <button
          type="button"
          onClick={onOpenInbox}
          className="bg-state-waiting/10 text-state-waiting rounded-md px-2 py-1.5 text-left text-[12px] font-medium"
        >
          {attentionCount} waiting on you →
        </button>
      )}

      {live.length === 0 ? (
        <p className="text-muted-foreground text-[12px]">No agents running.</p>
      ) : (
        <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          {live.map(({ run, kindLabel }) => {
            const state = deriveFeedState(run) ?? 'working';
            return (
              <Button
                key={run.id}
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onOpenTask(run.taskId, 'chat', run.id)}
                className="h-auto w-full justify-start gap-2 rounded-md px-1.5 py-1 text-left font-normal"
              >
                <StateDot state={state} pulse={state === 'working'} />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {run.taskTitle}
                </span>
                <span className="dense-meta shrink-0 capitalize">
                  {kindLabel}
                </span>
                <span className="dense-meta shrink-0">
                  {formatRelativeTimeFromIso(run.createdAt)}
                </span>
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
