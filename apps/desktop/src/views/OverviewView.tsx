import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  MoreHorizontal,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { ControlRibbon } from '../components/overview/ControlRibbon';
import { FeedFilterBar } from '../components/overview/FeedFilterBar';
import type { FeedRowActions } from '../components/overview/FeedRow';
import { FeedRow } from '../components/overview/FeedRow';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { buildFeed, FEED_GROUPS } from '../lib/controlRoom';
import type { FeedState } from '../lib/feedState';
import { FEED_STATE_LABEL, isUrgentState } from '../lib/feedState';
import { cn } from '@/lib/utils';
import { StateDot } from '@/ui/chrome/StateDot';

interface OverviewViewProps {
  data: DispatchProjectData;
  projectName: string | null;
  onOpenRun: (runId: string) => void;
  /** Opens the full-page Review for a run — where a diff gets read and annotated, as opposed
   * to the Runs surface, which is where a live agent gets watched. */
  onReviewRun: (runId: string) => void;
  onGoToBoard: () => void;
}

/** Toggles membership without mutating — every filter control here does this. */
function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/**
 * The Control room — the app's landing view and its answer to "what the hell is going on with
 * my agents."
 *
 * Three bands: a seven-counter ribbon, a filter bar, and one continuous feed grouped by state.
 * The feed replaces the old grid of per-bucket cards for one reason — a card grid answers "how
 * many" but never "what is happening", and its silent per-bucket slicing hid exactly the rows
 * you needed once a repo had more than a handful of agents. Here every group states its true
 * count, caps explicitly, and puts the remainder one click away.
 *
 * Every row is one click from the surface that acts on it, and urgent rows carry enough context
 * to be acted on without leaving at all.
 */
export function OverviewView({
  data,
  projectName,
  onOpenRun,
  onReviewRun,
  onGoToBoard,
}: OverviewViewProps) {
  const [query, setQuery] = useState('');
  const [activeStates, setActiveStates] = useState<ReadonlySet<FeedState>>(
    new Set()
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<FeedState>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<FeedState>>(new Set());

  const feed = useMemo(
    () =>
      buildFeed({
        runs: data.runs,
        tasks: data.tasks,
        epics: data.epics,
        readyIds: data.readyIds,
        blockedIds: data.blockedIds,
        mergeQueue: data.mergeQueue,
        pendingApprovals: data.pendingApprovals,
        openQuestions: data.openQuestions,
        query,
        activeStates,
        collapsed,
        expanded,
      }),
    [
      data.runs,
      data.tasks,
      data.epics,
      data.readyIds,
      data.blockedIds,
      data.mergeQueue,
      data.pendingApprovals,
      data.openQuestions,
      query,
      activeStates,
      collapsed,
      expanded,
    ]
  );

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  // Ready and blocked aren't in the feed — they're tasks, not runs — so their ribbon cells
  // navigate to where you can act on them rather than filtering a feed they'd never appear in.
  function selectRibbon(state: FeedState) {
    if (state === 'ready' || state === 'blocked') {
      onGoToBoard();
      return;
    }
    setActiveStates((prev) => toggle(prev, state));
  }

  const actions: FeedRowActions = {
    onOpen: (row) => onOpenRun(row.runId),
    onApprove: (row, allow) => {
      const pending = data.pendingApprovals.get(row.runId);
      // Without the request id there is nothing to answer — this window never saw the
      // approval.requested event (a reload drops it), so open the run, where the log can
      // recover it, rather than firing a decision at a request we cannot name.
      if (pending === undefined) {
        onOpenRun(row.runId);
        return;
      }
      void data.handleApprove(row.runId, pending.requestId, allow);
    },
    onRetry: (row) => void data.handleDispatch(row.taskId),
    onReview: (row) => onReviewRun(row.runId),
    onCancelLanding: (row) => void data.handleDequeueMerge(row.runId),
  };

  const allCollapsed = collapsed.size >= FEED_GROUPS.length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-baseline gap-2">
        <h1 className="view-topbar-title">Control room</h1>
        {projectName !== null && (
          <span className="text-muted-foreground text-[13px]">
            {projectName}
          </span>
        )}
        <span className="text-muted-foreground text-[12px]">
          {feed.counts.working} working · {feed.counts.waiting} waiting on you
        </span>
      </div>

      <ControlRibbon
        counts={feed.counts}
        activeStates={activeStates}
        onSelect={selectRibbon}
      />

      <FeedFilterBar
        query={query}
        onQueryChange={setQuery}
        activeStates={activeStates}
        onClearStates={() => setActiveStates(new Set())}
        shown={feed.shown}
        total={feed.total}
        allCollapsed={allCollapsed}
        onToggleCollapseAll={() =>
          setCollapsed(allCollapsed ? new Set() : new Set(FEED_GROUPS))
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {feed.groups.length === 0 ? (
          <EmptyFeed filtered={query !== '' || activeStates.size > 0} />
        ) : (
          feed.groups.map((group) => (
            <section key={group.state} className="mb-1">
              <button
                type="button"
                onClick={() =>
                  setCollapsed((prev) => toggle(prev, group.state))
                }
                className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 px-1 pt-3 pb-1.5 transition-colors duration-150"
              >
                {group.collapsed ? (
                  <ChevronRight className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
                <StateDot state={group.state} pulse={false} />
                <span
                  className={cn(
                    'dense-label',
                    isUrgentState(group.state) && 'text-foreground'
                  )}
                >
                  {FEED_STATE_LABEL[group.state]}
                </span>
                <span className="dense-meta">{group.total}</span>
                <span
                  aria-hidden
                  className="ml-1 h-px flex-1 bg-[linear-gradient(to_right,var(--border-default),transparent_70%)]"
                />
              </button>

              <div className="flex flex-col gap-0.5">
                {group.rows.map((row) => (
                  <FeedRow key={row.runId} row={row} actions={actions} />
                ))}
              </div>

              {group.hidden > 0 && (
                <ShowMore
                  label={`Show the other ${group.hidden} ${FEED_STATE_LABEL[
                    group.state
                  ].toLowerCase()}`}
                  onClick={() =>
                    setExpanded((prev) => toggle(prev, group.state))
                  }
                />
              )}
              {expanded.has(group.state) && (
                <ShowMore
                  label="Collapse back"
                  onClick={() =>
                    setExpanded((prev) => toggle(prev, group.state))
                  }
                />
              )}
            </section>
          ))
        )}
      </div>

      <div className="flex justify-center pb-1">
        <button
          type="button"
          onClick={onGoToBoard}
          className="text-muted-foreground hover:text-foreground text-[12px]"
        >
          Open the board
        </button>
      </div>
    </div>
  );
}

function ShowMore({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground hover:bg-muted/40 mt-0.5 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12px] transition-colors duration-150"
    >
      <MoreHorizontal className="size-3.5" />
      {label}
    </button>
  );
}

/** Distinguishes "you filtered everything out" from "nothing is running" — the second is good
 * news and has to read that way rather than as a broken screen. */
function EmptyFeed({ filtered }: { filtered: boolean }) {
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 py-6 text-[12.5px]">
      <CircleCheck className="size-4" />
      {filtered
        ? 'Nothing matches that filter.'
        : 'No agents are running and nothing is waiting on you.'}
    </div>
  );
}
