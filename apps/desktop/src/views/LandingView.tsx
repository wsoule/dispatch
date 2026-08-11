import { CircleCheck, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import { heldCount, toQueueRows } from '../lib/mergeQueueView';
import { groupQueueHistory } from '../lib/queueHistory';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Panel } from '@/ui/chrome';
import { SectionLabel } from '@/ui/chrome/SectionLabel';
import { StepStrip } from '@/ui/chrome/StepStrip';

interface LandingViewProps {
  data: DispatchProjectData;
  onOpenRun: (runId: string) => void;
}

/** How many landed rows show before the explicit show-all. */
const HISTORY_PREVIEW = 4;

/**
 * Landing — the merge queue as a queue.
 *
 * The queue has run since well before this view; it was just only ever visible one entry at a
 * time, through a control attached to a single run. That made the two questions you actually
 * have — what is in line, and what is stuck — unanswerable. This is the whole pipeline.
 *
 * History renders as the two stories it actually contains, not one list: "Landed" holds
 * successful merges only, "Failed to land" holds live failures with the error legible and a
 * retry. A failed attempt whose run was reviewed anyway, or that a newer attempt superseded,
 * is stale history and collapses behind a disclosure — see `groupQueueHistory`.
 *
 * Nothing here simulates progress. Each entry's strip is drawn from the phase the server says
 * it is in, and an entry whose phase cannot be known shows no strip at all.
 *
 * Sized to content, not to a fixed height: InboxView is this view's only consumer, and it
 * renders LandingView as the last item of its own `flex-col` scroller, below the waiting/review
 * lists. A root that also claimed `h-full`/`overflow-y-auto` — right for a full-window page —
 * let this section collapse to zero height once those lists filled up, making the queue
 * unreachable exactly when it was busiest. Content sizing plus the outer scroller fixes that.
 */
export function LandingView({ data, onOpenRun }: LandingViewProps) {
  const [showAllLanded, setShowAllLanded] = useState(false);
  const [showStale, setShowStale] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [pushRetrying, setPushRetrying] = useState(false);
  // The failed-row retry re-enqueues one run; track which, plus the server's
  // refusal (409: already queued, already reviewed…) to render inline.
  const [reenqueuingId, setReenqueuingId] = useState<string | null>(null);
  const [reenqueueError, setReenqueueError] = useState<{
    runId: string;
    message: string;
  } | null>(null);

  // Keyed on the snapshot rather than on `?? []`, which mints a fresh array identity every
  // render and would make the memo do nothing.
  const queue = data.mergeQueue;
  const entries = useMemo(() => queue?.entries ?? [], [queue]);
  const history = useMemo(() => queue?.history ?? [], [queue]);
  const rows = useMemo(() => toQueueRows(entries), [entries]);
  const runs = data.runs;
  const { landed, failed, stale } = useMemo(
    () =>
      groupQueueHistory(
        history,
        runs ?? [],
        new Set(entries.map((e) => e.runId))
      ),
    [history, runs, entries]
  );
  const held = heldCount(entries);

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  async function retryHeld() {
    setRetrying(true);
    setRetryError(null);
    try {
      await data.handleRecheckMergeQueue();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }

  // `handleMergeAllReady`, not `handleRecheckMergeQueue`: kicking the pump with nothing new
  // to enqueue is what makes the server retry a drain-push it failed (see the handler's
  // comment in useDispatchProject). The banner clears on the next `queue.drained` that
  // pushes cleanly, not here.
  async function retryPush() {
    setPushRetrying(true);
    try {
      await data.handleMergeAllReady();
    } finally {
      setPushRetrying(false);
    }
  }

  // Re-enqueue one failed run. The server's refusals (already reviewed, already queued,
  // run not terminal) come back as thrown Errors carrying its message — render that on
  // the row rather than swallowing it.
  async function retryFailed(runId: string) {
    setReenqueuingId(runId);
    setReenqueueError(null);
    try {
      await data.handleEnqueueMerge(runId);
    } catch (err) {
      setReenqueueError({
        runId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setReenqueuingId(null);
    }
  }

  const shownLanded = showAllLanded ? landed : landed.slice(0, HISTORY_PREVIEW);

  return (
    <div className="flex flex-col gap-4">
      {/* The one queue outcome nothing else reports. A drain that merges locally but fails to
          push leaves origin without the commit, and the per-entry rows below have already
          moved that entry into "Landed" — from the queue's point of view it did land. This is
          the only place that says otherwise. */}
      {data.lastPushError !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-[12px]">
          <span className="min-w-0 truncate">
            Merged locally — push failed: {data.lastPushError}
          </span>
          <Button
            variant="secondary"
            size="xs"
            disabled={pushRetrying}
            onClick={() => void retryPush()}
          >
            Retry push
          </Button>
        </div>
      )}

      {/* An empty queue is one line, not a header plus a section both saying nothing is
          queued — the chrome should cost no more than the fact it reports. */}
      {entries.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
          <CircleCheck className="size-4" />
          Merge queue: empty
        </p>
      ) : (
        <section>
          <SectionLabel
            rule
            count={entries.length}
            trailing={
              held > 0 ? (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void retryHeld()}
                  disabled={retrying}
                  className="text-state-waiting shadow-hairline hover:bg-muted/60 hover:text-state-waiting h-auto rounded-md px-2 py-1 text-[length:inherit] font-normal"
                >
                  {retrying
                    ? 'Rechecking…'
                    : `Retry ${held} held ${held === 1 ? 'entry' : 'entries'}`}
                </Button>
              ) : (
                <span className="dense-meta">
                  verify runs before anything lands
                </span>
              )
            }
          >
            Merge queue
          </SectionLabel>

          {retryError !== null && (
            <p className="text-state-failed mt-2 text-[12px]">{retryError}</p>
          )}

          <ul className="mt-2 flex flex-col gap-1.5">
            {rows.map((row) => (
              <li
                key={row.entry.runId}
                onClick={() => onOpenRun(row.entry.runId)}
              >
                <Panel
                  className={cn(
                    'cursor-pointer px-3 py-2.5 transition-colors duration-150',
                    // Panel's own base is `bg-card`, a different token than the page
                    // background — neutralize it at rest so a row is only ever filled
                    // when stalled, matching the original's resting state.
                    row.stalled
                      ? 'bg-state-waiting-surface'
                      : 'bg-transparent hover:bg-muted/40'
                  )}
                >
                  <div className="grid grid-cols-[28px_minmax(160px,1fr)_180px_80px] items-center gap-3">
                    <span className="dense-meta">#{row.position}</span>
                    <span className="truncate text-[13.5px]">
                      {row.entry.taskTitle}
                    </span>
                    <span
                      className={cn(
                        'dense-meta truncate',
                        (row.stalled || row.overdue) && 'text-state-waiting'
                      )}
                    >
                      {row.label}
                      {row.overdue && ' · taking longer than expected'}
                    </span>
                    {/* Time in the CURRENT state, not since enqueue — a step that
                        has run for two minutes and one wedged for eleven look
                        identical measured from enqueue. */}
                    <span
                      className={cn(
                        'dense-meta text-right',
                        row.overdue && 'text-state-waiting'
                      )}
                    >
                      {formatRelativeTimeFromIso(row.elapsedSince)}
                    </span>
                  </div>

                  {row.reason !== null && (
                    <div className="mt-1.5 flex items-center gap-2 pl-[40px]">
                      <TriangleAlert className="text-state-waiting size-3.5 shrink-0" />
                      <span className="text-state-waiting truncate text-[12.5px]">
                        {row.reason}
                      </span>
                    </div>
                  )}

                  {row.steps !== null && (
                    <StepStrip steps={row.steps} className="mt-2.5" />
                  )}
                </Panel>
              </li>
            ))}
          </ul>
        </section>
      )}

      {landed.length > 0 && (
        <section>
          <SectionLabel rule count={landed.length}>
            Landed
          </SectionLabel>
          <ul className="mt-1 flex flex-col">
            {shownLanded.map((h) => (
              <li
                key={`${h.runId}-${h.finishedAt ?? ''}`}
                className="hover:bg-muted/40 grid cursor-pointer grid-cols-[minmax(160px,1fr)_80px_72px] items-center gap-3 rounded-md px-3 py-1.5 transition-colors duration-150"
                onClick={() => onOpenRun(h.runId)}
              >
                <span className="text-muted-foreground truncate text-[13px]">
                  {h.taskTitle}
                </span>
                <span className="dense-meta text-state-review text-right">
                  merged
                </span>
                <span className="dense-meta text-right">
                  {h.finishedAt === undefined
                    ? ''
                    : formatRelativeTimeFromIso(h.finishedAt)}
                </span>
              </li>
            ))}
            {landed.length > HISTORY_PREVIEW && (
              <li>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setShowAllLanded((v) => !v)}
                  className="text-muted-foreground hover:text-foreground h-auto px-3 py-2 text-[length:inherit] font-normal hover:bg-transparent"
                >
                  {showAllLanded ? 'Show fewer' : `Show all ${landed.length}`}
                </Button>
              </li>
            )}
          </ul>
        </section>
      )}

      {failed.length > 0 && (
        <section>
          <SectionLabel rule count={failed.length}>
            Failed to land
          </SectionLabel>
          <ul className="mt-1 flex flex-col gap-0.5">
            {failed.map((h) => (
              <li
                key={`${h.runId}-${h.finishedAt ?? ''}`}
                className="hover:bg-muted/40 cursor-pointer rounded-md px-3 py-2 transition-colors duration-150"
                onClick={() => onOpenRun(h.runId)}
              >
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {h.taskTitle}
                  </span>
                  <span className="dense-meta shrink-0">
                    {h.finishedAt === undefined
                      ? ''
                      : formatRelativeTimeFromIso(h.finishedAt)}
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={reenqueuingId !== null}
                    onClick={(e) => {
                      // The row itself navigates; retrying must not also open the run.
                      e.stopPropagation();
                      void retryFailed(h.runId);
                    }}
                    aria-label={`Retry: ${h.taskTitle}`}
                    className="shrink-0"
                  >
                    {reenqueuingId === h.runId ? 'Queuing…' : 'Retry'}
                  </Button>
                </div>
                {/* The error is the row's whole point — full text, wrapped, not a truncated
                    monospace fragment. */}
                <p className="text-state-failed mt-1 text-[12.5px] break-words">
                  {h.reason ?? 'failed'}
                </p>
                {reenqueueError !== null &&
                  reenqueueError.runId === h.runId && (
                    <p className="text-state-failed mt-1 text-[12px]">
                      Retry failed: {reenqueueError.message}
                    </p>
                  )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Failures the run has outgrown — reviewed anyway, or superseded by a newer attempt.
          Kept reachable for the curious, but never as headline rows. */}
      {stale.length > 0 && (
        <div>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowStale((v) => !v)}
            className="text-muted-foreground hover:text-foreground h-auto px-3 py-1 text-[length:inherit] font-normal hover:bg-transparent"
          >
            {showStale ? 'Hide' : 'Show'} {stale.length} stale{' '}
            {stale.length === 1 ? 'attempt' : 'attempts'}
          </Button>
          {showStale && (
            <ul className="mt-1 flex flex-col">
              {stale.map((h) => (
                <li
                  key={`${h.runId}-${h.finishedAt ?? ''}`}
                  className="text-muted-foreground/70 hover:bg-muted/40 grid cursor-pointer grid-cols-[minmax(160px,1fr)_minmax(0,220px)_72px] items-center gap-3 rounded-md px-3 py-1 text-[12.5px] transition-colors duration-150"
                  onClick={() => onOpenRun(h.runId)}
                >
                  <span className="truncate">{h.taskTitle}</span>
                  <span className="truncate">{h.reason ?? 'failed'}</span>
                  <span className="dense-meta text-right">
                    {h.finishedAt === undefined
                      ? ''
                      : formatRelativeTimeFromIso(h.finishedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
