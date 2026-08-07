import type {
  ApiClient,
  Finding,
  ReviewComment,
  RunMeta,
} from '@dispatch/client';
import type {
  CodeViewItem,
  FileContents,
  FileDiffMetadata,
} from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import { MessageSquarePlus, Pencil, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DiffSurface, useParsedPatchFiles } from '../code/DiffSurface';
import { ReviewComposer, ReviewThread } from './ReviewThread';
import { useRunFileLoader } from '@/hooks/useRunFileContents';
import { createReviewEditor } from '@/lib/pierreEditor';
import type { Annotation } from '@/lib/reviewDiffItems';
import {
  buildItems,
  decideEditSave,
  editErrorMessage,
  isEditableDiffType,
  resolveEditFailure,
} from '@/lib/reviewDiffItems';
import { isTerminalRunState } from '@/lib/runState';
import type { ApplySuggestionOutcome } from '@/lib/suggestionRange';

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
   *
   * Resolves with the created comment, not `void` — the composer's `Apply now` action needs
   * the new comment's id back to apply its suggestion immediately, through the same path the
   * thread's own Apply button uses.
   */
  onAdd?: (input: {
    file: string;
    line: number;
    startLine?: number;
    anchorText: string;
    body: string;
    /** Replacement text for the commented lines, when the reviewer wrote one in the
     * composer's suggestion editor. */
    suggestion?: string;
  }) => Promise<ReviewComment>;
  onResolve: (commentId: string, resolved: boolean) => Promise<void>;
  onReply: (commentId: string, body: string) => Promise<void>;
  /** Commits a comment's suggestion onto the run branch. Omitted the same way `onAdd` is — a
   * GitHub PR target has no run worktree to apply into — which withholds the thread's Apply
   * button entirely rather than showing it disabled. */
  onApply?: (commentId: string) => Promise<void>;
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
  onApply,
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
  } | null>(null);
  // The new-side contents of `composing.file`, once `ensureLoaded` resolves — what the
  // composer's suggestion editor seeds from. `null` while that fetch is in flight, which keeps
  // the suggestion editor withheld (see `ComposerProps.fileContents`'s own doc comment).
  const [composerContents, setComposerContents] = useState<string | null>(null);
  // A comment whose `Apply now` save succeeded but whose immediate apply attempt failed — see
  // `submitAndApplyNow`. Keyed by comment id, read once by the `ReviewThread` that eventually
  // renders for it (via `initialApplyError`) so the failure shows there with the same
  // message/disable state a live click on that thread's own Apply button would have produced.
  // Never cleared: `ReviewThread` only reads its seed once on mount, so a stale entry for a
  // comment that no longer exists is simply never looked up again.
  const [applyNowFailures, setApplyNowFailures] = useState<
    Map<string, ApplySuggestionOutcome>
  >(new Map());
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
  // What each open edit session started from: the sha `applyRunEdit` needs as its precondition,
  // and the contents a save is compared against to spot a no-op. A ref, not state: it never
  // drives a render on its own, only reads triggered by `onItemEditComplete`.
  const sessionRef = useRef(
    new Map<string, { baseSha: string; contents: string }>()
  );
  // The file the reviewer pressed Save on. Pierre ends an edit session for several reasons —
  // Save, Cancel, the item leaving `items` — and this is what tells the one that should commit
  // apart from the ones that must not (see `decideEditSave`).
  const saveRequestRef = useRef<string | null>(null);
  const viewRef = useRef<CodeViewHandle<Annotation> | null>(null);
  // A patch's hunks alone don't carry the rest of the file — this loader fetches it from the
  // run's worktree, which is what makes unchanged-region expansion (and editing) possible at
  // all.
  const { loadDiffFiles, ensureLoaded, invalidate } = useRunFileLoader(
    client ?? null,
    runId
  );
  // Merged over the reviewer's own display settings by `DiffSurface`; only the loader is
  // review-specific.
  const diffOptions = useMemo(() => ({ loadDiffFiles }), [loadDiffFiles]);

  // The one place a suggestion actually gets applied — shared by every `ReviewThread`'s own
  // Apply button AND the composer's `Apply now`, so there is exactly one call site to keep the
  // cache-eviction step correct rather than two that could drift apart. Rejects outright when
  // there is nowhere to apply into, the same "withhold, don't half-wire" rule `onApply` being
  // absent already enforces everywhere else.
  const applyAndInvalidate = useCallback(
    (commentId: string, file: string): Promise<void> => {
      if (onApply === undefined) {
        return Promise.reject(
          new Error('no run to apply this suggestion into')
        );
      }
      return onApply(commentId).then(() => {
        // The suggestion just landed on disk, changing both this file's contents and its sha —
        // without this, the next edit (or suggestion seeded from a fresh pencil click) would
        // read the pre-apply cache and send a stale precondition, same as `handleEditComplete`'s
        // own success path below.
        invalidate(file);
      });
    },
    [onApply, invalidate]
  );

  // Parsed here rather than left to `DiffSurface` because the file list is read outside
  // item-building too — the pencil gate and the stale-`editing` effect below both need it — and
  // handing the result back down keeps that one parse shared. `'review'` namespaces the worker
  // pool's render cache for this patch.
  const parsed = useParsedPatchFiles(patch, only, 'review');
  const files = parsed.files;

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

  // A callback rather than an array: `DiffSurface` owns the parse and calls this with the files
  // it produced. Memoized on exactly the review state `buildItems` reads, because `DiffSurface`
  // keys its own item memo on this function's identity — a fresh one each render would rebuild
  // every item of a large diff on every keystroke in a composer.
  const items = useCallback(
    (parsedFiles: FileDiffMetadata[]) =>
      buildItems({
        files: parsedFiles,
        comments,
        findings,
        composing,
        viewed,
        editing,
        loaded,
      }),
    [comments, findings, composing, viewed, editing, loaded]
  );

  const renderAnnotation = useCallback(
    (annotation: { metadata?: Annotation }) => {
      // Named `annMeta` rather than `meta` — this component also takes a `meta: RunMeta` prop,
      // and shadowing it here would make the two easy to confuse mid-scroll through this file.
      const annMeta = annotation.metadata;
      if (annMeta === undefined) return null;
      if (annMeta.kind === 'composer') {
        const closeComposer = () => {
          setComposing(null);
          setComposerContents(null);
        };
        return (
          <ReviewComposer
            line={composing?.line ?? 0}
            startLine={annMeta.startLine}
            file={annMeta.file}
            fileContents={composerContents}
            onCancel={closeComposer}
            onSaved={closeComposer}
            onSubmit={(body, suggestion, anchorText) =>
              onAdd === undefined
                ? Promise.reject(new Error('nowhere to add this comment'))
                : onAdd({
                    file: annMeta.file,
                    line: composing?.line ?? 0,
                    startLine: annMeta.startLine,
                    // Read out of the same contents the composer seeded its
                    // suggestion editor from, so the anchor can never describe
                    // different text than the suggestion replaces.
                    anchorText,
                    body,
                    suggestion,
                  })
            }
            onApply={
              onApply === undefined
                ? undefined
                : (commentId) => applyAndInvalidate(commentId, annMeta.file)
            }
            onApplyNowFailed={(commentId, outcome) =>
              setApplyNowFailures((prev) =>
                new Map(prev).set(commentId, outcome)
              )
            }
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
              onApply={
                onApply === undefined
                  ? undefined
                  : () => applyAndInvalidate(c.id, c.file)
              }
              initialApplyError={applyNowFailures.get(c.id)}
            />
          ))}
        </div>
      );
    },
    [
      composing,
      composerContents,
      onAdd,
      onResolve,
      onReply,
      onApply,
      applyAndInvalidate,
      applyNowFailures,
    ]
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
            });
            // Cleared first so a previous compose's contents can't briefly seed this one's
            // suggestion editor while the new fetch is in flight.
            setComposerContents(null);
            void ensureLoaded(item.id).then((result) => {
              setComposerContents(result?.contents ?? null);
            });
          }}
          className="text-muted-foreground hover:text-accent-foreground grid size-4 place-items-center"
        >
          <MessageSquarePlus className="size-3" />
        </button>
      );
    },
    [selection, editing, ensureLoaded]
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
      saveRequestRef.current = null;
      void ensureLoaded(file).then((result) => {
        setPendingEdit(null);
        if (result === null) {
          setEditError({ file, message: "Couldn't load this file." });
          return;
        }
        sessionRef.current.set(file, {
          baseSha: result.sha,
          contents: result.contents,
        });
        setLoaded((prev) => new Set(prev).add(file));
        setEditing(file);
      });
    },
    [ensureLoaded, pendingEdit, editing]
  );

  // Save: record that this session's end is a deliberate save, then clear `editing` —
  // `buildItems` recomputes `edit: false`, which is what makes `CodeView` tear the editor
  // down and call `onItemEditComplete` (below) with its final text.
  const saveEdit = useCallback((file: string) => {
    saveRequestRef.current = file;
    setEditing((current) => (current === file ? null : current));
  }, []);

  // Cancel: ends the session the same way but without the save request, so the completion
  // below discards the draft instead of committing it.
  const cancelEdit = useCallback((file: string) => {
    saveRequestRef.current = null;
    sessionRef.current.delete(file);
    setEditError(null);
    setEditing((current) => (current === file ? null : current));
  }, []);

  // Drops a file's cached contents, sha and load marker, so the reviewer's next edit reads
  // fresh bytes rather than a copy that is now wrong on disk.
  const forgetFile = useCallback(
    (file: string) => {
      invalidate(file);
      sessionRef.current.delete(file);
      setLoaded((prev) => {
        const next = new Set(prev);
        next.delete(file);
        return next;
      });
    },
    [invalidate]
  );

  const handleEditComplete = useCallback(
    (item: CodeViewItem<Annotation>, file: FileContents) => {
      const requestedFile = saveRequestRef.current;
      if (requestedFile === item.id) saveRequestRef.current = null;
      const decision = decideEditSave({
        requestedFile,
        itemId: item.id,
        contents: file.contents,
        session: sessionRef.current.get(item.id),
      });
      if (decision.post === false) {
        // Cancelled, torn down by a file switch, or saved untouched — nothing to write, and
        // nothing to report either. Just make sure edit mode is closed.
        setEditing((current) => (current === item.id ? null : current));
        if (decision.reason === 'unchanged') setEditError(null);
        return;
      }
      if (client == null || runId === undefined) {
        setEditing(null);
        return;
      }
      void client
        .applyRunEdit(runId, {
          file: item.id,
          contents: file.contents,
          baseSha: decision.baseSha,
        })
        .then(() => {
          // The sha and contents on disk just changed — without evicting both caches, the
          // reviewer's next edit to this file would send a stale `baseSha` and the server
          // would reject it with 409 stale-base.
          forgetFile(item.id);
          setEditError(null);
          setEditing(null);
        })
        .catch((err: unknown) => {
          setEditError({ file: item.id, message: editErrorMessage(err) });
          // `resolveEditFailure` always closes the editor — see its doc comment on `editing`
          // for why an earlier version's "leave it open to keep the draft" on
          // worktree-busy/stale-base was actually a false promise (Pierre had already torn
          // the editor down by the time this callback runs). `refetchContents` is true only
          // for stale-base, where the file's on-disk content genuinely changed underneath
          // the reviewer, so its cached copy is now wrong too.
          const outcome = resolveEditFailure(err);
          setEditing(outcome.editing);
          if (outcome.refetchContents) forgetFile(item.id);
        });
    },
    [client, runId, forgetFile]
  );

  // A file can leave the rendered set with its editor still open — `ReviewView` swaps `only`
  // when the reviewer picks a different file, and passes no `key`, so `editing` outlives the
  // item it names. Every other pencil is hidden while one file is being edited, so a stale
  // `editing` would lock the whole diff until the original file was reselected.
  useEffect(() => {
    if (editing === null || files.some((f) => f.name === editing)) return;
    setEditing(null);
    setEditError(null);
  }, [files, editing]);

  const renderHeaderMetadata = useCallback(
    (item: { id: string }) => {
      if (!canEdit) return null;
      // Withheld entirely on a file Pierre cannot attach an editor to, the same way the whole
      // pencil is withheld on a non-terminal run — a control that silently does nothing is
      // worse than no control.
      const fileType = files.find((f) => f.name === item.id)?.type;
      if (fileType !== undefined && !isEditableDiffType(fileType)) return null;
      const isEditing = editing === item.id;
      // Disabled for every file while any one file's load is in flight, not just the file it's
      // for — `beginEdit` itself refuses to start a second load until this one settles, so a
      // click on a different file's pencil during that window would otherwise look live but do
      // nothing.
      const isPending = pendingEdit !== null;
      const error = editError?.file === item.id ? editError.message : null;
      // While another file is being edited, its own controls are the only ones that should be
      // live — showing the rest as clickable would suggest a second file could be opened for
      // edit at the same time, which `editing` can never represent.
      if (editing !== null && !isEditing) return null;
      return (
        <span className="flex items-center gap-1.5">
          {error !== null && (
            <span className="text-destructive text-[11px]">{error}</span>
          )}
          {isEditing ? (
            <>
              <button
                type="button"
                onClick={() => saveEdit(item.id)}
                className="text-accent-foreground text-[11px]"
              >
                Save
              </button>
              {/* Cancel is the only way out that keeps the file as it was — without it,
                  leaving edit mode always meant a commit attempt. */}
              <button
                type="button"
                onClick={() => cancelEdit(item.id)}
                className="text-muted-foreground hover:text-foreground text-[11px]"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label="Edit this file"
              disabled={isPending}
              onClick={() => beginEdit(item.id)}
              className="text-muted-foreground hover:text-accent-foreground grid size-4 place-items-center disabled:opacity-50"
            >
              <Pencil className="size-3" />
            </button>
          )}
        </span>
      );
    },
    [
      canEdit,
      files,
      editing,
      pendingEdit,
      editError,
      beginEdit,
      saveEdit,
      cancelEdit,
    ]
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

  return (
    // Everything shell-shaped — the worker pool, the crash boundary, the display settings, the
    // empty/parse-error states, the scroll container — belongs to `DiffSurface`; what stays here
    // is only what "review" means on top of a diff. `createReviewEditor` is the one place the
    // editor's options are decided, shared with every other editable surface.
    <DiffSurface<Annotation>
      patch={patch}
      parsed={parsed}
      only={only}
      items={items}
      options={diffOptions}
      viewRef={viewRef}
      createEditor={createReviewEditor}
      onItemEditComplete={handleEditComplete}
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
      // No `onAdd` means no destination for a comment, so the hover "+" that starts one is not
      // offered at all.
      renderGutterUtility={
        onAdd === undefined ? undefined : renderGutterUtility
      }
    />
  );
}
