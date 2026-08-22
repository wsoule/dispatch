import type { RepoPr, RunMeta, RunQuestion } from '@dispatch/client';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { WardenSession } from '../../hooks/useWardenSession';
import type { TaskTab } from '../../lib/appNav';
import { deriveFeedState } from '../../lib/feedState';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { buildLiveRail } from '../../lib/liveRail';
import { WardenChat } from '../chat/WardenChat';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { StateDot } from '@/ui/chrome/StateDot';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';

// Persists whether the rail is collapsed to a slim strip. `dispatch:overview-rail` — the key
// the retired MiniOverview used for its own open/closed flag — is deliberately NOT read here:
// that flag meant "hidden entirely", which this rail never is, so honouring it would collapse
// the rail for everyone who ever hid the old one.
const LIVE_RAIL_STORAGE_KEY = 'dispatch:live-rail';

// Which tab the expanded rail is on, persisted beside the collapse flag so
// expanding lands back on whatever you were last looking at.
const LIVE_RAIL_TAB_STORAGE_KEY = 'dispatch:live-rail-tab';

type LiveRailTab = 'runs' | 'warden';

function readStoredLiveRailCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(LIVE_RAIL_STORAGE_KEY) === '1';
}

function readStoredLiveRailTab(): LiveRailTab {
  if (typeof window === 'undefined') return 'runs';
  return window.localStorage.getItem(LIVE_RAIL_TAB_STORAGE_KEY) === 'warden'
    ? 'warden'
    : 'runs';
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
  /** The App-mounted warden session the rail's Warden tab renders — the same
   * object WardenView gets, so both surfaces show one conversation. */
  warden: WardenSession;
  /** Whether dispatchd is up and the client is live. When it isn't, the Warden
   * tab explains instead of rendering a composer whose first Ask would throw —
   * the same gate WardenView applies with DaemonUnavailable. */
  daemonReady: boolean;
  /** Opens the full task view on a run's chat tab — `openTaskView` in App.tsx. */
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  /** Navigates to the Inbox project view. */
  onOpenInbox: () => void;
  /** Whether the rail is showing as a slim strip rather than its full width. */
  collapsed: boolean;
  onSetCollapsed: (next: boolean) => void;
}

/**
 * The rail that replaced `MiniOverview`: always mounted, with a Runs | Warden
 * toggle at the top. Runs shows one row per currently-running agent; Warden is
 * the same conversation as the full Warden page, rail-sized. The attention
 * strip stays above both — it is the rail's one always-on signal, the only
 * thing here that still asks for you.
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
  warden,
  daemonReady,
  onOpenTask,
  onOpenInbox,
  collapsed,
  onSetCollapsed,
}: LiveRailProps) {
  const { attentionCount, live } = useMemo(
    () => buildLiveRail(runs, repoPrs, openQuestions),
    [runs, repoPrs, openQuestions]
  );

  const [tab, setTab] = useState<LiveRailTab>(readStoredLiveRailTab);
  useEffect(() => {
    window.localStorage.setItem(LIVE_RAIL_TAB_STORAGE_KEY, tab);
  }, [tab]);

  // Once the Warden tab has been opened, its chat stays mounted (hidden) while
  // other tabs show, so a half-typed message survives a glance at Runs. The
  // session itself already lives in App; the composer draft is the one piece
  // of state that would otherwise die with the unmount.
  const [wardenChatMounted, setWardenChatMounted] = useState(
    () => readStoredLiveRailTab() === 'warden'
  );
  useEffect(() => {
    if (tab === 'warden') setWardenChatMounted(true);
  }, [tab]);

  // The warden mid-turn is an agent at work like any run — it earns a Runs-tab
  // row. `recordError` only decides the no-record case: fetch never succeeded
  // (stale id 404s, retry: false) means a broken conversation, not a turn in
  // flight. With a record cached, react-query keeps it through *background*
  // refetch errors, and a running record plus one transient failure is still
  // the warden at work — dropping the row there would flicker on every blip.
  const wardenTurnLive =
    warden.conversationId !== null &&
    (warden.record === undefined
      ? warden.recordError === null
      : warden.record.state === 'running');
  // Mutations queued for the human. A settled turn with a pending action is
  // `state: 'ready'` — idle, not running — so this is a separate signal: the
  // rail must not go quiet while an approval is stranded behind it. Here
  // `recordError` vetoes even a cached record: warden conversations are
  // in-memory in dispatchd, so a failing refetch usually means a restart wiped
  // them, and these signals must not advertise (and the resets must not guard)
  // an action that no longer exists anywhere.
  const wardenPendingCount =
    warden.recordError === null
      ? (warden.record?.pendingActions.length ?? 0)
      : 0;
  // The oldest queued action — what the Runs-tab waiting row describes.
  const firstPendingAction =
    warden.recordError === null ? warden.record?.pendingActions[0] : undefined;
  const wardenRow = wardenTurnLive || wardenPendingCount > 0;
  // What "agents running" means everywhere in this rail: the run rows plus a
  // warden turn in flight — the collapsed strip and the expanded Runs tab must
  // quote the same number.
  const runningCount = live.length + (wardenTurnLive ? 1 : 0);

  if (collapsed) {
    return (
      <aside className="border-border flex w-9 shrink-0 flex-col items-center gap-2 border-l py-3">
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
        {wardenPendingCount > 0 && (
          // A stranded approval must survive the collapse the same way the
          // attention count does; expanding here lands on the confirm card.
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setTab('warden');
              onSetCollapsed(false);
            }}
            aria-label={`${wardenPendingCount} warden action${wardenPendingCount === 1 ? '' : 's'} awaiting approval`}
            title={`${wardenPendingCount} warden action${wardenPendingCount === 1 ? '' : 's'} awaiting approval`}
            className="size-6 rounded-md bg-amber-500/10 p-0 text-[11px] font-medium text-amber-600 dark:text-amber-400"
          >
            {wardenPendingCount}
          </Button>
        )}
        {runningCount > 0 && (
          // The one thing the strip cannot drop: that agents are running at
          // all. A warden turn counts — the expanded Runs tab gives it a row.
          <span
            className="flex flex-col items-center gap-1"
            title={`${runningCount} agent${runningCount === 1 ? '' : 's'} running`}
          >
            <StateDot state="working" pulse />
            <span className="dense-meta">{runningCount}</span>
          </span>
        )}
      </aside>
    );
  }

  return (
    <aside className="border-border flex w-60 shrink-0 flex-col gap-3 border-l p-3">
      <div className="flex items-center gap-2">
        {/* The app's radix Tabs, same as TaskView's Details|Chat|Diff: real
            tab semantics (roving tabindex, arrow keys) — and as role=tab
            these never collide with the sidebar's *button* named "Warden"
            for screen readers or role-scoped e2e locators. */}
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as LiveRailTab)}
          className="w-fit"
        >
          <TabsList aria-label="Live rail sections">
            <TabsTrigger value="runs" className="px-2 text-[12px]">
              Runs
            </TabsTrigger>
            <TabsTrigger value="warden" className="px-2 text-[12px]">
              Warden
              {wardenPendingCount > 0 && (
                // The queued-approval count follows the tab label so a user
                // parked on Runs still sees a mutation is waiting on them.
                <span className="rounded-full bg-amber-500/15 px-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  {wardenPendingCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
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
        // Above the tab content, not inside it: the strip is the rail's one
        // always-on signal and must survive the Warden tab too.
        <button
          type="button"
          onClick={onOpenInbox}
          className="bg-state-waiting/10 text-state-waiting shrink-0 rounded-md px-2 py-1.5 text-left text-[12px] font-medium"
        >
          {attentionCount} waiting on you →
        </button>
      )}

      {tab === 'runs' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {live.length === 0 && !wardenRow ? (
            <p className="text-muted-foreground text-[12px]">
              No agents running.
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {wardenRow && (
                // A warden turn in flight sits with the agents it is one of —
                // and a queued approval keeps a waiting row here. The row
                // describes what actually needs you: the pending action's own
                // summary and queue time when one exists, the conversation's
                // opening prompt and start only while it is merely thinking.
                // Its "task view" is the rail's own Warden tab.
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setTab('warden')}
                  className="h-auto w-full justify-start gap-2 rounded-md px-1.5 py-1 text-left font-normal"
                >
                  <StateDot
                    state={firstPendingAction ? 'waiting' : 'working'}
                    pulse={firstPendingAction === undefined}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {firstPendingAction?.summary ??
                      warden.record?.prompt ??
                      'Warden'}
                  </span>
                  <span className="dense-meta shrink-0 capitalize">warden</span>
                  {warden.record !== undefined && (
                    <span className="dense-meta shrink-0">
                      {formatRelativeTimeFromIso(
                        firstPendingAction?.createdAt ?? warden.record.createdAt
                      )}
                    </span>
                  )}
                </Button>
              )}
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
      )}

      {tab === 'warden' && !daemonReady && (
        <p className="text-muted-foreground text-[12px]">
          The dispatch daemon isn't available, and the warden needs it. The
          Warden page has the details and a retry.
        </p>
      )}

      {daemonReady && wardenChatMounted && (
        // Kept mounted once opened — `hidden`, not unmounted, on the Runs tab
        // so the composer draft survives switching away and back. `visible`
        // tells the chat when it regains a layout box: scroll pinning is a
        // no-op inside display:none (scrollHeight is 0 there).
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            tab !== 'warden' && 'hidden'
          )}
        >
          <WardenChat warden={warden} compact visible={tab === 'warden'} />
        </div>
      )}
    </aside>
  );
}
