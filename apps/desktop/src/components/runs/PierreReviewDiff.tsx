import type {
  ApiClient,
  Finding,
  ReviewComment,
  RunMeta,
} from '@dispatch/client';
import type { CodeViewItem, FileContents } from '@pierre/diffs';
import { processPatch } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import { CodeView, EditProvider } from '@pierre/diffs/react';
import { MessageSquarePlus, Pencil, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ErrorBoundary } from '../shell/ErrorBoundary';
import { PierreWorkerPool } from './PierreWorkerPool';
import { ReviewComposer, ReviewThread } from './ReviewThread';
import { useDiffDisplaySettings } from '@/hooks/useDiffDisplaySettings';
import { useRunFileLoader } from '@/hooks/useRunFileContents';
import { toDiffRenderOptions } from '@/lib/diffDisplay';
import { createReviewEditor } from '@/lib/pierreEditor';
import type { Annotation } from '@/lib/reviewDiffItems';
import {
  buildItems,
  editErrorMessage,
  isRecoverableEditError,
} from '@/lib/reviewDiffItems';
import { isTerminalRunState } from '@/lib/runState';

interface PierreReviewDiffProps {
  /** Backs the contents loader that fills in what a patch's own hunks don't carry — omitted
   * (or `null`) call sites simply render without hunk expansion, same as before the loader
   * existed, rather than the diff itself failing. */
  client?: ApiClient | null;
  /** The run whose worktree `loadDiffFiles` reads from. Omit where there is no run to read from
   * (a GitHub PR) — see `client` above for what that degrades to. */
  runId?: string;
  /** The run this diff belongs to — drives whether edit mode is offered at all. Omit for a
   * GitHub PR target: there is no run worktree to write an edit into, so edit mode stays off
   * the same way `onAdd` being omitted turns off commenting. */
  meta?: RunMeta;
  patch: string;
  comments: ReviewComment[];
  /**
   * Where a new line comment goes. Omit it when there is nowhere to put one
   * (a GitHub PR) and the gutter's "+" is withheld rather than left dead.
   */
  onAdd?: (input: {
    file: string;
    line: number;
    startLine?: number;
    anchorText: string;
    body: string;
  }) => Promise<void>;
  onResolve: (commentId: string, resolved: boolean) => Promise<void>;
  onReply: (commentId: string, body: string) => Promise<void>;
  /** Files the reviewer has ticked off — rendered collapsed, the way GitHub does. */
  viewed?: ReadonlySet<string>;
  /** Restricts rendering to one file. Omit for the whole patch in one scroller. */
  only?: string;
  /** Open agent-review findings, rendered on their own lines beside the reviewer's threads. */
  findings?: Finding[];
  /**
   * A comment to scroll to. Changing this scrolls the diff; the caller bumps it (rather than
   * calling a method) so the jump is declarative and survives the view remounting.
   */
  scrollTo?: { file: string; line: number; nonce: number } | null;
}

/**
 * The review diff: Pierre's `CodeView` with comment threads injected as line annotations.
 *
 * An earlier version of this parsed the patch by hand and drew its own rows, on the belief that
 * Pierre exposed no per-line hook. That was simply wrong — `CodeView` takes `annotations` per
 * file/side/line and hands them back through `renderAnnotation`, which is exactly the mechanism
 * GitHub-style inline threads need. Using it means the diff keeps syntax highlighting,
 * virtualisation, hunk expansion and the worker pool, none of which a hand-rolled renderer had.
 *
 * `renderGutterUtility` supplies the hover affordance on each line, so starting a comment is the
 * same gesture as on GitHub: hover the line, click the +.
 */
export function PierreReviewDiff({
  client,
  runId,
  meta,
  patch,
  comments,
  onAdd,
  onResolve,
  onReply,
  viewed,
  only,
  findings,
  scrollTo,
}: PierreReviewDiffProps) {
  // Where a composer is currently open, keyed the same way annotations are.
  const [composing, setComposing] = useState<{
    file: string;
    line: number;
    /** Set when the reviewer had a range selected — the comment covers startLine..line. */
    startLine?: number;
    anchorText: string;
  } | null>(null);
  // The live line selection. Pierre owns the drag; this only reads it, so that clicking the
  // gutter + on a selected range comments on the whole range rather than the one line hovered.
  const [selection, setSelection] = useState<{
    start: number;
    end: number;
    side?: string;
  } | null>(null);
  // The one file currently in edit mode, or the one whose load is in flight from a pencil
  // click — only ever one of each, see `buildItems`'s doc comment for why.
  const [editing, setEditing] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<string | null>(null);
  // Files whose contents `ensureLoaded` has confirmed resolved — the load gate `buildItems`
  // reads before ever setting `edit: true`. Evicted on a successful save (alongside the
  // loader's own cache) so the next edit re-confirms fresh contents rather than trusting a
  // generation that's now stale on disk.
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
  const [editError, setEditError] = useState<{
    file: string;
    message: string;
  } | null>(null);
  // The sha `ensureLoaded` returned when a file's edit session began — the precondition
  // `applyRunEdit` needs. A ref, not state: it never drives a render on its own, only reads
  // triggered by `onItemEditComplete`.
  const baseShaRef = useRef(new Map<string, string>());
  const viewRef = useRef<CodeViewHandle<Annotation> | null>(null);
  const [diffDisplay] = useDiffDisplaySettings();
  // A patch's hunks alone don't carry the rest of the file — this loader fetches it from the
  // run's worktree, which is what makes unchanged-region expansion (and editing) possible at
  // all.
  const { loadDiffFiles, ensureLoaded, invalidate } = useRunFileLoader(
    client ?? null,
    runId
  );
  const diffOptions = useMemo(
    () => ({ ...toDiffRenderOptions(diffDisplay), loadDiffFiles }),
    [diffDisplay, loadDiffFiles]
  );

  const files = useMemo(() => {
    try {
      const parsed = processPatch(patch, 'review');
      return only === undefined
        ? parsed.files
        : parsed.files.filter((f) => f.name === only);
    } catch {
      // A patch Pierre cannot parse should cost the diff, not the whole review surface — the
      // comment panel beside it still works.
      return [];
    }
  }, [patch, only]);

  // Edit mode at all requires a run that's done and not yet reviewed — mirrors how
  // `RunReviewView` hides its PR action when the project can't open one: hidden outright
  // rather than shown disabled, since there's nothing the reviewer could do about either case
  // from here. A run still in progress can have its worktree written to by the agent at any
  // moment (the same race `applyRunEdit`'s `worktree-busy` guards server-side), and a
  // reviewed run's worktree/branch are done being touched.
  const canEdit =
    meta !== undefined &&
    isTerminalRunState(meta.state) &&
    meta.reviewedAt === undefined;

  const items = useMemo(
    () =>
      buildItems({
        files,
        comments,
        findings,
        composing,
        viewed,
        editing,
        loaded,
      }),
    [files, comments, findings, composing, viewed, editing, loaded]
  );

  const renderAnnotation = useCallback(
    (annotation: { metadata?: Annotation }) => {
      // Named `annMeta` rather than `meta` — this component also takes a `meta: RunMeta` prop,
      // and shadowing it here would make the two easy to confuse mid-scroll through this file.
      const annMeta = annotation.metadata;
      if (annMeta === undefined) return null;
      if (annMeta.kind === 'composer') {
        return (
          <ReviewComposer
            line={composing?.line ?? 0}
            startLine={annMeta.startLine}
            onCancel={() => setComposing(null)}
            onSubmit={(body) => {
              void onAdd?.({
                file: annMeta.file,
                line: composing?.line ?? 0,
                startLine: annMeta.startLine,
                anchorText: annMeta.anchorText,
                body,
              });
              setComposing(null);
            }}
          />
        );
      }
      if (annMeta.kind === 'findings') {
        return (
          <div className="flex flex-col gap-1 py-1">
            {annMeta.findings.map((f) => (
              <div
                key={f.id}
                className="border-state-waiting/40 bg-state-waiting/5 rounded-md border-l-2 px-2 py-1"
              >
                <div className="flex items-center gap-1.5 text-[12px]">
                  <TriangleAlert className="text-state-waiting size-3 shrink-0" />
                  {/* Marked as the agent's claim rather than the reviewer's note: the two sit on
                      the same line and must not be mistaken for each other. */}
                  <span className="dense-meta shrink-0">
                    agent · {f.severity}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{f.title}</span>
                </div>
                <p className="text-muted-foreground text-[11px] leading-snug">
                  {f.detail}
                </p>
              </div>
            ))}
          </div>
        );
      }
      return (
        <div className="flex flex-col">
          {annMeta.comments.map((c) => (
            <ReviewThread
              key={c.id}
              comment={c}
              // Rendered against the line Pierre placed it on, so within this view it is by
              // definition where it belongs; drift against the working tree is reported by the
              // store's own anchor check.
              anchor="exact"
              onResolve={(resolved) => void onResolve(c.id, resolved)}
              onReply={(body) => void onReply(c.id, body)}
            />
          ))}
        </div>
      );
    },
    [composing, onAdd, onResolve, onReply]
  );

  const renderGutterUtility = useCallback(
    (
      getHoveredLine: () => { lineNumber?: number; side?: string } | undefined,
      item: { id: string }
    ) => {
      // The file being edited already has the caret fighting for the same click — withholding
      // the "+" here keeps the two from competing over the same gesture.
      if (editing === item.id) return null;
      return (
        <button
          type="button"
          aria-label="Comment on this line"
          onClick={() => {
            const hovered = getHoveredLine();
            const line = hovered?.lineNumber;
            // Only the additions side can be commented on: a deleted line is not there for the
            // agent to change, so a note anchored to it would point at nothing.
            if (line === undefined || hovered?.side === 'deletions') return;
            // If the reviewer dragged a range that contains this line, comment on the whole
            // range — that is what the selection was for. Otherwise it is a single line.
            const inRange =
              selection !== null &&
              selection.side !== 'deletions' &&
              line >= Math.min(selection.start, selection.end) &&
              line <= Math.max(selection.start, selection.end);
            setComposing({
              file: item.id,
              line: inRange ? Math.max(selection.start, selection.end) : line,
              ...(inRange
                ? { startLine: Math.min(selection.start, selection.end) }
                : {}),
              anchorText: '',
            });
          }}
          className="text-muted-foreground hover:text-accent-foreground grid size-4 place-items-center"
        >
          <MessageSquarePlus className="size-3" />
        </button>
      );
    },
    [selection, editing]
  );

  // Begins an edit session for `file`, gated on its contents actually being in hand — see
  // `buildItems`'s doc comment for why `editing` alone is not enough to set `edit: true` safely.
  // Guards against a second pencil click landing mid-flight: `pendingEdit` blocks a duplicate
  // `ensureLoaded` call for the same load, and `editing !== null` blocks starting a second file
  // while one is already open (only one file is ever editable at once).
  const beginEdit = useCallback(
    (file: string) => {
      if (pendingEdit !== null || editing !== null) return;
      setEditError(null);
      setPendingEdit(file);
      void ensureLoaded(file).then((result) => {
        setPendingEdit(null);
        if (result === null) {
          setEditError({ file, message: "Couldn't load this file." });
          return;
        }
        baseShaRef.current.set(file, result.sha);
        setLoaded((prev) => new Set(prev).add(file));
        setEditing(file);
      });
    },
    [ensureLoaded, pendingEdit, editing]
  );

  // Ends the current edit session by clearing `editing` — `buildItems` recomputes `edit: false`
  // for that item on the next render, which is what makes `CodeView` tear the editor down and
  // call `onItemEditComplete` (below) with its final text.
  const endEdit = useCallback((file: string) => {
    setEditing((current) => (current === file ? null : current));
  }, []);

  const handleEditComplete = useCallback(
    (item: CodeViewItem<Annotation>, file: FileContents) => {
      const baseSha = baseShaRef.current.get(item.id);
      // No recorded sha means this item's edit session never went through `beginEdit` (so
      // never through the load gate either) — there is nothing safe to save against.
      if (client == null || runId === undefined || baseSha === undefined) {
        setEditing(null);
        return;
      }
      void client
        .applyRunEdit(runId, {
          file: item.id,
          contents: file.contents,
          baseSha,
        })
        .then(() => {
          // The sha and contents on disk just changed — without evicting both caches, the
          // reviewer's next edit to this file would send a stale `baseSha` and the server
          // would reject it with 409 stale-base.
          invalidate(item.id);
          baseShaRef.current.delete(item.id);
          setLoaded((prev) => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
          setEditError(null);
          setEditing(null);
        })
        .catch((err: unknown) => {
          setEditError({ file: item.id, message: editErrorMessage(err) });
          // worktree-busy and stale-base are both worth retrying without losing the edit —
          // leaving `editing` pointed at this file re-enters edit mode on the next render
          // rather than discarding the reviewer's work. The other failures (worktree gone,
          // nothing to write) have nothing left to retry into.
          setEditing(isRecoverableEditError(err) ? item.id : null);
        });
    },
    [client, runId, invalidate]
  );

  const renderHeaderMetadata = useCallback(
    (item: { id: string }) => {
      if (!canEdit) return null;
      const isEditing = editing === item.id;
      // Disabled for every file while any one file's load is in flight, not just the file it's
      // for — `beginEdit` itself refuses to start a second load until this one settles, so a
      // click on a different file's pencil during that window would otherwise look live but do
      // nothing.
      const isPending = pendingEdit !== null;
      const error = editError?.file === item.id ? editError.message : null;
      // While another file is being edited, its pencil is the only one that should be
      // clickable — showing the rest as live buttons would suggest a second file could be
      // opened for edit at the same time, which `editing` can never represent.
      if (editing !== null && !isEditing) return null;
      return (
        <span className="flex items-center gap-1.5">
          {error !== null && (
            <span className="text-destructive text-[11px]">{error}</span>
          )}
          <button
            type="button"
            aria-label={isEditing ? 'Stop editing this file' : 'Edit this file'}
            disabled={isPending}
            onClick={() => (isEditing ? endEdit(item.id) : beginEdit(item.id))}
            className="text-muted-foreground hover:text-accent-foreground grid size-4 place-items-center disabled:opacity-50"
          >
            <Pencil
              className={isEditing ? 'text-accent-foreground size-3' : 'size-3'}
            />
          </button>
        </span>
      );
    },
    [canEdit, editing, pendingEdit, editError, beginEdit, endEdit]
  );

  // Declarative jump: the effect fires when `scrollTo` changes identity, so clicking the same
  // thread twice still scrolls (the caller bumps `nonce`).
  useEffect(() => {
    if (scrollTo == null) return;
    viewRef.current?.scrollTo({
      type: 'line',
      id: scrollTo.file,
      lineNumber: scrollTo.line,
      side: 'additions',
      align: 'center',
    });
  }, [scrollTo]);

  if (files.length === 0) {
    return (
      <p className="text-muted-foreground p-4 text-[12.5px]">
        No changes to show.
      </p>
    );
  }

  return (
    <ErrorBoundary>
      <PierreWorkerPool lineDiffType={diffOptions.lineDiffType}>
        {/* `EditProvider` has to be an ancestor of `CodeView` — it's how `CodeView` resolves the
            editor factory an `edit: true` item needs. `createReviewEditor` is the one place
            those options are decided, shared with every other editable surface. */}
        <EditProvider createEditor={createReviewEditor}>
          <CodeView<Annotation>
            ref={viewRef}
            items={items}
            options={diffOptions}
            onSelectedLinesChange={(sel) =>
              setSelection(
                sel === null
                  ? null
                  : {
                      start: sel.range.start,
                      end: sel.range.end,
                      side: sel.range.side,
                    }
              )
            }
            renderAnnotation={renderAnnotation}
            renderHeaderMetadata={renderHeaderMetadata}
            onItemEditComplete={handleEditComplete}
            // No `onAdd` means no destination for a comment, so the hover "+"
            // that starts one is not offered at all.
            renderGutterUtility={
              onAdd === undefined ? undefined : renderGutterUtility
            }
            // `CodeView` attaches its own scroll listener to this exact element and reads its
            // own `scrollTop` to decide which virtualized rows to render — an ancestor owning
            // the `overflow-auto` instead leaves this element's `scrollTop` permanently 0, so
            // the window of rendered rows never advances past the first screenful. This element
            // must be the actual scroll container.
            //
            // `flex-1` rather than `size-full`/`h-full`: the caller (`ReviewView`) makes this
            // element's parent a flex column, so this sizes directly off that container's own
            // resolved height. A percentage height here would instead have to resolve through
            // that flex column's own height, which itself was only ever a stretch-resolved grid
            // cell — a chain some engines collapse to zero rather than a real pixel value, which
            // reads as this pane rendering only its (non-virtualized) file header and nothing
            // else. `flex-1` sizes off the immediate container directly, with no such chain.
            className="min-h-0 w-full flex-1 overflow-auto"
          />
        </EditProvider>
      </PierreWorkerPool>
    </ErrorBoundary>
  );
}
