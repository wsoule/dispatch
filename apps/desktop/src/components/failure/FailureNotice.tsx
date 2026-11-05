import { explainFailure } from '@dispatch-foo/core/browser';
import { Button, cx, Disclosure, Notice } from '@dispatch/ui';
import { CircleAlert } from 'lucide-react';
import { useState } from 'react';

import { RawText } from '../gr8r/RawText';
import { useOptionalShellActions } from '../shell/ShellActionsContext';
import styles from './FailureNotice.module.css';

/** What "Ask the agent to fix it" sends: the failure verbatim and what to do about it. */
export function askAgentToFix(error: string): string {
  return `The last attempt failed with this error:\n\n${error}\n\nFind the cause, fix it, then finish the task.`;
}

interface FailureNoticeProps {
  /** The raw failure text from a draft, a run or an Overseer turn. */
  error: string;
  /** Catalog id of the agent that failed, so a sign-in reason can name it. */
  providerId?: string;
  onRetry?: () => Promise<void> | void;
  onAskAgent?: () => Promise<void> | void;
}

/**
 * A failure as one plain sentence and the fix that applies: Settings → Setup for a
 * missing tool or a sign-in, otherwise Try again and Ask the agent to fix it. It is the
 * library's danger Notice (role alert), with the raw error behind a Details fold.
 */
export function FailureNotice({
  error,
  providerId,
  onRetry,
  onAskAgent,
}: FailureNoticeProps) {
  const shell = useOptionalShellActions();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const explained = explainFailure(
    error,
    providerId === undefined ? {} : { providerId }
  );
  const firstLine = error.trim().split('\n')[0] ?? '';
  const sentence =
    explained?.reason ??
    (firstLine === '' ? 'Something went wrong.' : firstLine);
  const showDetails = explained !== null || error.trim() !== firstLine;
  const toSetup =
    explained?.fix === 'setup-agent' || explained?.fix === 'setup-git';

  async function run(action: () => Promise<void> | void) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const actions = toSetup ? (
    shell !== null && (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => shell.setGlobalView('settings', { page: 'setup' })}
      >
        Fix in Settings → Setup
      </Button>
    )
  ) : (
    <>
      {onRetry !== undefined && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void run(onRetry)}
        >
          Try again
        </Button>
      )}
      {onAskAgent !== undefined && (
        <Button
          size="sm"
          variant="quiet"
          disabled={busy}
          onClick={() => void run(onAskAgent)}
        >
          Ask the agent to fix it
        </Button>
      )}
    </>
  );

  return (
    <Notice tone="danger" role="alert" data-slot="failure-notice">
      <div className={styles.content}>
        <p className={styles.sentence}>
          <CircleAlert
            aria-hidden="true"
            className={styles.icon}
            size={14}
            strokeWidth={1.8}
          />
          <span>{sentence}</span>
        </p>
        <div className={styles.actions}>{actions}</div>
        {actionError !== null && (
          <p className={cx('toneText', styles.actionError)} data-tone="danger">
            {actionError}
          </p>
        )}
        {showDetails && (
          <div className={styles.details}>
            <Disclosure summary="Details">
              <RawText className={styles.raw}>{error}</RawText>
            </Disclosure>
          </div>
        )}
      </div>
    </Notice>
  );
}
