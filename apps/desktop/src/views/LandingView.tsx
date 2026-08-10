import { CircleCheck, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import { heldCount, toQueueRows } from '../lib/mergeQueueView';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Panel } from '@/ui/chrome';
import { SectionLabel } from '@/ui/chrome/SectionLabel';
import { StepStrip } from '@/ui/chrome/StepStrip';

interface LandingViewProps {
  data: DispatchProjectData;
  onOpenRun: (runId: string) => void;
}

/** How many history rows show before the explicit show-all. */
const HISTORY_PREVIEW = 4;

/**
 * Landing — the merge queue as a queue.
 *
 * The queue has run since well before this view; it was just only ever visible one entry at a
 * time, through a control attached to a single run. That made the two questions you actually
 * have — what is in line, and what is stuck — unanswerable. This is the whole pipeline.
 *
 * Nothing here simulates progress. Each entry's strip is drawn from the phase the server says
 * it is in, and an entry whose phase cannot be known shows no strip at all.
 */
export function LandingView({ data, onOpenRun }: LandingViewProps) {
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Keyed on the snapshot rather than on `?? []`, which mints a fresh array identity every
  // render and would make the memo do nothing.
  const queue = data.mergeQueue;
  const entries = useMemo(() => queue?.entries ?? [], [queue]);
  const history = useMemo(() => queue?.history ?? [], [queue]);
  const rows = useMemo(() => toQueueRows(entries), [entries]);
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

  const shownHistory = showAllHistory
    ? history
    : history.slice(0, HISTORY_PREVIEW);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold">Landing</h2>
        <span className="text-muted-foreground text-[12px]">
          {entries.length === 0
            ? 'nothing in the queue'
            : `${entries.length} in the queue`}{' '}
          · verify runs before anything lands
        </span>
      </div>

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
            ) : undefined
          }
        >
          Merge queue
        </SectionLabel>

        {retryError !== null && (
          <p className="text-state-failed mt-2 text-[12px]">{retryError}</p>
        )}

        {rows.length === 0 ? (
          <p className="text-muted-foreground flex items-center gap-2 py-4 text-[12.5px]">
            <CircleCheck className="size-4" />
            Nothing is waiting to land.
          </p>
        ) : (
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
        )}
      </section>

      <section>
        <SectionLabel rule count={history.length}>
          Recently landed
        </SectionLabel>
        {history.length === 0 ? (
          <p className="text-muted-foreground py-3 text-[12.5px]">
            Nothing has landed yet.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col">
            {shownHistory.map((h) => (
              <li
                key={`${h.runId}-${h.finishedAt ?? ''}`}
                className="hover:bg-muted/40 grid cursor-pointer grid-cols-[minmax(160px,1fr)_minmax(0,220px)_80px_72px] items-center gap-3 rounded-md px-3 py-1.5 transition-colors duration-150"
                onClick={() => onOpenRun(h.runId)}
              >
                <span className="text-muted-foreground truncate text-[13px]">
                  {h.taskTitle}
                </span>
                {/* A failed entry states what actually went wrong, since the phase it died in
                    was never recorded — the message is the only specific thing we have. */}
                <span className="dense-meta text-state-failed truncate">
                  {h.state === 'failed' ? (h.reason ?? 'failed') : ''}
                </span>
                <span
                  className={cn(
                    'dense-meta text-right',
                    h.state === 'merged'
                      ? 'text-state-review'
                      : 'text-state-failed'
                  )}
                >
                  {h.state}
                </span>
                <span className="dense-meta text-right">
                  {h.finishedAt === undefined
                    ? ''
                    : formatRelativeTimeFromIso(h.finishedAt)}
                </span>
              </li>
            ))}
            {history.length > HISTORY_PREVIEW && (
              <li>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setShowAllHistory((v) => !v)}
                  className="text-muted-foreground hover:text-foreground h-auto px-3 py-2 text-[length:inherit] font-normal hover:bg-transparent"
                >
                  {showAllHistory ? 'Show fewer' : `Show all ${history.length}`}
                </Button>
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
