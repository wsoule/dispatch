import type { ApiClient, DocRevisionInfo } from '@dispatch/client';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { docsKey, useDocDiff, useDocRevisions } from '../../hooks/useDocs';
import { describeError } from '../../lib/actionFeedback';
import { docDiffCacheKey, docDiffPatch } from '../../lib/docs';
import { relativeTime } from '../../lib/landingView';
import { DiffSurface } from '../code/DiffSurface';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';

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
    <div className="flex h-full min-h-0 flex-col">
      {error !== null && (
        <p className="p-3 text-xs text-[var(--color-destructive)]">
          {error.message}
        </p>
      )}
      {restoreError !== null && (
        <p
          role="alert"
          className="border-b border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-destructive)]"
        >
          {restoreError}
        </p>
      )}
      <ul
        aria-label="History"
        className="max-h-[40%] shrink-0 overflow-auto border-b border-[var(--color-border)] p-1 text-xs"
      >
        {revisions.map((r) => (
          <li
            key={r.id}
            className="rounded-control hover:bg-surface-control flex items-center gap-2 px-2 py-1"
          >
            <Checkbox
              checked={picked.includes(r.id)}
              onCheckedChange={(on) => pick(r.id, on)}
              aria-label={`Compare rev ${r.n ?? '-'}`}
            />
            <span className="shrink-0 font-medium">{`rev ${r.n ?? '-'}`}</span>
            <span className="shrink-0 font-mono">{r.author}</span>
            <span className="shrink-0 text-[var(--color-muted-foreground)]">
              {r.cause}
            </span>
            <span className="min-w-0 flex-1 truncate">{r.summary}</span>
            <time
              dateTime={r.createdAt}
              className="shrink-0 text-[var(--color-muted-foreground)]"
            >
              {relativeTime(r.createdAt, now)}
            </time>
            {canWrite && (
              <Button size="sm" variant="ghost" onClick={() => restore(r)}>
                Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
      {range === null ? (
        <p className="p-3 text-xs text-[var(--color-muted-foreground)]">
          {pair.length === 1
            ? 'Pick another revision to compare.'
            : 'Pick two revisions to compare them.'}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {diffError !== null && (
            <p className="p-3 text-xs text-[var(--color-destructive)]">
              {diffError.message}
            </p>
          )}
          {diff?.spent === true && (
            <p className="px-3 py-1 text-xs text-[var(--color-muted-foreground)]">
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
