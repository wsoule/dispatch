import type { ApiClient, RunMeta, RunState } from '@dispatch/client';
import { ChevronRight, Radio } from 'lucide-react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { Skeleton } from '@/ui/skeleton';

interface AllAgentsViewProps {
  /** Every non-terminal run for this project, newest-first — see `App.tsx`'s `liveRuns`
   * memo, computed once from `useDispatchProject`'s own run list rather than a separate
   * cross-project fan-out (the old `useAllAgents`, which `ensure_dispatchd`'d a sidecar per
   * dispatch-enabled project it could find). There's only one project now, so this is just
   * that project's live runs. */
  liveRuns: RunMeta[];
  portLoading: boolean;
  portError: boolean;
  portErrorDetail: unknown;
  client: ApiClient | null;
  onRetry: () => void;
  onJumpToRun: (runId: string) => void;
}

/** Status renders as a small colored dot rather than a text pill — `running` pulses to read
 * as genuinely live (respecting `prefers-reduced-motion` via `motion-reduce:animate-none`),
 * every other state is a flat dot. */
function statusDotClass(state: RunState): string {
  switch (state) {
    case 'provisioning':
      return 'bg-muted-foreground/40';
    case 'running':
      return 'bg-primary animate-pulse motion-reduce:animate-none';
    case 'awaiting-approval':
      return 'bg-amber-500';
    case 'finished':
      return 'bg-emerald-500';
    case 'failed':
      return 'bg-red-500';
    case 'cancelled':
      return 'bg-muted-foreground/40';
  }
}

/**
 * "What is this project's agent doing right now" — every live (non-terminal) run for the
 * active project, independent of which primary nav view (Board/Tasks/Runs/Plans) happens to
 * be showing. Clicking a row jumps straight to the Runs view with that run already selected.
 */
export function AllAgentsView({
  liveRuns,
  portLoading,
  portError,
  portErrorDetail,
  client,
  onRetry,
  onJumpToRun,
}: AllAgentsViewProps) {
  if (portLoading) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-foreground text-[15px] font-medium">All Agents</h1>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    );
  }

  if (portError || client === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-foreground text-[15px] font-medium">All Agents</h1>
        <DaemonUnavailable
          starting={false}
          errorDetail={portErrorDetail}
          onRetry={onRetry}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-foreground text-[15px] font-medium">All Agents</h1>

      {liveRuns.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Radio className="text-muted-foreground size-5" />
          <p className="text-muted-foreground max-w-sm text-[13px]">
            No agents are running right now — dispatch a task from the Board to
            start one.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {liveRuns.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onJumpToRun(run.id)}
              className="group border-border bg-card hover:bg-accent/40 flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors"
            >
              <span
                className={`size-1.5 flex-shrink-0 rounded-full ${statusDotClass(run.state)}`}
                aria-hidden="true"
              />
              <span className="text-foreground min-w-0 flex-1 truncate text-[13px]">
                {run.taskTitle}
              </span>
              <span className="text-muted-foreground text-[11px]">
                {run.state}
              </span>
              {run.costUsd !== undefined && (
                <span className="text-muted-foreground font-mono text-[11px]">
                  ${run.costUsd.toFixed(2)}
                </span>
              )}
              <ChevronRight className="text-muted-foreground size-3.5 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
