import type { ApiClient, DocRevisionInfo } from '@dispatch/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { docsKey, refetchDocAfterSave, useDoc } from '../../hooks/useDocs';
import { describeError } from '../../lib/actionFeedback';
import type { DocBuffer } from '../../lib/docBuffer';
import {
  autosaveDelay,
  beginDocSave,
  docSaveConflicted,
  docSaveFailed,
  docSaveSucceeded,
  docSealProblem,
  docShouldSave,
  editDocBuffer,
  isRefusal,
  openDocBuffer,
  reloadIfClean,
} from '../../lib/docBuffer';
import {
  anchorLine,
  docBadges,
  docStatusLine,
  revisionsSinceReview,
  sameRevisions,
} from '../../lib/docs';
import { DocEditor } from './DocEditor';
import { DocLinksRail } from './DocLinksRail';
import { Button } from '@/ui/button';

interface DocPageProps {
  client: ApiClient;
  port: number | undefined;
  refId: string;
  canDecide: boolean;
  /** The section a link named, whose heading the editor opens on. */
  anchor?: string | null;
}

// The most saves one flush sends; a 409 on the way marks the text against the
// new head, which then goes out again.
const FLUSH_SAVES = 3;

// One doc: badges and actions, the links rail, and a markdown source editor
// with a preview toggle, autosaving with its base revision and body hash.
export function DocPage({
  client,
  port,
  refId,
  canDecide,
  anchor = null,
}: DocPageProps) {
  const queryClient = useQueryClient();
  const { read, error } = useDoc(client, port, refId);
  // The buffer lives in a ref so a save that lands after unmount still sees
  // it; `buf` mirrors it for rendering and the autosave timer.
  const bufRef = useRef<DocBuffer | null>(null);
  const [buf, setBuf] = useState<DocBuffer | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const [previewing, setPreviewing] = useState(false);
  // The revisions a Mark reviewed would cover, shown before it acts.
  const [confirming, setConfirming] = useState<DocRevisionInfo[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Where the editor opens: placed once per named anchor, so later reads of
  // the same doc never move the caret out from under typing.
  const [placeAt, setPlaceAt] = useState<{ line: number } | null>(null);
  const placedFor = useRef<string | null>(null);

  const update = useCallback((next: (b: DocBuffer) => DocBuffer): void => {
    if (bufRef.current === null) return;
    bufRef.current = next(bufRef.current);
    setBuf(bufRef.current);
  }, []);

  useEffect(() => {
    if (read === null) return;
    const base = { rev: read.rev.id, n: read.rev.n, hash: read.rev.hash };
    bufRef.current =
      bufRef.current === null
        ? openDocBuffer(read.doc.id, read.text, base)
        : reloadIfClean(bufRef.current, read);
    setBuf(bufRef.current);
  }, [read]);

  useEffect(() => {
    if (anchor === null) placedFor.current = null;
    if (read === null || anchor === null || placedFor.current === anchor) {
      return;
    }
    placedFor.current = anchor;
    const line = anchorLine(read.outline, anchor);
    if (line !== null) setPlaceAt({ line });
  }, [read, anchor]);

  // Sends the buffer once, unless there is nothing to send or a save is out.
  const save = useCallback((): Promise<void> => {
    const current = bufRef.current;
    if (current === null || !docShouldSave(current)) {
      return Promise.resolve();
    }
    const sending = beginDocSave(current);
    bufRef.current = sending;
    setBuf(sending);
    const since = Date.now();
    const run = async (): Promise<void> => {
      try {
        const out = await client.saveDocBody(refId, {
          baseRev: sending.base.rev,
          baseHash: sending.base.hash,
          body: sending.buffer.text,
        });
        // `in` narrows here: this app compiles without strictNullChecks, where `ok` does not.
        if ('conflict' in out) {
          const { conflict } = out;
          update((b) => docSaveConflicted(b, conflict));
        } else {
          const { result } = out;
          // The save landed either way; without the merged text the buffer keeps its own.
          const head =
            result.status === 'merged'
              ? await client.getDoc(refId, { rev: result.rev.id }).then(
                  (r) => r.text,
                  () => null
                )
              : null;
          update((b) => docSaveSucceeded(b, result, head));
        }
      } catch (err) {
        update((b) => docSaveFailed(b, describeError(err), isRefusal(err)));
      }
      if (!mounted.current) return;
      const fresh = await refetchDocAfterSave(queryClient, port, refId, since);
      if (fresh !== null) update((b) => reloadIfClean(b, fresh));
    };
    const pending: Promise<void> = run().finally(() => {
      if (inFlight.current === pending) inFlight.current = null;
    });
    inFlight.current = pending;
    return pending;
  }, [client, port, queryClient, refId, update]);

  useEffect(() => {
    if (buf === null || !docShouldSave(buf)) return;
    const timer = setTimeout(() => void save(), autosaveDelay(buf));
    return () => clearTimeout(timer);
  }, [buf, save]);

  // Waits out every save in flight, then sends what the debounce or the
  // conflict hold still kept; leaving and Save version both use it.
  const flush = useCallback(async (): Promise<void> => {
    for (let i = 0; i < FLUSH_SAVES; i += 1) {
      while (inFlight.current !== null) await inFlight.current;
      const current = bufRef.current;
      if (current === null || !docShouldSave(current)) return;
      await save();
    }
  }, [save]);

  // Read through a ref so a new connection's `save` does not count as leaving.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void flushRef.current();
    };
  }, []);

  // Runs one header action, reporting its failure and refreshing the docs after it.
  const act = (work: () => Promise<unknown>): void => {
    setActionError(null);
    void work().then(
      () => queryClient.invalidateQueries({ queryKey: docsKey(port) }),
      (err: unknown) => setActionError(describeError(err))
    );
  };

  // The revisions a review would cover now, newest first.
  const unreviewedRevisions = async (
    reviewedRev: string | null
  ): Promise<DocRevisionInfo[]> =>
    revisionsSinceReview(
      (await client.listDocRevisions(refId)).revisions,
      reviewedRev
    );

  if (read === null || buf === null) {
    return error === null ? null : (
      <p className="p-4 text-xs text-[var(--color-destructive)]">
        {error.message}
      </p>
    );
  }
  const doc = read.doc;
  const archived = doc.status === 'archived';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <h2 className="truncate text-sm font-medium">{doc.title}</h2>
        <span className="text-xs text-[var(--color-muted-foreground)]">
          {doc.handle}
        </span>
        {docBadges(doc).map((b) => (
          <span
            key={b}
            className="rounded bg-[var(--color-muted)] px-1 text-[10px]"
          >
            {b}
          </span>
        ))}
        <span
          className={`ml-auto text-xs ${
            buf.buffer.status === 'error'
              ? 'text-[var(--color-destructive)]'
              : 'text-[var(--color-muted-foreground)]'
          }`}
        >
          {docStatusLine(buf)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPreviewing((p) => !p)}
        >
          {previewing ? 'Source' : 'Preview'}
        </Button>
        {!archived && !doc.head.sealed && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              act(async () => {
                await flush();
                const problem =
                  bufRef.current === null
                    ? null
                    : docSealProblem(bufRef.current);
                if (problem !== null) throw new Error(problem);
                await client.sealDoc(refId);
              })
            }
          >
            Save version
          </Button>
        )}
        {canDecide && doc.unreviewed && (
          <Button
            size="sm"
            onClick={() =>
              act(async () => {
                setConfirming(await unreviewedRevisions(doc.reviewedRev));
              })
            }
          >
            Mark reviewed
          </Button>
        )}
        {canDecide && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              act(() =>
                client.setDocStatus(
                  refId,
                  archived ? (doc.archivedFrom ?? 'draft') : 'archived'
                )
              )
            }
          >
            {archived ? 'Restore' : 'Archive'}
          </Button>
        )}
      </header>
      {actionError !== null && (
        <p
          role="alert"
          className="border-b border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-destructive)]"
        >
          {actionError}
        </p>
      )}
      {confirming !== null && (
        <div className="flex flex-col gap-1 border-b border-[var(--color-border)] px-3 py-2 text-xs">
          <p>Marking reviewed covers:</p>
          <ul>
            {confirming.map((r) => (
              <li
                key={r.id}
              >{`rev ${r.n ?? '-'} · ${r.author} · ${r.summary}`}</li>
            ))}
          </ul>
          <div className="flex gap-1">
            <Button
              size="sm"
              onClick={() =>
                act(async () => {
                  // POST /reviewed reviews whatever the head is now, so a list
                  // that moved since it loaded is shown again first.
                  const now = await unreviewedRevisions(doc.reviewedRev);
                  if (!sameRevisions(now, confirming)) {
                    setConfirming(now);
                    setActionError(
                      'The doc changed since this list loaded. Check it again.'
                    );
                    return;
                  }
                  await client.markDocReviewed(refId);
                  setConfirming(null);
                })
              }
            >
              Confirm reviewed
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {buf.conflict !== null && (
        <p
          role="alert"
          className="bg-state-waiting-surface text-state-waiting border-b border-[var(--color-border)] px-3 py-1 text-xs"
        >
          {`Rev ${buf.conflict.headN} by ${buf.conflict.headAuthor} changed the same lines. Resolve the marked blocks, then save.`}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          <DocEditor
            text={buf.buffer.text}
            label={`Editing ${doc.handle}`}
            previewing={previewing}
            readOnly={archived}
            onChange={(text) => update((b) => editDocBuffer(b, text))}
            placeAt={placeAt}
          />
        </main>
        <DocLinksRail links={read.links} />
      </div>
    </div>
  );
}
