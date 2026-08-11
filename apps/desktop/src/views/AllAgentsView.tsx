import type { AgentSessionMeta, ApiClient, RunMeta } from '@dispatch/client';
import { Archive, Radio } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import {
  AGENT_SESSION_KIND_LABEL,
  agentSessionBucket,
  agentSessionFeedState,
} from '../lib/agentSessions';
import { showArchiveToggle } from '../lib/archiveToggle';
import { deriveFeedState } from '../lib/feedState';
import { formatRelativeTimeFromIso } from '../lib/format';
import { runKindLabel } from '../lib/liveRail';
import { modelDisplayName } from '../lib/models';
import type { RunStateBucket } from '../lib/runState';
import { runStateBucket } from '../lib/runState';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { IconToggle } from '@/ui/chrome/IconToggle';
import { StateDot } from '@/ui/chrome/StateDot';
import { Skeleton } from '@/ui/skeleton';

interface AllAgentsViewProps {
  /** Every run for this project, newest-first — including terminal ones, minus whatever the
   * archive filter is holding back (`visibleRuns`). This view used to take only live runs,
   * but the question it answers is "what has this repo actually done", and a history that
   * silently omits the runs you killed answers it dishonestly. Archiving is the one
   * exception, because it is an explicit act by the person reading this list. */
  runs: RunMeta[];
  /** Every in-memory conversation agent — planner chats, "add detail" enrich agents, task
   * drafts and warden chats. The other half of "all agents": these never appear in `runs`
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
}

/** Columns, shared by the header strip and every row so the two cannot drift apart. */
const GRID =
  'grid grid-cols-[minmax(160px,1fr)_110px_64px_72px_88px_96px] items-center gap-3';

/** Runs whose row recedes: they are finished business, kept for the record. */
function isPast(run: RunMeta): boolean {
  return runStateBucket(run) === 'closed';
}

/** The one filter control, in the order work moves through it. */
const STATE_FILTERS: { value: RunStateBucket | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'needs-review', label: 'Needs review' },
  { value: 'closed', label: 'Closed' },
];

/** How a terminal run ended, in a word. */
function outcomeLabel(run: RunMeta): string {
  if (run.state === 'cancelled') return 'killed';
  if (run.state === 'failed') return 'failed';
  if (run.state === 'finished') {
    return run.reviewedAt !== undefined
      ? (run.reviewAction ?? 'closed')
      : 'finished';
  }
  return run.state;
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
 * conversation agents — planners, "add detail" drafters, task drafts, wardens.
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
}: AllAgentsViewProps) {
  const [showAll, setShowAll] = useState(false);
  const [stateFilter, setStateFilter] = useState<RunStateBucket | 'all'>('all');

  // Newest first, so the agent you just started is the one you are looking at.
  const ordered = useMemo(() => {
    const rows: AgentRow[] = [
      ...runs
        .filter(
          (run) => stateFilter === 'all' || runStateBucket(run) === stateFilter
        )
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
            stateFilter === 'all' || agentSessionBucket(session) === stateFilter
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

  if (portLoading) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="view-topbar-title">All agents</h1>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
    );
  }

  if (portError || client === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="view-topbar-title">All agents</h1>
        <DaemonUnavailable
          starting={false}
          errorDetail={portErrorDetail}
          onRetry={onRetry}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <div className="flex items-center gap-2">
        <h1 className="view-topbar-title">All agents</h1>
        <span className="text-muted-foreground text-[12px]">
          Every agent this repo has run — task runs, planners, drafts and
          wardens
          {archivedRunCount > 0 && ` · ${archivedRunCount} archived`}
        </span>
        <div className="flex-1" />
        {/* One control, four buckets — deliberately not a search box: this page is scanned
            down a column, and the question it gets asked is "what is still owed", not
            "where is that one run". */}
        <div className="bg-muted/40 flex items-center gap-0.5 rounded-md p-0.5">
          {STATE_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant="ghost"
              size="xs"
              aria-pressed={stateFilter === f.value}
              onClick={() => setStateFilter(f.value)}
              className={cn(
                'h-6 rounded-sm px-2 text-[12px] font-normal',
                stateFilter === f.value
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground'
              )}
            >
              {f.label}
            </Button>
          ))}
        </div>
        {/* Stays visible whenever it is on, or turning it on would remove the only control
            that turns it off — and with it the only way back to an archived run. */}
        {showArchiveToggle(showArchived, archivedRunCount) && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onSetShowArchived(!showArchived)}
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </Button>
        )}
      </div>

      {ordered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Radio className="text-muted-foreground size-5" />
          <p className="text-muted-foreground max-w-sm text-[13px]">
            {runs.length + sessions.length > 0
              ? 'No agents match this filter.'
              : archivedRunCount > 0
                ? 'Every run here is archived — turn on Show archived to see them.'
                : 'No agents have run yet — dispatch a task from the board to start one.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="flex items-center gap-1">
            <div className={cn(GRID, 'dense-label flex-1 px-3 pb-2')}>
              <span>Task</span>
              <span>Model</span>
              <span className="text-right">Turns</span>
              <span className="text-right">Spend</span>
              <span className="text-right">Updated</span>
              <span className="text-right">Outcome</span>
            </div>
            {/* Holds the column the per-row archive toggle sits in, so the header's own
                right-hand column still lines up with Outcome. */}
            <span className="w-7 shrink-0 pb-2" />
          </div>

          {shown.map((entry) => {
            if (entry.row === 'session') {
              const { session } = entry;
              return (
                // Not a button: a conversation agent has no run detail page to jump to —
                // its own surface (Plans, the drafts tray, Warden) owns the full record.
                // Model/turns/spend stay blank because nothing records them for these.
                <div key={entry.key} className="flex items-center gap-1">
                  <div className={cn(GRID, 'flex-1 rounded-md px-3 py-1.5')}>
                    <span className="flex min-w-0 items-center gap-2">
                      <StateDot state={agentSessionFeedState(session)} />
                      <span
                        className={cn(
                          'truncate text-[13px]',
                          session.state === 'failed'
                            ? 'text-muted-foreground'
                            : 'text-foreground'
                        )}
                      >
                        {session.title}
                      </span>
                      <span className="dense-meta shrink-0 capitalize">
                        {AGENT_SESSION_KIND_LABEL[session.kind]}
                      </span>
                    </span>
                    <span className="dense-meta truncate" />
                    <span className="dense-meta text-right" />
                    <span className="dense-meta text-right" />
                    <span className="dense-meta text-right">
                      {formatRelativeTimeFromIso(session.updatedAt)}
                    </span>
                    <span
                      className={cn(
                        'dense-meta text-right',
                        session.state === 'failed' && 'text-state-failed'
                      )}
                    >
                      {session.state}
                    </span>
                  </div>
                  {/* Holds the archive column open — sessions are dismissed from their own
                      surfaces, never archived, but the grid must not drift. */}
                  <span className="w-7 shrink-0" />
                </div>
              );
            }
            const { run } = entry;
            const state = deriveFeedState(run);
            const past = isPast(run);
            const kind = runKindLabel(run);
            const archived = run.archivedAt !== undefined;
            return (
              // A row and its archive control are two separate actions, so they are two
              // sibling buttons rather than one nested inside the other.
              <div key={entry.key} className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onJumpToRun(run.id)}
                  className={cn(
                    GRID,
                    'h-auto flex-1 justify-start rounded-md px-3 py-1.5 text-left text-[length:inherit] font-normal hover:bg-muted/40 hover:text-foreground'
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {/* A closed-out run has no feed state — it is nobody's turn — so it gets
                        the neutral blocked dot rather than being hidden or mislabelled. */}
                    <StateDot state={state ?? 'blocked'} />
                    <span
                      className={cn(
                        'truncate text-[13px]',
                        past ? 'text-muted-foreground' : 'text-foreground'
                      )}
                    >
                      {run.taskTitle}
                    </span>
                    {/* Only the runs a person did not dispatch by hand: labelling every
                        plain agent run 'agent' would be a column of the same word. */}
                    {kind !== 'agent' && (
                      <span className="dense-meta shrink-0 capitalize">
                        {kind}
                      </span>
                    )}
                  </span>
                  <span className="dense-meta truncate">
                    {run.model === undefined ? '' : modelDisplayName(run.model)}
                  </span>
                  <span className="dense-meta text-right">
                    {run.turns ?? ''}
                  </span>
                  <span className="dense-meta text-right">
                    {run.costUsd === undefined
                      ? ''
                      : `$${run.costUsd.toFixed(2)}`}
                  </span>
                  <span className="dense-meta text-right">
                    {formatRelativeTimeFromIso(run.updatedAt)}
                  </span>
                  <span
                    className={cn(
                      'dense-meta text-right',
                      run.state === 'failed' && 'text-state-failed'
                    )}
                  >
                    {outcomeLabel(run)}
                  </span>
                </Button>
                <IconToggle
                  on={archived}
                  onClick={() => onArchiveRun(run.id, !archived)}
                  label={
                    archived
                      ? `Unarchive ${run.taskTitle}`
                      : `Archive ${run.taskTitle}`
                  }
                  className="w-7 shrink-0"
                >
                  <Archive className="size-3.5" />
                </IconToggle>
              </div>
            );
          })}

          {ordered.length > shown.length && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setShowAll(true)}
              className="text-muted-foreground hover:text-foreground h-auto justify-start px-3 py-2 text-left text-[length:inherit] font-normal hover:bg-transparent"
            >
              Show all {ordered.length}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
