import type { GateStatus, MergeQueueEntry, RunMeta } from '@dispatch/client';
import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { LandingRow } from '../components/landing/LandingRow';
import { LandedAs } from '../components/runs/LandedAs';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { LandingFilters } from '../lib/landingView';
import {
  dedupeLandingRows,
  EMPTY_FILTERS,
  landedFromTasks,
  landedRunByTask,
  readLandingFilters,
  relativeTime,
  serializeLandingFilters,
  visibleLandingRows,
} from '../lib/landingView';
import { groupFailedAttempts } from '../lib/queueHistory';
import { useStatusModelOf } from '../lib/statusModel';
import { GroupHeader } from '@/ui/ai/group-header';
import { ListRow } from '@/ui/ai/list-row';
import { PageHeader, ViewTabs } from '@/ui/ai/page-header';
import { Pill, PillButton } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/ui/input-group';

// Persists filters across launches, same key/shape Task 8's read/serialize
// pair round-trips — the only place that touches localStorage for them.
const FILTERS_STORAGE_KEY = 'dispatch:landing:filters';

function readStoredFilters(): LandingFilters {
  if (typeof window === 'undefined') return EMPTY_FILTERS;
  return readLandingFilters(window.localStorage.getItem(FILTERS_STORAGE_KEY));
}

// The header's two view tabs: what is still in flight, and what already landed.
type LandingTab = 'queue' | 'landed';

const LANDING_TABS: { id: LandingTab; label: string }[] = [
  { id: 'queue', label: 'Queue' },
  { id: 'landed', label: 'Landed' },
];

const META_CLASS = 'text-[12px] font-book text-muted-foreground tabular-nums';

interface LandingTableViewProps {
  data: DispatchProjectData;
  /** The active project's display name, the first crumb of the page header. */
  projectName?: string | null;
  /** A run-backed row's title click — App.tsx opens the task's Diff tab. */
  onOpenRun: (taskId: string, runId: string) => void;
  /** A bare PR row's title click — App.tsx opens the PR review page. */
  onOpenPr: (number: number) => void;
}

/** The unified PR table: every run/PR/queue-local entry in flight, grouped by
 * what it needs, the queue's own verdict on anything it bounced ("Failed to
 * land", with a retry), and — under the Landed tab — what recently landed. */
export function LandingTableView({
  data,
  projectName,
  onOpenRun,
  onOpenPr,
}: LandingTableViewProps) {
  const [filters, setFilters] = useState<LandingFilters>(readStoredFilters);
  const model = useStatusModelOf(data.config);
  useEffect(() => {
    window.localStorage.setItem(
      FILTERS_STORAGE_KEY,
      serializeLandingFilters(filters)
    );
  }, [filters]);

  const [tab, setTab] = useState<LandingTab>('queue');
  const [staleOpen, setStaleOpen] = useState(false);
  const [pushRetrying, setPushRetrying] = useState(false);
  // The run a failed row is re-enqueueing, so its Retry reads busy while the
  // request is in flight. The outcome itself — the server's 409s (already
  // reviewed, already queued) and the "Queued to merge" confirmation — is
  // reported by the action-feedback wrapper around `data` (lib/actionFeedback.ts),
  // which is also why nothing here catches.
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);

  // Re-running "merge all ready" with nothing new to enqueue is what makes the
  // server retry a drain-push it failed. The banner clears on the next clean
  // `queue.drained`, not here.
  async function retryPush() {
    setPushRetrying(true);
    try {
      await data.handleMergeAllReady();
    } finally {
      setPushRetrying(false);
    }
  }

  // Re-enqueues one run the queue bounced — the same action as queueing it from
  // review, aimed at the run that fell out. Once the entry is live again the
  // failed row demotes to stale on its own (see `groupFailedAttempts`).
  async function retryFailed(runId: string) {
    setRetryingRunId(runId);
    try {
      await data.handleEnqueueMerge(runId);
    } finally {
      setRetryingRunId(null);
    }
  }

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }
  const client = data.client;

  const snapshot = data.landing;
  const now = Date.now();

  // Re-clicking the same author/gate a row's own buttons set clears it —
  // the dismissible chip under the header does the same thing in reverse.
  const toggleAuthor = (author: string) =>
    setFilters((f) => ({ ...f, author: f.author === author ? null : author }));
  const toggleGate = (gate: GateStatus) =>
    setFilters((f) => ({ ...f, gate: f.gate === gate ? null : gate }));
  const clearFilters = () => setFilters(EMPTY_FILTERS);
  // Narrowed locals so TS can carry the `!== null` check into the chips below.
  const authorFilter = filters.author;
  const gateFilter = filters.gate;
  const hasActiveFilters =
    filters.query !== '' || authorFilter !== null || gateFilter !== null;

  // One row per task — see `dedupeLandingRows`; the run map supplies recency.
  const deduped =
    snapshot !== null
      ? dedupeLandingRows(
          snapshot.rows,
          new Map(data.runs.map((r) => [r.id, r.createdAt]))
        )
      : null;
  const visibleRows =
    snapshot !== null && deduped !== null
      ? visibleLandingRows({ ...snapshot, rows: deduped.rows }, filters)
      : [];
  // Unfiltered, so a facet chip narrowing the visible rows never also hides
  // the entry `gateChipLabel` needs to name "behind <title>".
  const queueRows =
    snapshot !== null ? snapshot.rows.filter((r) => r.queue !== undefined) : [];
  const reviewedAtByRunId = new Map(
    data.runs
      .filter((r) => r.reviewedAt !== undefined)
      .map((r) => [r.id, r.reviewedAt])
  );
  // Durable across daemon restarts, unlike the queue's in-memory history — see
  // `landedFromTasks`.
  const landedTasks = landedFromTasks(data.tasksIncludingArchived, model);
  // The queue's verdicts on runs that fell out of it. Neither the snapshot's
  // rows (no failed gate) nor its landed list (merged history only) carry
  // these, so a run the queue bounced would otherwise sit in "Open" looking
  // untouched, its reason visible nowhere on this page. Same query as the live
  // entries, so the "back in the queue" rule can never see a stale pair.
  const { failed: failedAttempts, stale: staleAttempts } = groupFailedAttempts(
    data.mergeQueue?.history ?? [],
    data.runs,
    new Set((data.mergeQueue?.entries ?? []).map((e) => e.runId))
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        crumb={[
          ...(projectName !== undefined && projectName !== null
            ? [projectName]
            : []),
          'Merge queue',
        ]}
        actions={
          // react-query keeps the last snapshot on a failed refetch — this
          // pill is the only thing that flags it as stale, not current.
          snapshot !== null && data.landingIsError ? (
            <Pill className="text-muted-foreground">
              Stale · {relativeTime(snapshot.generatedAt, now)}
            </Pill>
          ) : undefined
        }
        tabs={
          <ViewTabs
            tabs={LANDING_TABS}
            active={tab}
            onChange={(id) => setTab(id as LandingTab)}
          />
        }
        controls={
          tab === 'queue' ? (
            <InputGroup className="h-7 w-64 gap-2 px-2 has-[>[data-align=inline-start]]:[&>input]:pl-0">
              <InputGroupAddon className="p-0">
                <Search className="text-muted-foreground size-3.5 shrink-0" />
              </InputGroupAddon>
              <InputGroupInput
                value={filters.query}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, query: e.target.value }))
                }
                placeholder="Search title, author, branch, or #123…"
                aria-label="Search the PR table"
                className="h-auto px-0 text-[12px] md:text-[12px]"
              />
            </InputGroup>
          ) : undefined
        }
      />

      {/* Applied filters, as the chip row Linear draws under its header. */}
      {tab === 'queue' && (authorFilter !== null || gateFilter !== null) && (
        <div className="shadow-hairline-bottom flex h-10 shrink-0 items-center gap-1.5 px-4">
          {authorFilter !== null && (
            <FilterChip
              label={`Author is ${authorFilter}`}
              onDismiss={() => toggleAuthor(authorFilter)}
            />
          )}
          {gateFilter !== null && (
            <FilterChip
              label={`Gate is ${gateFilter}`}
              onDismiss={() => toggleGate(gateFilter)}
            />
          )}
          <Button variant="ghost" size="xs" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      )}

      {/* The one queue outcome nothing else reports. A drain that merges locally but fails
          to push leaves origin without the commit, while the rows below have already moved
          that entry into "Landed" — this is the only place that says otherwise. */}
      {data.lastPushError !== null && (
        <div className="bg-state-failed-surface text-state-failed rounded-card mx-4 mt-3 flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
          <span className="min-w-0 truncate">
            Merged locally — push failed: {data.lastPushError}
          </span>
          <PillButton disabled={pushRetrying} onClick={() => void retryPush()}>
            Retry push
          </PillButton>
        </div>
      )}

      {snapshot === null && data.landingIsError ? (
        <EmptyState
          heading="Couldn't load the PR table."
          secondary={{ label: 'Retry', onClick: data.landingRefetch }}
        />
      ) : snapshot === null ? (
        <p className="text-muted-foreground font-book px-4 py-3 text-[13px]">
          Loading the PR table…
        </p>
      ) : tab === 'landed' ? (
        <LandedList
          landed={landedTasks}
          queueLanded={snapshot.landed}
          landedRuns={landedRunByTask(data.runs)}
          originWebUrl={data.health?.originWebUrl}
          onPublish={data.handlePublishRun}
          now={now}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
          {visibleRows.length === 0 ? (
            <EmptyState
              heading={
                snapshot.rows.length === 0
                  ? 'Nothing in flight.'
                  : 'No rows match.'
              }
              secondary={
                hasActiveFilters
                  ? { label: 'Clear filters', onClick: clearFilters }
                  : undefined
              }
            />
          ) : (
            <div
              className="flex flex-col gap-0.5"
              role="list"
              aria-label="Pull requests"
            >
              {visibleRows.map((entry) =>
                entry.type === 'group' ? (
                  <GroupHeader
                    key={`group-${entry.id}`}
                    name={entry.label}
                    count={entry.count}
                    className="mt-2 first:mt-0"
                  />
                ) : (
                  <LandingRow
                    key={entry.row.id}
                    row={entry.row}
                    queueRows={queueRows}
                    now={now}
                    extraRuns={
                      entry.row.taskId !== undefined
                        ? deduped?.extraRunsByTask.get(entry.row.taskId)
                        : undefined
                    }
                    reviewedAt={
                      entry.row.runId !== undefined
                        ? reviewedAtByRunId.get(entry.row.runId)
                        : undefined
                    }
                    onFilterAuthor={toggleAuthor}
                    onFilterGate={toggleGate}
                    onOpenRun={onOpenRun}
                    onOpenPr={onOpenPr}
                    client={client}
                    port={data.port}
                    onRetryQueue={data.handleRecheckMergeQueue}
                  />
                )
              )}
            </div>
          )}

          {failedAttempts.length > 0 && (
            <section className="mt-3 flex flex-col gap-0.5">
              <GroupHeader
                name="Failed to land"
                count={failedAttempts.length}
                tint="var(--state-failed-fg)"
              />
              {failedAttempts.map((entry) => (
                <FailedAttemptRow
                  key={attemptKey(entry)}
                  entry={entry}
                  now={now}
                  retrying={retryingRunId === entry.runId}
                  retryDisabled={retryingRunId !== null}
                  onOpen={() => onOpenRun(entry.taskId, entry.runId)}
                  onRetry={() => void retryFailed(entry.runId)}
                />
              ))}
            </section>
          )}

          {/* Failures the run has outgrown — reviewed anyway, superseded by a newer
              attempt, or re-queued. Kept reachable, never as headline rows. */}
          {staleAttempts.length > 0 && (
            <section className="mt-3 flex flex-col gap-0.5">
              <GroupHeader
                name="Stale attempts"
                count={staleAttempts.length}
                collapsed={!staleOpen}
                onToggle={() => setStaleOpen((v) => !v)}
              />
              {staleOpen &&
                staleAttempts.map((entry) => (
                  <ListRow
                    key={attemptKey(entry)}
                    title={entry.taskTitle}
                    crumb={entry.reason ?? 'failed'}
                    onClick={() => onOpenRun(entry.taskId, entry.runId)}
                    date={relativeTime(attemptFinishedAt(entry), now)}
                  />
                ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** The Landed tab: every task that landed, newest first, with how it landed
 * when this daemon session's queue still remembers. */
function LandedList({
  landed,
  queueLanded,
  landedRuns,
  originWebUrl,
  onPublish,
  now,
}: {
  landed: ReturnType<typeof landedFromTasks>;
  queueLanded: NonNullable<DispatchProjectData['landing']>['landed'];
  /** Each task's landing run: where its work went is read off it. */
  landedRuns: ReadonlyMap<string, RunMeta>;
  originWebUrl: string | undefined;
  onPublish: (runId: string) => Promise<void>;
  now: number;
}) {
  if (landed.length === 0) {
    return <EmptyState heading="Nothing has landed yet." />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
      <div className="flex flex-col gap-0.5" role="list" aria-label="Landed">
        {landed.map((entry) => {
          // The queue's own history enriches a row with how it landed,
          // when this daemon session still remembers it.
          const queueEntry = queueLanded.find((l) => l.title === entry.title);
          const run = landedRuns.get(entry.id);
          return (
            <ListRow
              key={entry.id}
              role="listitem"
              title={entry.title}
              trailing={
                // The run says where the work went (origin and sha, local, or
                // not on GitHub yet); the queue's memory is only a fallback.
                run !== undefined ? (
                  <span className="text-[12px]">
                    <LandedAs
                      run={run}
                      originWebUrl={originWebUrl}
                      onPublish={onPublish}
                    />
                  </span>
                ) : queueEntry !== undefined ? (
                  <>
                    <Pill>
                      {queueEntry.via === 'pr'
                        ? `PR #${queueEntry.prNumber}`
                        : 'Local'}
                    </Pill>
                    {queueEntry.mergeCommit !== undefined && (
                      <span className={META_CLASS}>
                        {queueEntry.mergeCommit.slice(0, 7)}
                      </span>
                    )}
                  </>
                ) : undefined
              }
              date={relativeTime(entry.landedAt, now)}
            />
          );
        })}
      </div>
    </div>
  );
}

// A history entry's React key. A run can fail more than once, so the run id alone
// would collide across its stale attempts; the finish time tells them apart.
function attemptKey(entry: MergeQueueEntry): string {
  return `${entry.runId}-${entry.finishedAt ?? entry.enqueuedAt}`;
}

// When a history entry came to rest. `finishedAt` is set on every entry the
// server files to history; the fallbacks only cover entries persisted before
// the field existed.
function attemptFinishedAt(entry: MergeQueueEntry): string {
  return entry.finishedAt ?? entry.stateSince ?? entry.enqueuedAt;
}

/**
 * One failed queue attempt: the task, when it failed, a Retry that re-enqueues
 * the run, and the queue's failure reason in full. The reason is the row's whole
 * point — the phase it died in was never recorded (see `phaseSteps`), so the
 * message is the only specific thing there is. Tint stays on the reason, not
 * the row: a wall of red rows reads as alarm wallpaper, not information.
 */
function FailedAttemptRow({
  entry,
  now,
  retrying,
  retryDisabled,
  onOpen,
  onRetry,
}: {
  entry: MergeQueueEntry;
  now: number;
  retrying: boolean;
  retryDisabled: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="hover:bg-surface-hover rounded-control transition-colors duration-100">
      <ListRow
        title={entry.taskTitle}
        onClick={onOpen}
        className="hover:bg-transparent"
        trailing={
          <PillButton
            disabled={retryDisabled}
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
            aria-label={`Retry: ${entry.taskTitle}`}
          >
            {retrying ? 'Queuing…' : 'Retry'}
          </PillButton>
        }
        date={relativeTime(attemptFinishedAt(entry), now)}
      />
      {/* Full text, wrapped — a verify log's useful line is usually its last. Height is
          capped so a reason at the server's 4 KB limit scrolls in place instead of
          pushing the rest of the page away. */}
      <p className="text-state-failed font-book max-h-32 overflow-y-auto px-3 pb-2 text-[12px] break-words whitespace-pre-wrap">
        {entry.reason ?? 'failed'}
      </p>
    </div>
  );
}

function FilterChip({
  label,
  onDismiss,
}: {
  label: string;
  onDismiss: () => void;
}) {
  return (
    <Pill className="pr-1">
      {label}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Remove filter: ${label}`}
        className="text-muted-foreground rounded-pill flex size-4 items-center justify-center hover:text-(--text-secondary)"
      >
        <X className="size-3" />
      </button>
    </Pill>
  );
}
