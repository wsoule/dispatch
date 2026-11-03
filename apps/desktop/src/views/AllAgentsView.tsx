import type { AgentSessionMeta, ApiClient, RunMeta } from '@dispatch/client';
import type { RegisterColumn, SegmentedOption } from '@dispatch/ui';
import {
  Button,
  Chip,
  EmptyState,
  Register,
  RegisterCell,
  RegisterRow,
  SegmentedControl,
  SkeletonRows,
  ViewToolbar,
} from '@dispatch/ui';
import { Archive, Radio } from 'lucide-react';
import type { ReactNode } from 'react';
import { memo, useMemo, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { StateMark } from '../components/status/StateMark';
import { ShimmerLabel } from '../components/transcript/ShimmerLabel';
import { useEventCallback } from '../hooks/useEventCallback';
import { useMinuteClock } from '../hooks/useMinuteClock';
import {
  AGENT_SESSION_KIND_LABEL,
  agentSessionBucket,
  agentSessionFeedState,
} from '../lib/agentSessions';
import { showArchiveToggle } from '../lib/archiveToggle';
import {
  deriveFeedState,
  FEED_STATE_LABEL,
  isInFlightState,
} from '../lib/feedState';
import { formatRelativeTimeFromIso } from '../lib/format';
import { runKindLabel } from '../lib/liveRail';
import { modelDisplayName } from '../lib/models';
import type { RunStateBucket } from '../lib/runState';
import { closedOutMark, runStateBucket, runStateLabel } from '../lib/runState';
import { subagentSummaryLabel } from '../lib/subagentSummary';
import styles from './AllAgentsView.module.css';

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
  /** Opens the Live page (every container with work moving), the toolbar's
   * "Live" button; the page has no sidebar row of its own. */
  onOpenLive?: () => void;
}

/** The one filter control, in the order work moves through it — a segmented control in the
 * toolbar, exactly one bucket at a time, with an explicit "All" option standing in for "no
 * filter". Each option's count is added at render (`filterCounts`). */
const STATE_FILTERS: readonly { id: AgentFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'needs-review', label: 'Needs review' },
  { id: 'closed', label: 'Closed' },
  // Runs whose agent fanned out into sub-agents — the fleets, whatever state
  // they are in now. Conversation agents never fan out, so the option hides them.
  { id: 'fan-out', label: 'Fan-out' },
];

type AgentFilter = RunStateBucket | 'all' | 'fan-out';

/** Whether a run matches the active filter. */
function runMatchesFilter(run: RunMeta, filter: AgentFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'fan-out') {
    return run.subagents !== undefined && run.subagents.total > 0;
  }
  return runStateBucket(run) === filter;
}

/** Whether a conversation agent matches the active filter: by its bucket, and never under
 * Fan-out, since a conversation never fans out into sub-agents. */
function sessionMatchesFilter(
  session: AgentSessionMeta,
  filter: AgentFilter
): boolean {
  if (filter === 'all') return true;
  return filter !== 'fan-out' && agentSessionBucket(session) === filter;
}

/** How many runs and conversation agents each filter option would show, in one pass over
 * each list and through the same predicates the list itself filters by, so a count never
 * disagrees with the rows its option reveals. */
function filterCounts(
  runs: readonly RunMeta[],
  sessions: readonly AgentSessionMeta[]
): Record<AgentFilter, number> {
  const counts: Record<AgentFilter, number> = {
    all: 0,
    live: 0,
    'needs-review': 0,
    closed: 0,
    'fan-out': 0,
  };
  for (const run of runs) {
    for (const { id } of STATE_FILTERS) {
      if (runMatchesFilter(run, id)) counts[id] += 1;
    }
  }
  for (const session of sessions) {
    for (const { id } of STATE_FILTERS) {
      if (sessionMatchesFilter(session, id)) counts[id] += 1;
    }
  }
  return counts;
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

/** Turns, spend and fan-out folded into one short progress cell ("12t · $0.42 · 3/8 agents
 * live") — cost had its own column before the reskin, and a spend outlier or a fleet should
 * still be scannable down this list. */
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

/** How many rows show before "Show all N": enough to see what is moving now without the
 * whole history rendering on every open. */
const ROW_CAP = 25;

// The subject (state mark, title and agent chip) takes the room; outcome, progress and the
// relative time are short facts; the last column holds the archive button. Every track has a
// fixed or fractional size, because each row is its own grid and only such tracks line up
// down the column. The mark sits in the subject cell rather than a column of its own, so a
// stacked card keeps it beside the title. The minimums add up to 596px with the gaps and
// padding, so the register stacks only below 600px (`stackWithin`): at the default window
// (1200px, sidebar and Settings rail open) it stays a table.
const COLUMNS =
  'minmax(180px, 2.4fr) minmax(88px, 0.8fr) minmax(120px, 1.2fr) 72px 28px';

const HEADER: RegisterColumn[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'outcome', label: 'Outcome' },
  { id: 'progress', label: 'Progress' },
  { id: 'updated', label: 'Updated' },
  { id: 'archive', label: '' },
];

/**
 * Every agent this repo has run: task runs (including the ones you killed) merged with the
 * conversation agents — planners, "add detail" drafters, task drafts, overseers.
 *
 * A dense table rather than cards, because the value here is scanning down a column: turns and
 * spend line up so an outlier is visible without reading a single row. Terminal runs recede but
 * are never filtered out — a history that hides its failures is not a history. Conversation
 * agents are in-memory, so their half of the list only reaches back to the daemon's last start.
 *
 * It is hosted by Settings (SettingsHostedBody, which does not scroll), so the view owns its
 * scroller: the toolbar stays put and only the list scrolls under it.
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
  // Stable handlers and a minute clock for the memoized rows below: the host passes fresh
  // inline handlers on every render (App's `onArchiveRun` is an arrow), which would redraw
  // every row on one run's poll update, and the clock moves each row's relative time once a
  // minute while nothing else changes.
  const jumpToRun = useEventCallback(onJumpToRun);
  const archiveRun = useEventCallback(onArchiveRun);
  const minute = useMinuteClock();

  const options = useMemo((): SegmentedOption[] => {
    const counts = filterCounts(runs, sessions);
    return STATE_FILTERS.map(({ id, label }) => ({
      id,
      label,
      count: counts[id],
    }));
  }, [runs, sessions]);

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
        .filter((session) => sessionMatchesFilter(session, stateFilter))
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
  const shown = showAll ? ordered : ordered.slice(0, ROW_CAP);

  // Stays visible whenever it is on, or turning it on would remove the only control
  // that turns it off — and with it the only way back to an archived run.
  const archiveToggle = showArchiveToggle(showArchived, archivedRunCount) ? (
    <Button
      variant="quiet"
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
      <Button variant="quiet" size="sm" onClick={onOpenLive}>
        Live
      </Button>
    );
  const end =
    liveLink === undefined && archiveToggle === undefined ? undefined : (
      <>
        {liveLink}
        {archiveToggle}
      </>
    );

  // The toolbar carries the one control, five options — deliberately not a search box:
  // this page is scanned down a column, and the question it gets asked is "what is still
  // owed", not "where is that one run".
  const toolbar = (
    <ViewToolbar
      label="Agent state options"
      controls={
        <SegmentedControl
          label="Agent state"
          size="sm"
          options={options}
          value={stateFilter}
          onChange={(id) => setStateFilter(id as AgentFilter)}
        />
      }
      end={end}
    />
  );

  let body;
  if (portLoading) {
    body = <SkeletonRows rows={3} label="Loading agents" />;
  } else if (portError || client === null) {
    body = (
      <DaemonUnavailable
        starting={false}
        errorDetail={portErrorDetail}
        onRetry={onRetry}
      />
    );
  } else if (ordered.length === 0) {
    const anyAgents = runs.length + sessions.length > 0;
    const icon = <Radio size={22} strokeWidth={1.8} />;
    // The empty state fills the list area and sits in its middle, where the list would be.
    body = (
      <div className={styles.empty} data-slot="agents-empty">
        {anyAgents ? (
          <EmptyState icon={icon}>No agents match this filter</EmptyState>
        ) : (
          <EmptyState icon={icon} label="No agents have run yet">
            {archivedRunCount > 0
              ? 'Every run here is archived — turn on Show archived to see them.'
              : 'Dispatch a task from the board to start one.'}
          </EmptyState>
        )}
      </div>
    );
  } else {
    body = (
      <>
        <Register
          label="Agents"
          columns={COLUMNS}
          header={HEADER}
          stackWithin={600}
        >
          {shown.map((entry) =>
            entry.row === 'session' ? (
              <SessionRow
                key={entry.key}
                session={entry.session}
                minute={minute}
              />
            ) : (
              <RunRow
                key={entry.key}
                run={entry.run}
                minute={minute}
                onJumpToRun={jumpToRun}
                onArchiveRun={archiveRun}
              />
            )
          )}
        </Register>

        {ordered.length > shown.length && (
          <span className={styles.more}>
            <Button variant="quiet" size="sm" onClick={() => setShowAll(true)}>
              Show all {ordered.length}
            </Button>
          </span>
        )}
      </>
    );
  }

  return (
    <div className={styles.root}>
      {toolbar}
      <div className={styles.body}>{body}</div>
    </div>
  );
}

/** The minute clock (useMinuteClock) as a row prop. The row reads the time itself, through
 * formatRelativeTimeFromIso; the prop is there only so the memoized row re-renders when the
 * minute moves. */
type RowClock = number;

/** The subject cell both row kinds share: the state mark, the title, and the agent's kind
 * or model as a chip (left out when there is no word to show). The title and chip share a
 * wrapping line beside the mark: the chip follows the title while both fit, and drops under
 * it (aligned with the title) when the column is narrow, rather than squeezing the title. */
function SubjectCell({
  mark,
  title,
  agent,
}: {
  mark: ReactNode;
  title: string;
  agent: string;
}) {
  return (
    <RegisterCell label="Agent" variant="name">
      <span className={styles.subject}>
        {mark}
        <span className={styles.subjectText}>
          <span className={styles.title}>{title}</span>
          {agent !== '' && (
            <span className={styles.agent}>
              <Chip>{agent}</Chip>
            </span>
          )}
        </span>
      </span>
    </RegisterCell>
  );
}

/** The outcome cell both row kinds share: the state in words, shimmering while the agent is
 * working on it (as the old row's live detail line did), still otherwise. */
function OutcomeCell({ word, live }: { word: string; live: boolean }) {
  return (
    <RegisterCell label="Outcome">
      {live ? <ShimmerLabel>{word}</ShimmerLabel> : word}
    </RegisterCell>
  );
}

/** A run row's button name: every fact the row prints, in its order (title, agent, outcome,
 * progress, time), as the old row (a role=button named by its whole text) was read. Two runs
 * of one task then differ by name, not only by position. Empty facts are left out. */
function rowLabel(parts: readonly (string | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== undefined && part !== '')
    .join(', ');
}

/** A task run's row: the whole row jumps to the run, and the archive button in the last
 * cell sits above the row's stretched button. An archived run steps back (muted).
 *
 * Memoized on the run object, the minute clock and the two (stable) handlers: the runs
 * query keeps an unchanged run's object across refetches (structural sharing), so a poll
 * re-renders only the rows whose run changed, and the clock re-renders every row once a
 * minute so its relative time ("5m ago") and its button name keep moving. */
const RunRow = memo(function RunRow({
  run,
  onJumpToRun,
  onArchiveRun,
}: {
  run: RunMeta;
  minute: RowClock;
  onJumpToRun: (runId: string) => void;
  onArchiveRun: (runId: string, archived: boolean) => void;
}) {
  // A closed-out run has no feed state (deriveFeedState returns null — it is nobody's
  // turn), so it takes a neutral closed-out mark.
  const feedState = deriveFeedState(run);
  const kind = runKindLabel(run);
  // Only the runs a person did not dispatch by hand: labelling every plain agent run 'agent'
  // would be a column of the same word, so those fall back to the model name instead.
  const agent = kind !== 'agent' ? kind : (modelDisplayName(run.model) ?? '');
  const archived = run.archivedAt !== undefined;
  const progress = runProgress(run);
  const outcome = outcomeLabel(run);
  const updated = formatRelativeTimeFromIso(run.updatedAt);
  return (
    <RegisterRow
      onActivate={() => onJumpToRun(run.id)}
      rowLabel={rowLabel([run.taskTitle, agent, outcome, progress, updated])}
      tone={archived ? 'muted' : undefined}
      data-row="run"
    >
      <SubjectCell
        mark={<StateMark state={feedState ?? closedOutMark(run)} pulse />}
        title={run.taskTitle}
        agent={agent}
      />
      <OutcomeCell
        word={outcome}
        live={feedState !== null && isInFlightState(feedState)}
      />
      <RegisterCell label="Progress" variant="mono">
        {progress}
      </RegisterCell>
      <RegisterCell label="Updated" variant="mono">
        {updated}
      </RegisterCell>
      <RegisterCell align="end">
        {/* Shown on the row's hover or focus on a pointer that can hover (and always while
            pressed); see .rowAction. */}
        <span
          className={styles.rowAction}
          data-slot="row-action"
          data-pressed={archived ? 'true' : undefined}
        >
          <Button
            variant="quiet"
            size="sm"
            icon={<Archive size={14} strokeWidth={1.8} aria-hidden="true" />}
            aria-pressed={archived}
            aria-label={
              archived
                ? `Unarchive ${run.taskTitle}`
                : `Archive ${run.taskTitle}`
            }
            onClick={() => onArchiveRun(run.id, !archived)}
          />
        </span>
      </RegisterCell>
    </RegisterRow>
  );
});

/** A conversation agent's row. Not clickable: a conversation agent has no run detail page to
 * jump to — its own surface (Plans, the drafts tray, Overseer) owns the full record. Memoized
 * on the session object and the minute clock, for the same reasons as RunRow. */
const SessionRow = memo(function SessionRow({
  session,
}: {
  session: AgentSessionMeta;
  minute: RowClock;
}) {
  const feedState = agentSessionFeedState(session);
  return (
    <RegisterRow data-row="session">
      <SubjectCell
        mark={<StateMark state={feedState} pulse />}
        title={session.title}
        agent={AGENT_SESSION_KIND_LABEL[session.kind]}
      />
      {/* The state in words, as a run's outcome is, so it is not told by the (decorative)
          mark alone: "working", "failed", or "answer" when it waits on your message. */}
      <OutcomeCell
        word={FEED_STATE_LABEL[feedState].toLowerCase()}
        live={isInFlightState(feedState)}
      />
      {/* A conversation has no turns, spend or fan-out to count: an empty cell with no
          label, so neither the header's hidden label nor a stacked card prints "Progress"
          over nothing. */}
      <RegisterCell variant="mono" />
      <RegisterCell label="Updated" variant="mono">
        {formatRelativeTimeFromIso(session.updatedAt)}
      </RegisterCell>
      <RegisterCell />
    </RegisterRow>
  );
});
