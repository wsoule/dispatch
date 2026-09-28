import type { ApiClient, DocRevisionInfo } from '@dispatch/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { docsKey, refetchDocAfterSave, useDoc } from '../../hooks/useDocs';
import { describeError } from '../../lib/actionFeedback';
import type { DocBuffer } from '../../lib/docBuffer';
import {
  beginDocSave,
  docSaveConflicted,
  docSaveFailed,
  docSaveSucceeded,
  docShouldSave,
  editDocBuffer,
  openDocBuffer,
  reloadIfClean,
} from '../../lib/docBuffer';
import { docBadges, docStatusLine, revisionsSinceReview } from '../../lib/docs';
import { AUTOSAVE_DEBOUNCE_MS } from '../../lib/editorBuffer';
import { DocEditor } from './DocEditor';
import { DocLinksRail } from './DocLinksRail';
import { Button } from '@/ui/button';

interface DocPageProps {
  client: ApiClient;
  port: number | undefined;
  refId: string;
  canDecide: boolean;
}

// One doc: badges and actions, the links rail, and a markdown source editor
// with a preview toggle, autosaving with its base revision and body hash.
export function DocPage({ client, port, refId, canDecide }: DocPageProps) {
  const queryClient = useQueryClient();
  const { read, error } = useDoc(client, port, refId);
  const [buf, setBuf] = useState<DocBuffer | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // The revisions a Mark reviewed would cover, shown before it acts.
  const [confirming, setConfirming] = useState<DocRevisionInfo[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The save loop reads the latest buffer without re-arming on every keystroke.
  const bufRef = useRef<DocBuffer | null>(null);
  bufRef.current = buf;

  useEffect(() => {
    if (read === null) return;
    const base = { rev: read.rev.id, n: read.rev.n, hash: read.rev.hash };
    setBuf((prev) =>
      prev === null
        ? openDocBuffer(read.doc.id, read.text, base)
        : reloadIfClean(prev, read)
    );
  }, [read]);

  const save = useCallback(async () => {
    const current = bufRef.current;
    if (current === null || !docShouldSave(current)) return;
    const sending = beginDocSave(current);
    setBuf(sending);
    try {
      const out = await client.saveDocBody(refId, {
        baseRev: sending.base.rev,
        baseHash: sending.base.hash,
        body: sending.buffer.text,
      });
      // `in` narrows here: this app compiles without strictNullChecks, where `ok` does not.
      if ('conflict' in out) {
        const { conflict } = out;
        setBuf((prev) =>
          prev === null ? prev : docSaveConflicted(prev, conflict)
        );
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
        setBuf((prev) =>
          prev === null ? prev : docSaveSucceeded(prev, result, head)
        );
      }
    } catch (err) {
      setBuf((prev) =>
        prev === null ? prev : docSaveFailed(prev, describeError(err))
      );
    }
    await refetchDocAfterSave(queryClient, port, refId);
  }, [client, port, queryClient, refId]);

  useEffect(() => {
    if (buf === null || !docShouldSave(buf)) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [buf, save]);

  // Leaving the doc sends what the debounce still held rather than dropping it.
  useEffect(() => () => void save(), [save]);

  // Runs one header action, reporting its failure and refreshing the docs after it.
  const act = (work: () => Promise<unknown>): void => {
    setActionError(null);
    void work().then(
      () => queryClient.invalidateQueries({ queryKey: docsKey(port) }),
      (err: unknown) => setActionError(describeError(err))
    );
  };

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
                await save();
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
                const { revisions } = await client.listDocRevisions(refId);
                setConfirming(revisionsSinceReview(revisions, doc.reviewedRev));
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
                client.setDocStatus(refId, archived ? 'draft' : 'archived')
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
            onChange={(text) =>
              setBuf((prev) =>
                prev === null ? prev : editDocBuffer(prev, text)
              )
            }
          />
        </main>
        <DocLinksRail links={read.links} />
      </div>
    </div>
  );
}
