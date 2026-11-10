import type { LinearUnlinkedTask } from '@dispatch/client';
import { Button, Chip, cx, Disclosure, ProgressRule } from '@dispatch/ui';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { describeError } from '../../lib/actionFeedback';
import { formatRelativeTimeFromIso } from '../../lib/format';
import {
  describeBulkOutcome,
  describeUnlinkedCounts,
  formatLinearProgress,
  formatUntil,
  isRetryable,
  progressFor,
  retryableTaskIds,
  UNLINKED_REASON_LABEL,
} from '../../lib/linearSettings';
import styles from './LinearSettingsGroups.module.css';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';

// The attempts and timing of a create that failed or waits to be retried.
function attemptLine(task: LinearUnlinkedTask): string | null {
  if (task.attempts === 0 && task.retryAt === null) return null;
  const parts: string[] = [];
  if (task.attempts > 0) {
    const last =
      task.lastAttemptAt === null
        ? ''
        : `, last ${formatRelativeTimeFromIso(task.lastAttemptAt)}`;
    parts.push(`Tried ${String(task.attempts)}×${last}`);
  }
  if (task.retryAt !== null)
    parts.push(`next try ${formatUntil(task.retryAt)}`);
  return parts.join(' · ');
}

/** One task with no Linear record: its reason, its last error, and what can
 *  be done about it. */
function UnlinkedRow({
  task,
  canSend,
  onSend,
  onForget,
}: {
  task: LinearUnlinkedTask;
  canSend: boolean;
  onSend: (id: string) => Promise<void>;
  onForget: (id: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retryable = isRetryable(task.reason);
  const sendable = task.reason !== 'moved-out' && task.reason !== 'pull-only';
  async function act(work: (id: string) => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await work(task.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }
  const attempts = attemptLine(task);
  return (
    <div data-testid="linear-unlinked-row" className={styles.unlinkedRow}>
      <div className={styles.unlinkedText}>
        <div className={styles.unlinkedHead}>
          <span className={styles.unlinkedTitle}>{task.title}</span>
          {retryable && task.lastError !== null ? (
            <Chip tone="danger" filled>
              {UNLINKED_REASON_LABEL[task.reason]}
            </Chip>
          ) : (
            <Chip>{UNLINKED_REASON_LABEL[task.reason]}</Chip>
          )}
        </div>
        {task.lastError !== null && (
          <span className={cx('toneText', styles.error)} data-tone="danger">
            {task.lastError}
          </span>
        )}
        {attempts !== null && <SettingsHint>{attempts}</SettingsHint>}
        {task.reason === 'moved-out' && (
          <SettingsHint>
            Its issue moved to another team; link that team to follow it.
          </SettingsHint>
        )}
        {error !== null && (
          <span className={cx('toneText', styles.error)} data-tone="danger">
            {error}
          </span>
        )}
      </div>
      {sendable && (
        <div className={styles.unlinkedActions}>
          {retryable && (
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Stop retrying ${task.title}`}
              disabled={pending}
              onClick={() => void act(onForget)}
            >
              Stop retrying
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            aria-label={`${retryable ? 'Retry' : 'Send'} ${task.title}`}
            disabled={!canSend || pending}
            onClick={() => void act(onSend)}
          >
            {retryable ? 'Retry' : 'Send'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Settings → Linear → Coverage: how many tasks have a Linear record, why the
 *  rest do not, and a way to send or stop retrying each. */
export function LinearCoverageGroup({
  data,
  configured,
}: {
  data: DispatchProjectData;
  configured: boolean;
}) {
  const status = data.linearStatus;
  const coverage = data.linearCoverage;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  if (status === null) return null;
  const counts = status.coverage ?? null;
  // An older daemon has no coverage route: say so rather than count forever.
  const fetchError = data.linearCoverageError ?? null;
  const total = coverage?.total ?? counts?.total ?? null;
  const linked = coverage?.linked ?? counts?.linked ?? null;
  const derived = coverage?.excluded.derived ?? counts?.excluded ?? 0;
  const running = status.running ?? null;
  const canSend = configured && status.direction !== 'pull' && running === null;
  const retryIds = coverage === null ? [] : retryableTaskIds(coverage);
  const progress = progressFor(status.progress, 'retry');
  const lastRetry =
    status.lastExport?.action === 'retry' ? status.lastExport : null;
  const outcome = describeBulkOutcome(lastRetry);

  async function retryAll() {
    setRetrying(true);
    setRetryError(null);
    try {
      await data.handleRetryLinear(retryIds);
    } catch (err) {
      setRetryError(describeError(err));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <SettingsGroup
      title="Coverage"
      hint="Which tasks have a Linear record, and why the rest do not."
      keywords="linear coverage unlinked missing retry"
      requires="none"
    >
      <SettingsRow
        title="In Linear"
        subtitle={
          total === null || linked === null
            ? fetchError === null
              ? 'Counting…'
              : `Couldn’t count: ${describeError(fetchError)}`
            : `${linked.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} tasks${
                derived > 0
                  ? ` · ${derived.toLocaleString('en-US')} PR review tasks never sync`
                  : ''
              }`
        }
      >
        {total !== null && linked !== null && total > 0 && (
          <ProgressRule
            aria-label="Tasks in Linear"
            done={linked}
            total={total}
            label={null}
          />
        )}
      </SettingsRow>

      {coverage !== null && (
        <SettingsRow
          title="Not in Linear"
          subtitle={describeUnlinkedCounts(coverage.counts)}
          control={
            retryIds.length > 0 ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={!canSend || retrying}
                onClick={() => void retryAll()}
              >
                {`Retry now (${String(retryIds.length)})`}
              </Button>
            ) : undefined
          }
        >
          {progress !== null && (
            <SettingsHint>{formatLinearProgress(progress)}</SettingsHint>
          )}
          {outcome !== null && <SettingsHint>{outcome}</SettingsHint>}
          {retryError !== null && (
            <span className={cx('toneText', styles.error)} data-tone="danger">
              {retryError}
            </span>
          )}
          {coverage.unlinked.length > 0 && (
            <Disclosure
              summary={`Show ${coverage.unlinked.length.toLocaleString('en-US')} tasks`}
            >
              <div className={styles.unlinkedList}>
                {coverage.unlinked.map((task) => (
                  <UnlinkedRow
                    key={task.id}
                    task={task}
                    canSend={canSend}
                    onSend={async (id) => {
                      await data.handleRetryLinear([id]);
                    }}
                    onForget={async (id) => {
                      await data.handleForgetLinear([id]);
                    }}
                  />
                ))}
              </div>
            </Disclosure>
          )}
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
