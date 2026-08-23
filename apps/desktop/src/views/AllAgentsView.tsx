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
import { deriveFeedState, feedStateToTaskRowState } from '../lib/feedState';
import { formatRelativeTimeFromIso } from '../lib/format';
import { runKindLabel } from '../lib/liveRail';
import { modelDisplayName } from '../lib/models';
import type { RunStateBucket } from '../lib/runState';
import { runStateBucket } from '../lib/runState';
import { cn } from '@/lib/utils';
import { type FilterChipOption, FilterChips } from '@/ui/ai/filter-table';
import { TaskRow, TaskRowList } from '@/ui/ai/task-rows';
import { Button } from '@/ui/button';
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

/** The one filter control, in the order work moves through it — rendered via `FilterChips`,
 * but driven as a single-select tab group rather than a true multi-toggle: `onToggle` always
 * replaces the active id outright (never adds to/removes from it), and an explicit "All" chip
 * stands in for "no filter" rather than `FilterChips`' own empty-selection convention, since
 * this control has always shown exactly one bucket at a time. */
const STATE_FILTERS: FilterChipOption[] = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'needs-review', label: 'Needs review' },
  { id: 'closed', label: 'Closed' },
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

/** Turns and spend folded into TaskRow's one free-text `progress` slot ("12t · $0.42") —
 * cost had its own column before the reskin, and a spend outlier should still be scannable
 * down this list. */
function runProgress(run: RunMeta): string | undefined {
  const parts = [
    run.turns !== undefined ? `${String(run.turns)}t` : undefined,
    run.costUsd !== undefined ? `$${run.costUsd.toFixed(2)}` : undefined,
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
        <span className="text-muted-foreground text-[12px]">
          Every agent this repo has run — task runs, planners, drafts and
          wardens
          {archivedRunCount > 0 && ` · ${archivedRunCount} archived`}
        </span>
        <div className="flex-1" />
        {/* One control, four buckets — deliberately not a search box: this page is scanned
            down a column, and the question it gets asked is "what is still owed", not
            "where is that one run". */}
        <FilterChips
          options={STATE_FILTERS}
          active={[stateFilter]}
          onToggle={(id) => setStateFilter(id as RunStateBucket | 'all')}
        />
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
        <div className="flex flex-col gap-2">
          <TaskRowList>
            {shown.map((entry) => {
              if (entry.row === 'session') {
                const { session } = entry;
                return (
                  // Not clickable: a conversation agent has no run detail page to jump to —
                  // its own surface (Plans, the drafts tray, Warden) owns the full record.
                  <TaskRow
                    key={entry.key}
                    title={session.title}
                    agent={AGENT_SESSION_KIND_LABEL[session.kind]}
                    state={feedStateToTaskRowState(
                      agentSessionFeedState(session)
                    )}
                    elapsedLabel={formatRelativeTimeFromIso(session.updatedAt)}
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
                      className={cn(
                        'size-auto shrink-0 p-1',
                        archived
                          ? 'text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
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
