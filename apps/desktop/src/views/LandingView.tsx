import {
  Button,
  Checkbox,
  Chip,
  ChipButton,
  CodeBlock,
  Dialog,
  EmptyState,
  ListItem,
  SectionHeader,
  Tabs,
  Tooltip,
} from '@dispatch/ui';
import {
  ArrowUpRight,
  FileText,
  ListX,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { PageHead } from '../components/shell/PageHead';
import { useToasts } from '../components/shell/Toasts';
import { StateMark } from '../components/status/StateMark';
import { StepStrip } from '../components/status/StepStrip';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  buildLandingBoard,
  canPullFromQueue,
  formatStageElapsed,
  type LandingFilter,
  type LandingItem,
  landingMark,
  landingSections,
  STAGE_LABELS,
  stageDetail,
} from '../lib/landingQueue';
import { useStatusModelOf } from '../lib/statusModel';
import styles from './LandingView.module.css';

export interface LandingViewProps {
  data: DispatchProjectData;
  onBack: () => void;
  /** Opens the task page on this run. */
  onOpenRun: (taskId: string, runId: string) => void;
}

// A clock for the elapsed column. React's Activity unmounts effects while the page is
// hidden, so this only ticks while someone can see it.
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// An icon-only row action with its name as a tooltip; the name is also its accessible label.
function RowAction({
  label,
  onClick,
  disabled,
  icon,
  testId,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon: ReactNode;
  testId: string;
}) {
  return (
    <Tooltip content={label}>
      <Button
        variant="quiet"
        size="sm"
        icon={icon}
        aria-label={label}
        disabled={disabled}
        data-testid={testId}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      />
    </Tooltip>
  );
}

/** The verify log behind a failed (or verifying) run: its one-line reason, conflicted
 * files, the full reason the queue kept, and the tail of the verify output. */
function LandingLogDialog({
  item,
  onClose,
}: {
  item: LandingItem | null;
  onClose: () => void;
}) {
  if (item === null) return null;
  const { entry } = item;
  const output = entry.output?.trim() ?? '';
  const reason = entry.reason?.trim() ?? '';
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={entry.taskTitle}
      description={`${entry.runId} · ${
        item.failure !== null ? item.failure.summary : STAGE_LABELS[item.stage]
      }`}
      data-testid="landing-log"
    >
      <div className={styles.log}>
        {entry.conflicts !== undefined && entry.conflicts.length > 0 && (
          <div className={styles.chips}>
            {entry.conflicts.map((file) => (
              <Chip key={file}>{file}</Chip>
            ))}
          </div>
        )}
        {reason !== '' && (
          <CodeBlock code={reason} filename="Reason" wrap maxHeight={224} />
        )}
        {output === '' ? (
          <p className={styles.quiet}>
            No verify output was recorded for this run.
          </p>
        ) : (
          <CodeBlock
            code={output}
            filename="Verify output (tail)"
            wrap
            maxHeight={320}
          />
        )}
      </div>
    </Dialog>
  );
}

/**
 * Landing: every run headed for main and where it is stuck. Reads the merge queue
 * snapshot, which `merge-queue.changed` keeps live, so nothing here refreshes by hand.
 * Failures lead because they need you; in-progress rows say their stage, position and
 * what holds them; today's landings close the page.
 */
export function LandingView({ data, onBack, onOpenRun }: LandingViewProps) {
  const toasts = useToasts();
  const statuses = useStatusModelOf(data.config);
  const now = useNow(5_000);
  const [filter, setFilter] = useState<LandingFilter>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // The run whose log is open; read back from the live board so a verifying run's
  // output keeps growing while the dialog is up.
  const [logRunId, setLogRunId] = useState<string | null>(null);

  // `now` is left out on purpose: only `since` comparisons read it, and a 5s tick should
  // not regroup the board. Landed today re-reads it whenever the queue changes.
  const board = useMemo(
    () =>
      buildLandingBoard(
        data.mergeQueue,
        data.tasksIncludingArchived,
        statuses,
        Date.now()
      ),
    [data.mergeQueue, data.tasksIncludingArchived, statuses]
  );
  const sections = landingSections(board, filter);
  const logItem =
    logRunId === null
      ? null
      : ([...board.inProgress, ...board.failed, ...board.landedToday].find(
          (item) => item.entry.runId === logRunId
        ) ?? null);
  const failedIds = board.failed.map((item) => item.entry.runId);
  // A selection only ever holds failed rows; drop any that left the failed group.
  const selectedFailed = failedIds.filter((id) => selected.has(id));
  const environmentHeld = board.inProgress.some(
    (item) => item.hold?.kind === 'environment'
  );

  // Runs one queue action per run id, marking each busy meanwhile. Failures are toasted
  // with the daemon's own message (its 409s say why: already reviewed, not terminal).
  const act = async (
    runIds: readonly string[],
    action: (runId: string) => Promise<void>,
    verb: string
  ) => {
    setBusy((prev) => new Set([...prev, ...runIds]));
    const failures: string[] = [];
    for (const runId of runIds) {
      try {
        await action(runId);
      } catch (err) {
        failures.push(`${runId}: ${(err as Error).message}`);
      }
    }
    setBusy((prev) => new Set([...prev].filter((id) => !runIds.includes(id))));
    setSelected(
      (prev) => new Set([...prev].filter((id) => !runIds.includes(id)))
    );
    if (failures.length > 0) {
      toasts.push({
        tone: 'error',
        title:
          failures.length === 1
            ? `Could not ${verb}`
            : `Could not ${verb} ${failures.length} runs`,
        description: failures.join('\n'),
      });
    }
  };
  const requeue = (runIds: readonly string[]) =>
    void act(runIds, data.handleEnqueueMerge, 're-queue');
  const pull = (runId: string) =>
    void act([runId], data.handleDequeueMerge, 'pull from the queue');
  const recheck = () => {
    data.handleRecheckMergeQueue().catch((err: unknown) => {
      toasts.push({
        tone: 'error',
        title: 'Could not recheck the queue',
        description: (err as Error).message,
      });
    });
  };

  const tabs = [
    {
      id: 'all',
      label: `All ${board.inProgress.length + board.failed.length + board.landedToday.length}`,
    },
    { id: 'in-progress', label: `In progress ${board.inProgress.length}` },
    { id: 'failed', label: `Failed ${board.failed.length}` },
    { id: 'landed-today', label: `Landed today ${board.landedToday.length}` },
  ];

  const header = (
    <div className={styles.bar}>
      <PageHead
        onBack={onBack}
        crumbs={['Landing']}
        actions={
          <>
            {environmentHeld && (
              <Button
                size="sm"
                variant="quiet"
                icon={<RefreshCw size={14} strokeWidth={1.8} aria-hidden />}
                onClick={recheck}
              >
                Recheck checkout
              </Button>
            )}
            {failedIds.length > 0 && (
              <Button
                size="sm"
                variant="quiet"
                icon={<RotateCcw size={14} strokeWidth={1.8} aria-hidden />}
                data-testid="landing-requeue-all"
                disabled={failedIds.every((id) => busy.has(id))}
                onClick={() => requeue(failedIds)}
              >
                Re-queue all failed ({failedIds.length})
              </Button>
            )}
          </>
        }
      />
      <Tabs
        flush
        label="Landing filter"
        items={tabs}
        value={filter}
        onChange={(id) => setFilter(id as LandingFilter)}
      />
    </div>
  );

  if (data.mergeQueue === null) {
    return (
      <div className={styles.root} aria-busy="true">
        {header}
        <div className={styles.empty}>
          <EmptyState label="Loading the merge queue">
            Waiting for the daemon&apos;s queue snapshot.
          </EmptyState>
        </div>
      </div>
    );
  }

  const renderRow = (item: LandingItem) => {
    const { entry } = item;
    const runId = entry.runId;
    const isBusy = busy.has(runId);
    const detail = stageDetail(item);
    const failed = item.stage === 'failed';
    const hasLog =
      failed || item.stage === 'verifying' || (entry.output ?? '') !== '';
    return (
      <ListItem
        key={runId}
        role="listitem"
        data-testid={`landing-row-${runId}`}
        data-stage={item.stage}
        leading={<StateMark state={landingMark(item)} />}
        title={entry.taskTitle}
        crumb={
          detail === null ? undefined : (
            <span
              data-testid="landing-detail"
              className={failed ? styles.failedText : undefined}
            >
              {detail}
            </span>
          )
        }
        selected={selected.has(runId)}
        onClick={() => onOpenRun(entry.taskId, runId)}
        trailing={
          <span className={styles.trailing}>
            {failed && (
              <Checkbox
                hideLabel
                label={`Select ${entry.taskTitle}`}
                checked={selected.has(runId)}
                onClick={(event) => event.stopPropagation()}
                onChange={(next) =>
                  setSelected((prev) => {
                    const out = new Set(prev);
                    if (next) out.add(runId);
                    else out.delete(runId);
                    return out;
                  })
                }
              />
            )}
            {item.waitingOn
              .filter((b) => b.runId !== null)
              .map((b) => (
                <ChipButton
                  key={b.taskId}
                  data-testid="landing-blocker"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (b.runId !== null) onOpenRun(b.taskId, b.runId);
                  }}
                >
                  after #{b.position} {b.title}
                </ChipButton>
              ))}
            {item.position !== null && (
              <Chip data-testid="landing-position">
                #{item.position} of {board.inProgress.length}
              </Chip>
            )}
            <Chip data-testid="landing-stage">
              {STAGE_LABELS[item.stage]} · {formatStageElapsed(item.since, now)}
            </Chip>
            <StepStrip steps={item.steps} className={styles.steps} />
            {failed && (
              <RowAction
                label="Re-queue"
                testId="landing-requeue"
                disabled={isBusy}
                icon={<RotateCcw size={14} strokeWidth={1.8} aria-hidden />}
                onClick={() => requeue([runId])}
              />
            )}
            {item.position !== null && (
              <RowAction
                label={
                  canPullFromQueue(item)
                    ? 'Pull from queue'
                    : 'In progress — the queue cannot drop it now'
                }
                testId="landing-pull"
                disabled={isBusy || !canPullFromQueue(item)}
                icon={<ListX size={14} strokeWidth={1.8} aria-hidden />}
                onClick={() => pull(runId)}
              />
            )}
            {hasLog && (
              <RowAction
                label="Open verify log"
                testId="landing-log-open"
                icon={<FileText size={14} strokeWidth={1.8} aria-hidden />}
                onClick={() => setLogRunId(runId)}
              />
            )}
            <RowAction
              label="Open run"
              testId="landing-open-run"
              icon={<ArrowUpRight size={14} strokeWidth={1.8} aria-hidden />}
              onClick={() => onOpenRun(entry.taskId, runId)}
            />
          </span>
        }
      />
    );
  };

  return (
    <div className={styles.root} data-testid="landing-view">
      {header}
      {sections.length === 0 ? (
        <div className={styles.empty}>
          <EmptyState label="Nothing is headed for main">
            Runs show here from the moment they enter the merge queue until they
            land.
          </EmptyState>
        </div>
      ) : (
        <div role="list" className={styles.list}>
          {sections.map((section) => (
            <section
              key={section.id}
              data-testid={`landing-section-${section.id}`}
              className={styles.section}
            >
              <SectionHeader
                name={section.label}
                count={section.items.length}
              />
              {section.items.length === 0 ? (
                <p className={styles.quiet}>
                  {section.id === 'failed'
                    ? 'No failures — nothing needs you.'
                    : section.id === 'in-progress'
                      ? 'The queue is empty.'
                      : 'Nothing has landed yet today.'}
                </p>
              ) : (
                section.items.map(renderRow)
              )}
            </section>
          ))}
        </div>
      )}

      {/* Only appears once something is ticked, like the Tasks list's dispatch bar. */}
      {selectedFailed.length > 0 && (
        <div className={styles.bulk}>
          <span className={styles.bulkCount}>
            {selectedFailed.length} selected
          </span>
          <Button
            size="sm"
            variant="primary"
            data-testid="landing-requeue-selected"
            onClick={() => requeue(selectedFailed)}
          >
            Re-queue {selectedFailed.length}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      <LandingLogDialog item={logItem} onClose={() => setLogRunId(null)} />
    </div>
  );
}
