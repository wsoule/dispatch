import type { AgentSessionMeta, ApiClient, RunMeta } from '@dispatch/client';
import { Archive, Radio } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { runStateLabel } from '../components/tasks/RunStateIcon';
import {
  AGENT_SESSION_KIND_LABEL,
  agentSessionBucket,
  agentSessionFeedState,
} from '../lib/agentSessions';
import { showArchiveToggle } from '../lib/archiveToggle';
import { deriveFeedState, feedStateToTaskRowState } from '../lib/feedState';
import { formatRelativeTimeFromIso } from '../lib/format';
import { runKindLabel } from '../lib/liveRail';
import { modelDisplayName } from '../lib/models';
import type { RunStateBucket } from '../lib/runState';
import { runStateBucket } from '../lib/runState';
import { subagentSummaryLabel } from '../lib/subagentSummary';
import { cn } from '@/lib/utils';
import { PageHeader, type ViewTab, ViewTabs } from '@/ui/ai/page-header';
import { TaskRow, TaskRowList } from '@/ui/ai/task-rows';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { Skeleton } from '@/ui/skeleton';

interface AllAgentsViewProps {
  /** Every run for this project, newest-first — including terminal ones, minus whatever the
   * archive filter is holding back (`visibleRuns`). This view used to take only live runs,
   * but the question it answers is "what has this repo actually done", and a history that
   * silently omits the runs you killed answers it dishonestly. Archiving is the one
   * exception, because it is an explicit act by the person reading this list. */
  runs: RunMeta[];
  /** Every in-memory conversation agent — planner chats, "add detail" enrich agents, task
   * drafts and overseer chats. The other half of "all agents": these never appear in `runs`
   * (they have no worktree and no RunMeta), so before this prop existed a planner reading
   * the repo was invisible on the very page named after it. */
  sessions: AgentSessionMeta[];
  /** How many runs the archive filter is holding back right now — independent of the toggle,
   * so the control can still say what turning it on would reveal. */
  archivedRunCount: number;
  /** The project-wide show-archived preference, shared with the Board and Tasks list. */
  showArchived: boolean;
  onSetShowArchived: (next: boolean) => void;
  /** Archives or unarchives one run. This is the only surface that offers it since the Runs
   * page was retired — without it an already-archived run could never be brought back. */
  onArchiveRun: (runId: string, archived: boolean) => void;
  portLoading: boolean;
  portError: boolean;
  portErrorDetail: unknown;
  client: ApiClient | null;
  onRetry: () => void;
  onJumpToRun: (runId: string) => void;
  /** Opens the Live page (every container with work moving), the header's
   * "Live" link; the page has no sidebar row of its own. */
  onOpenLive?: () => void;
}

/** The one filter control, in the order work moves through it — the header's view tabs,
 * exactly one bucket at a time, with an explicit "All" tab standing in for "no filter". */
const STATE_FILTERS: ViewTab[] = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'needs-review', label: 'Needs review' },
  { id: 'closed', label: 'Closed' },
  // Runs whose agent fanned out into sub-agents — the fleets, whatever state
  // they are in now. Conversation agents never fan out, so the chip hides them.
  { id: 'fan-out', label: 'Fan-out' },
];

type AgentFilter = RunStateBucket | 'all' | 'fan-out';

/** Whether a run matches the active chip. */
function runMatchesFilter(run: RunMeta, filter: AgentFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'fan-out') {
    return run.subagents !== undefined && run.subagents.total > 0;
  }
  return runStateBucket(run) === filter;
}

/** What a review action did, as a past-tense word rather than the raw enum. */
const REVIEW_ACTION_LABEL: Record<
  NonNullable<RunMeta['reviewAction']>,
  string
> = {
  merge: 'merged',
  discard: 'discarded',
  pr: 'opened a PR',
};

/** How a run stands, in words — terminal runs get their outcome, live ones the same
 * whose-move label the run glyphs use everywhere else. Raw enum strings like
 * 'awaiting-approval' or 'interrupted-dirty' never reach the row. */
function outcomeLabel(run: RunMeta): string {
  if (run.state === 'cancelled') return 'killed';
  if (run.state === 'failed') return 'failed';
  if (run.state === 'interrupted-dirty') return 'interrupted';
  if (run.state === 'finished') {
    if (run.reviewedAt === undefined) return 'finished';
    return run.reviewAction !== undefined
      ? REVIEW_ACTION_LABEL[run.reviewAction]
      : 'closed';
  }
  return runStateLabel(run.state).toLowerCase();
}

/** Turns, spend and fan-out folded into TaskRow's one free-text `progress` slot
 * ("12t · $0.42 · 3/8 agents live") — cost had its own column before the reskin, and a spend
 * outlier or a fleet should still be scannable down this list. */
function runProgress(run: RunMeta): string | undefined {
  const parts = [
    run.turns !== undefined ? `${String(run.turns)}t` : undefined,
    run.costUsd !== undefined ? `$${run.costUsd.toFixed(2)}` : undefined,
    subagentSummaryLabel(run.subagents) ?? undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** One row of the merged list: a task run, or an in-memory conversation agent. Keys are
 * prefixed because the two id spaces are owned by different registries and nothing
 * guarantees they never collide. */
type AgentRow =
  | { key: string; row: 'run'; updatedAt: string; run: RunMeta }
  | {
      key: string;
      row: 'session';
      updatedAt: string;
      session: AgentSessionMeta;
    };

/**
 * Every agent this repo has run: task runs (including the ones you killed) merged with the
 * conversation agents — planners, "add detail" drafters, task drafts, overseers.
 *
 * A dense table rather than cards, because the value here is scanning down a column: turns and
 * spend line up so an outlier is visible without reading a single row. Terminal runs recede but
 * are never filtered out — a history that hides its failures is not a history. Conversation
 * agents are in-memory, so their half of the list only reaches back to the daemon's last start.
 */
export function AllAgentsView({
  runs,
  sessions,
  archivedRunCount,
  showArchived,
  onSetShowArchived,
  onArchiveRun,
  portLoading,
  portError,
  portErrorDetail,
  client,
  onRetry,
  onJumpToRun,
  onOpenLive,
}: AllAgentsViewProps) {
  const [showAll, setShowAll] = useState(false);
  const [stateFilter, setStateFilter] = useState<AgentFilter>('all');

  // Newest first, so the agent you just started is the one you are looking at.
  const ordered = useMemo(() => {
    const rows: AgentRow[] = [
      ...runs
        .filter((run) => runMatchesFilter(run, stateFilter))
        .map(
          (run): AgentRow => ({
            key: `run:${run.id}`,
            row: 'run',
            updatedAt: run.updatedAt,
            run,
          })
        ),
      ...sessions
        .filter(
          (session) =>
            stateFilter === 'all' ||
            (stateFilter !== 'fan-out' &&
              agentSessionBucket(session) === stateFilter)
        )
        .map(
          (session): AgentRow => ({
            key: `session:${session.id}`,
            row: 'session',
            updatedAt: session.updatedAt,
            session,
          })
        ),
    ];
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [runs, sessions, stateFilter]);
  const shown = showAll ? ordered : ordered.slice(0, 25);

  // Stays visible whenever it is on, or turning it on would remove the only control
  // that turns it off — and with it the only way back to an archived run.
  const archiveToggle = showArchiveToggle(showArchived, archivedRunCount) ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onSetShowArchived(!showArchived)}
    >
      {showArchived
        ? 'Hide archived'
        : `Show archived (${String(archivedRunCount)})`}
    </Button>
  ) : undefined;

  // The way to the Live page, which draws the runs in motion as bands with
  // their Flight Plans; quiet, since it leaves this page.
  const liveLink =
    onOpenLive === undefined ? undefined : (
      <Button variant="link" size="sm" onClick={onOpenLive}>
        Live
      </Button>
    );
  const actions =
    liveLink === undefined && archiveToggle === undefined ? undefined : (
      <>
        {liveLink}
        {archiveToggle}
      </>
    );

  // The header carries the one control, four buckets — deliberately not a search box:
  // this page is scanned down a column, and the question it gets asked is "what is still
  // owed", not "where is that one run".
  const header = (
    <PageHeader
      crumb={['All agents']}
      actions={actions}
      tabs={
        <ViewTabs
          label="Agent state"
          tabs={STATE_FILTERS}
          active={stateFilter}
          onChange={(id) => setStateFilter(id as AgentFilter)}
        />
      }
    />
  );

  if (portLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="flex flex-col gap-2 px-6 py-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
    );
  }

  if (portError || client === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="px-6 py-4">
          <DaemonUnavailable
            starting={false}
            errorDetail={portErrorDetail}
            onRetry={onRetry}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
        {ordered.length === 0 ? (
          <EmptyState
            icon={Radio}
            heading={
              runs.length + sessions.length > 0
                ? 'No agents match this filter'
                : 'No agents have run yet'
            }
            description={
              runs.length + sessions.length > 0
                ? undefined
                : archivedRunCount > 0
                  ? 'Every run here is archived — turn on Show archived to see them.'
                  : 'Dispatch a task from the board to start one.'
            }
            className="flex-1"
          />
        ) : (
          <div className="flex flex-col gap-2">
            <TaskRowList>
              {shown.map((entry) => {
                if (entry.row === 'session') {
                  const { session } = entry;
                  return (
                    // Not clickable: a conversation agent has no run detail page to jump to —
                    // its own surface (Plans, the drafts tray, Overseer) owns the full record.
                    <TaskRow
                      key={entry.key}
                      title={session.title}
                      agent={AGENT_SESSION_KIND_LABEL[session.kind]}
                      state={feedStateToTaskRowState(
                        agentSessionFeedState(session)
                      )}
                      elapsedLabel={formatRelativeTimeFromIso(
                        session.updatedAt
                      )}
                    />
                  );
                }
                const { run } = entry;
                // A closed-out run has no feed state (deriveFeedState returns null — it is
                // nobody's turn) — reads as `done`, same bucket a needs-review/landing run
                // lands in (see `feedStateToTaskRowState`).
                const feedState = deriveFeedState(run);
                const kind = runKindLabel(run);
                const archived = run.archivedAt !== undefined;
                return (
                  <TaskRow
                    key={entry.key}
                    title={run.taskTitle}
                    // Only the runs a person did not dispatch by hand: labelling every plain
                    // agent run 'agent' would be a column of the same word, so those fall back
                    // to the model name instead.
                    agent={
                      kind !== 'agent'
                        ? kind
                        : (modelDisplayName(run.model) ?? '')
                    }
                    state={
                      feedState === null
                        ? 'done'
                        : feedStateToTaskRowState(feedState)
                    }
                    detail={outcomeLabel(run)}
                    progress={runProgress(run)}
                    elapsedLabel={formatRelativeTimeFromIso(run.updatedAt)}
                    onClick={() => onJumpToRun(run.id)}
                    actions={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-pressed={archived}
                        onClick={(e) => {
                          e.stopPropagation();
                          onArchiveRun(run.id, !archived);
                        }}
                        aria-label={
                          archived
                            ? `Unarchive ${run.taskTitle}`
                            : `Archive ${run.taskTitle}`
                        }
                        className={cn(archived && 'text-foreground')}
                      >
                        <Archive className="size-3.5" />
                      </Button>
                    }
                  />
                );
              })}
            </TaskRowList>

            {ordered.length > shown.length && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(true)}
                className="justify-start px-3"
              >
                Show all {ordered.length}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
