import type { RepoPr, RunMeta, RunQuestion } from '@dispatch/client';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TaskTab } from '../../lib/appNav';
import { deriveFeedState } from '../../lib/feedState';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { buildLiveRail } from '../../lib/liveRail';
import { Button } from '@/ui/button';
import { StateDot } from '@/ui/chrome/StateDot';

// Persists whether the rail is collapsed to a slim strip. `dispatch:overview-rail` — the key
// the retired MiniOverview used for its own open/closed flag — is deliberately NOT read here:
// that flag meant "hidden entirely", which this rail never is, so honouring it would collapse
// the rail for everyone who ever hid the old one.
const LIVE_RAIL_STORAGE_KEY = 'dispatch:live-rail';

function readStoredLiveRailCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(LIVE_RAIL_STORAGE_KEY) === '1';
}

/**
 * The rail's collapsed preference, kept beside the rail it describes and applied by App, which
 * owns where the rail sits in the shell row. Same '1'/'0' encoding as the sidebar's own
 * collapse preference, so the two read alike in devtools.
 */
export function useLiveRailCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(readStoredLiveRailCollapsed);
  useEffect(() => {
    window.localStorage.setItem(LIVE_RAIL_STORAGE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);
  const set = useCallback((next: boolean) => setCollapsed(next), []);
  return [collapsed, set];
}

interface LiveRailProps {
  runs: RunMeta[];
  repoPrs: RepoPr[];
  openQuestions: ReadonlyMap<string, RunQuestion[]>;
  /** Opens the full task view on a run's chat tab — `openTaskView` in App.tsx. */
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  /** Navigates to the Inbox project view. */
  onOpenInbox: () => void;
  /** Whether the rail is showing as a slim strip rather than its full width. */
  collapsed: boolean;
  onSetCollapsed: (next: boolean) => void;
}

/**
 * The rail that replaced `MiniOverview`: always mounted, always showing one
 * row per currently-running agent, rather than only appearing once something
 * needs a person. The attention strip on top is the part that comes and
 * goes — it is the only thing here that still asks for you.
 *
 * Collapsing narrows it to a strip rather than hiding it: at the window's
 * 1040px floor a fixed 240px rail leaves a task's Diff column too little to
 * read, but a rail you can lose entirely stops being somewhere you look. The
 * attention count survives the collapse for the same reason.
 */
export function LiveRail({
  runs,
  repoPrs,
  openQuestions,
  onOpenTask,
  onOpenInbox,
  collapsed,
  onSetCollapsed,
}: LiveRailProps) {
  const { attentionCount, live } = useMemo(
    () => buildLiveRail(runs, repoPrs, openQuestions),
    [runs, repoPrs, openQuestions]
  );

  if (collapsed) {
    return (
      <aside className="shadow-hairline-left bg-background flex w-9 shrink-0 flex-col items-center gap-2 py-3">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label="Expand the live agents rail"
          title="Expand the live agents rail"
          onClick={() => onSetCollapsed(false)}
          className="size-6 p-0"
        >
          <PanelRightOpen className="size-3.5" />
        </Button>
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
      </aside>
    );
  }

  return (
    <aside className="shadow-hairline-left bg-background flex w-60 shrink-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <span className="dense-label">Live agents</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label="Collapse the live agents rail"
          title="Collapse the live agents rail"
          onClick={() => onSetCollapsed(true)}
          className="ml-auto size-6 p-0"
        >
          <PanelRightClose className="size-3.5" />
        </Button>
      </div>

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
        <div className="flex flex-col gap-0.5">
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
    </aside>
  );
}
