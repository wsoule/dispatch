import type { ApiClient, DocRevisionInfo } from '@dispatch/client';
import { Button, Checkbox, cx } from '@dispatch/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { docsKey, useDocDiff, useDocRevisions } from '../../hooks/useDocs';
import { describeError } from '../../lib/actionFeedback';
import { docDiffCacheKey, docDiffPatch, revisionAuthor } from '../../lib/docs';
import { relativeTime } from '../../lib/landingView';
import { DiffSurface } from '../code/DiffSurface';
import styles from './DocHistory.module.css';

interface DocHistoryProps {
  client: ApiClient;
  port: number | undefined;
  refId: string;
  canWrite: boolean;
  /** The diff's file name, which also picks its highlighting. */
  name?: string;
}

// How the routes name a revision: its number, or its id when it has none.
function revRef(r: DocRevisionInfo): string | number {
  return r.n ?? r.id;
}

// A doc's history: one row per revision, any two picked for a diff, and a
// Restore on each that writes that revision's text as a new head.
export function DocHistory({
  client,
  port,
  refId,
  canWrite,
  name = 'doc.md',
}: DocHistoryProps) {
  const queryClient = useQueryClient();
  const { revisions, error } = useDocRevisions(client, port, refId);
  // Picked ids in pick order; a third pick lets go of the first.
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Listed newest first, so the older of a pair is its second.
  const pair = revisions.filter((r) => picked.includes(r.id));
  const range =
    pair.length === 2 ? { from: revRef(pair[1]), to: revRef(pair[0]) } : null;
  const {
    diff,
    loading,
    error: diffError,
  } = useDocDiff(client, port, refId, range);
  const patch = useMemo(
    () => (diff === null ? undefined : docDiffPatch(name, diff.chunks)),
    [diff, name]
  );

  const pick = (id: string, on: boolean): void =>
    setPicked((p) =>
      on
        ? [...p.filter((x) => x !== id), id].slice(-2)
        : p.filter((x) => x !== id)
    );

  const restore = (r: DocRevisionInfo): void => {
    setRestoreError(null);
    void client.revertDoc(refId, revRef(r)).then(
      () => queryClient.invalidateQueries({ queryKey: docsKey(port) }),
      (err: unknown) => setRestoreError(describeError(err))
    );
  };

  const now = Date.now();
  return (
    <div className={styles.history}>
      {error !== null && (
        <p className={cx('toneText', styles.message)} data-tone="danger">
          {error.message}
        </p>
      )}
      {restoreError !== null && (
        <p
          role="alert"
          className={cx('toneText', styles.alert)}
          data-tone="danger"
        >
          {restoreError}
        </p>
      )}
      <ul aria-label="History" className={styles.list}>
        {revisions.map((r) => (
          <li key={r.id} className={styles.row}>
            <Checkbox
              label={`Compare rev ${r.n ?? '-'}`}
              hideLabel
              checked={picked.includes(r.id)}
              onChange={(on) => pick(r.id, on)}
            />
            <span className={cx('num', styles.rev)}>{`rev ${r.n ?? '-'}`}</span>
            <span className={cx('mono', styles.author)}>
              {revisionAuthor(r)}
            </span>
            <span className={styles.cause}>{r.cause}</span>
            <span className={styles.summary}>{r.summary}</span>
            <time dateTime={r.createdAt} className={cx('num', styles.time)}>
              {relativeTime(r.createdAt, now)}
            </time>
            {canWrite && (
              <Button size="sm" variant="quiet" onClick={() => restore(r)}>
                Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
      {range === null ? (
        <p className={styles.message}>
          {pair.length === 1
            ? 'Pick another revision to compare.'
            : 'Pick two revisions to compare them.'}
        </p>
      ) : (
        <div className={styles.diff}>
          {diffError !== null && (
            <p className={cx('toneText', styles.message)} data-tone="danger">
              {diffError.message}
            </p>
          )}
          {diff?.spent === true && (
            <p className={styles.note}>
              The diff hit its work limit, so some blocks show as replaced
              whole.
            </p>
          )}
          <DiffSurface
            patch={patch}
            loading={loading}
            cacheKeyPrefix={
              diff === null ? undefined : docDiffCacheKey(refId, diff)
            }
            emptyLabel="These revisions have the same text."
          />
        </div>
      )}
    </div>
  );
}
