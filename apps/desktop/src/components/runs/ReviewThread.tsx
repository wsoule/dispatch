import type { ReviewComment } from '@dispatch/client';
import { Button, ChipButton, cx } from '@dispatch/ui';
import type { CodeViewFileItem } from '@pierre/diffs';
import { CodeView } from '@pierre/diffs/react';
import { Check, CornerDownRight } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import styles from './ReviewThread.module.css';
import type { ApplySuggestionOutcome } from '@/lib/suggestionRange';
import {
  canApplyNow,
  resolveApplySuggestionFailure,
  seedFromRange,
  submitAndApplyNow,
  suggestionForSubmit,
} from '@/lib/suggestionRange';

// The thread and the composer share one comment card (`styles.card`), the same card a task's
// comments and its "Leave a comment…" composer sit in. Where it hangs (indented past a diff's
// gutter, or flush in the thread index) is the caller's choice.

/**
 * Where a note written here ends up: back to the agent on a run's own diff, or
 * onto the pull request on GitHub. Only the wording differs — the two paths
 * are otherwise identical — but telling a reviewer the wrong one is the exact
 * misrepresentation the PR composer was held back for.
 */
export type ReviewDestination = 'agent' | 'github';

const REPLY_PLACEHOLDER: Record<ReviewDestination, string> = {
  agent: 'Reply. The agent reads this when you send the work back.',
  github: 'Reply. Posts to GitHub.',
};

const COMPOSER_PLACEHOLDER: Record<ReviewDestination, string> = {
  agent: 'What should change? This goes back with the work.',
  github: 'What should change? This publishes with your review.',
};

// The third reply state, shown in place of the input on a staged GitHub
// draft. There is no thread on GitHub to reply into until a verdict
// publishes the note, so the box is withheld rather than left to fail.
const STAGED_REPLY_NOTE =
  'Staged. Reaches GitHub when you submit. ' +
  'Replying and resolving open up then.';

// Shown when a note is on GitHub but Dispatch has not read its ids back yet
// (a thread sync that failed, or a PR past the 100-thread page). Replying
// would 409, so the box waits for the next refresh instead of failing.
const UNLINKED_REPLY_NOTE =
  'Not linked to GitHub yet. Reopen the review to pick it up.';

// Fallback for a composer save that rejected with something that is not an
// Error, which carries no message worth showing.
const SAVE_FAILED = 'Could not save this comment.';

interface ReviewThreadProps {
  comment: ReviewComment;
  /** How the anchor has fared since the comment was written. */
  anchor: 'exact' | 'moved' | 'outdated';
  onResolve: (resolved: boolean) => Promise<void>;
  onReply: (body: string) => Promise<void>;
  destination?: ReviewDestination;
  /** Commits this comment's suggestion onto the run branch. Omitted where there is nowhere to
   * apply it into (no run in scope, same as `PierreReviewDiff`'s `onAdd`) — the Apply button is
   * withheld entirely rather than shown disabled, since there is nothing the reviewer could do
   * about it here. */
  onApply?: () => Promise<void>;
  /**
   * Seeds this thread's Apply state as already-failed — used only for a comment that was just
   * created via the composer's `Apply now`, whose own apply attempt failed *after* the save
   * already succeeded. By the time that failure is known the composer is gone (the save closed
   * it), so this is the only surface left to show it, and it shows the exact same
   * message/disable state a live click here would have produced.
   */
  initialApplyError?: ApplySuggestionOutcome;
}

/**
 * Where the thread's Apply button stands: never attempted, in flight, resolved, or failed with
 * a reason and whether that failure means retrying is pointless.
 *
 * `succeeded` is its own status rather than folding a resolved apply back into `idle`, so a late
 * failure from a different attempt can never be mistaken for describing it (see the effect
 * below), and so a landed apply reads as "Applied" instead of inviting a second click.
 */
type ApplyState =
  | { status: 'idle' }
  | { status: 'applying' }
  | { status: 'succeeded' }
  | { status: 'failed'; message: string; disabled: boolean };

/**
 * One comment thread, rendered beneath the line it was written against.
 *
 * The outdated marker is the part worth having. A comment whose code has changed underneath it
 * is still worth reading — the reviewer had a point — but presenting it as though it still
 * describes the current line would be a quiet lie. So it stays visible and says so.
 */
export function ReviewThread({
  comment,
  anchor,
  onResolve,
  onReply,
  destination = 'agent',
  onApply,
  initialApplyError,
}: ReviewThreadProps) {
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyState, setApplyState] = useState<ApplyState>(() =>
    initialApplyError === undefined
      ? { status: 'idle' }
      : {
          status: 'failed',
          message: initialApplyError.message,
          disabled: initialApplyError.disable,
        }
  );

  // Both GitHub verbs need an id the server has actually seen: replying
  // needs the comment's `githubId`, resolving needs the thread's node id.
  // Gating on those rather than on `pending` also covers a pushed note
  // whose ids have not been read back yet, which used to 409 on click.
  const isGitHub = destination === 'github';
  const canReply = !isGitHub || comment.githubId !== undefined;
  const canResolve = !isGitHub || comment.githubThreadId !== undefined;
  // Staged says "submit your review"; anything else missing its ids is a
  // sync gap, and saying the wrong one is its own small lie.
  const replyNote = comment.pending ? STAGED_REPLY_NOTE : UNLINKED_REPLY_NOTE;

  // `initialApplyError` can arrive after this thread has mounted — `Apply now`'s apply step
  // races the refetch its own save kicks off — and a lazy initializer only runs once, so this
  // effect is what picks up a failure that lands on a later render.
  //
  // Only ever moves `idle` → `failed`, so a stale failure from the `Apply now` attempt can't
  // overwrite a live click's `applying` or `succeeded` state.
  useEffect(() => {
    if (initialApplyError === undefined) return;
    setApplyState((current) =>
      current.status === 'idle'
        ? {
            status: 'failed',
            message: initialApplyError.message,
            disabled: initialApplyError.disable,
          }
        : current
    );
  }, [initialApplyError]);

  // Clears the box only once the reply has actually landed: clearing it on
  // keypress destroyed the reviewer's text whenever the write failed.
  async function sendReply() {
    const body = reply.trim();
    if (body === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onReply(body);
      setReply('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleResolved() {
    setError(null);
    try {
      await onResolve(!comment.resolved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Fires the apply and turns any rejection into the sentence + disable decision
  // `resolveApplySuggestionFailure` makes — see its own doc comment for why only
  // anchor-drifted disables the button rather than every failure. Lands on `succeeded`, not
  // `idle`, on success — see `ApplyState`'s own doc comment for why that distinction exists.
  const handleApply = () => {
    if (onApply === undefined) return;
    setApplyState({ status: 'applying' });
    onApply()
      .then(() => setApplyState({ status: 'succeeded' }))
      .catch((err: unknown) => {
        const outcome = resolveApplySuggestionFailure(err);
        setApplyState({
          status: 'failed',
          message: outcome.message,
          disabled: outcome.disable,
        });
      });
  };

  return (
    <div
      data-slot="review-thread"
      className={styles.card}
      data-resolved={comment.resolved ? 'true' : undefined}
    >
      <div className={styles.head}>
        <span className={styles.author}>{comment.author}</span>
        {anchor === 'moved' && (
          <span className={styles.meta}>moved to line {comment.line}</span>
        )}
        {anchor === 'outdated' && (
          <span className={cx(styles.meta, 'toneText')} data-tone="warning">
            outdated — the code here changed
          </span>
        )}
        <span className={styles.spacer} />
        {canResolve && (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => void toggleResolved()}
            // Resolved reads in the success tone beside its tick; the word says it either way.
            className={comment.resolved ? 'toneText' : undefined}
            data-tone={comment.resolved ? 'success' : undefined}
            icon={
              comment.resolved ? (
                <Check size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : undefined
            }
          >
            {comment.resolved ? 'resolved' : 'resolve'}
          </Button>
        )}
      </div>

      <p className={styles.body}>{comment.body}</p>

      {comment.suggestion !== undefined && onApply !== undefined && (
        <div className={styles.applyRow}>
          {/* A landed apply reads "Applied" and stops taking clicks: a second one would
              splice over the line the suggestion just replaced, and come back as 409
              anchor-drifted — "the code here has changed" — which is a baffling way to
              find out the first click worked. */}
          <Button
            size="sm"
            disabled={
              applyState.status === 'applying' ||
              applyState.status === 'succeeded' ||
              (applyState.status === 'failed' && applyState.disabled)
            }
            onClick={handleApply}
          >
            {applyState.status === 'applying'
              ? 'Applying…'
              : applyState.status === 'succeeded'
                ? 'Applied'
                : 'Apply'}
          </Button>
          {applyState.status === 'failed' && (
            <span className={cx(styles.message, 'toneText')} data-tone="danger">
              {applyState.message}
            </span>
          )}
        </div>
      )}

      {comment.replies.map((r) => (
        <div key={r.id} className={styles.reply}>
          <CornerDownRight
            className={styles.replyIcon}
            size={14}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <div className={styles.replyText}>
            <span className={styles.author}>{r.author}</span>
            <p className={styles.body}>{r.body}</p>
          </div>
        </div>
      ))}

      {error !== null && (
        <p
          role="alert"
          className={cx(styles.message, 'toneText')}
          data-tone="danger"
        >
          {error}
        </p>
      )}

      {!comment.resolved &&
        (!canReply ? (
          <p className={cx(styles.message, styles.meta)}>{replyNote}</p>
        ) : (
          // The inline "Leave a reply…" field at the card's foot; Enter sends it.
          <input
            type="text"
            className={cx('input', styles.field)}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendReply();
            }}
            aria-label="Reply"
            placeholder={REPLY_PLACEHOLDER[destination]}
          />
        ))}
    </div>
  );
}

/** What an open composer holds: the note, the suggestion typed into its editor, and whether a
 * save is in flight with what last went wrong. */
interface ComposerDraft {
  body: string;
  /** The suggestion editor's text and the seed it was edited from. It counts only while that
   * seed is still the composer's: a new range, or contents that just arrived, start from their
   * own seed. `null` until the reviewer types into the editor. */
  suggestion: { seed: string; text: string } | null;
  busy: boolean;
  error: string | null;
}

const EMPTY_DRAFT: ComposerDraft = {
  body: '',
  suggestion: null,
  busy: false,
  error: null,
};

/** A composer's draft, held outside the composer so it outlives a remount. */
export interface ComposerDraftStore {
  get: () => ComposerDraft;
  set: (patch: Partial<ComposerDraft>) => void;
  subscribe: (listener: () => void) => () => void;
  /** Back to an empty draft: the composer closed (saved or cancelled). */
  reset: () => void;
  /** The range (`file:start-line`) the note box last took the caret for, so a composer drawn
   * again for the same range takes it back only when it went with the old one. */
  focusedFor: string | null;
}

/**
 * A draft store for one composer, read with `useSyncExternalStore`.
 *
 * `PierreReviewDiff` holds one and hands it to its `ReviewComposer`, because Pierre keys a
 * file's annotation slots by position (threads, then findings, then the composer): a thread or
 * finding landing on that file while the composer is open (a refetch, another reviewer, the
 * comment `Apply now` just saved) shifts the composer one slot along, React mounts a fresh one
 * there, and a draft kept in its own state would be gone. Its save also writes here, so a
 * save that settles after such a remount still clears the new composer's `busy`.
 */
export function createComposerDraft(): ComposerDraftStore {
  let draft = EMPTY_DRAFT;
  const listeners = new Set<() => void>();
  const store: ComposerDraftStore = {
    get: () => draft,
    set: (patch) => {
      draft = { ...draft, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      store.focusedFor = null;
      store.set(EMPTY_DRAFT);
    },
    focusedFor: null,
  };
  return store;
}

interface ComposerProps {
  line: number;
  /** First line of a range comment; omitted for a single line. */
  startLine?: number;
  /** The file this composer is anchored to — seeds the suggestion editor's contents and, by
   * naming the nested `CodeView` item after it, gets Shiki to highlight it as that language. */
  file: string;
  /** The commented range's contents on the new side of the diff, once `PierreReviewDiff` has
   * fetched them via `ensureLoaded`. `null` while that fetch is in flight (or there is no run
   * to fetch from) — the suggestion editor stays withheld rather than mounting `edit: true` on
   * an item with no real contents, the same landmine `buildItems`'s load gate exists for. */
  fileContents: string | null;
  /** Saves the comment, resolving with the created record. Widened from a fire-and-forget
   * `void` return so `Apply now` can act on the new comment's id — see `submitAndApplyNow`.
   *
   * `anchorText` is read out of `fileContents` here rather than passed in, so the anchor and
   * the suggestion are guaranteed to come from the same copy of the file. */
  onSubmit: (
    body: string,
    suggestion: string | undefined,
    anchorText: string
  ) => Promise<ReviewComment>;
  /** Called once `onSubmit` resolves — for both buttons, the moment the comment is durably
   * saved — so the parent can close this composer. Kept separate from `Apply now`'s own apply
   * attempt settling: a failed apply after a successful save must not keep the just-written
   * comment (or the composer) hostage, so this fires on the save alone. */
  onSaved: () => void;
  onCancel: () => void;
  destination?: ReviewDestination;
  /** Applies a just-created comment's suggestion — the exact same bound function
   * `PierreReviewDiff` wires to every `ReviewThread`'s Apply button (its `invalidate` call
   * included), reused here rather than duplicated. Omitted wherever that is (no run to apply
   * into), which withholds the `Apply now` button entirely, same as `ReviewThread`'s own Apply. */
  onApply?: (commentId: string) => Promise<void>;
  /** Reports a failed `Apply now` apply step (after its save already succeeded) so the parent
   * can seed the resulting `ReviewThread`'s Apply button with the same failure — see
   * `ReviewThread`'s `initialApplyError`. */
  onApplyNowFailed?: (
    commentId: string,
    outcome: ApplySuggestionOutcome
  ) => void;
  /** Where the draft lives (see `createComposerDraft`). Omitted, the composer keeps its own,
   * which a remount loses. */
  draft?: ComposerDraftStore;
}

/**
 * The inline "comment on line N" box, anchored beneath the line it targets. Beneath the prose
 * textarea it nests a second, real Pierre `CodeView` holding one editable file item — the
 * suggestion editor — seeded from the commented range so a reviewer can write the exact
 * replacement text rather than describing it in words.
 *
 * That nested `CodeView` needs an ancestor `EditProvider` to resolve its editor factory, which
 * `PierreReviewDiff` supplies — standalone render tests must wrap this themselves.
 *
 * Once there is a real suggestion it offers `Suggest` (save the comment) and `Apply now` (save
 * and immediately apply, via `submitAndApplyNow`).
 */
export function ReviewComposer({
  line,
  startLine,
  file,
  fileContents,
  onSubmit,
  onSaved,
  onCancel,
  destination = 'agent',
  onApply,
  onApplyNowFailed,
  draft,
}: ComposerProps) {
  const [ownDraft] = useState(createComposerDraft);
  const store = draft ?? ownDraft;
  const current = useSyncExternalStore(store.subscribe, store.get, store.get);
  const { body, busy, error } = current;
  const start = startLine ?? line;
  // The composer only exists because the reviewer just asked to comment on this range, so
  // the caret goes straight into the body — again if they re-aim it at another range. Drawn
  // again for the same range (a remount), it takes the caret back only if the caret went with
  // the old composer, and puts it after the kept text; focus elsewhere stays where it is.
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = bodyRef.current;
    if (box === null) return;
    const aim = `${file}:${start}-${line}`;
    // Focus that went with the old composer leaves the body focused (or, in some DOMs, a
    // detached element).
    const active = document.activeElement;
    const lost =
      active === null || active === document.body || !active.isConnected;
    if (store.focusedFor === aim && !lost) return;
    store.focusedFor = aim;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [store, file, start, line]);
  const seed = useMemo(
    () =>
      fileContents === null ? '' : seedFromRange(fileContents, start, line),
    [fileContents, start, line]
  );
  // The suggestion editor's live text, reported by `CodeView`'s `onItemEditChange` on every
  // keystroke and kept with the seed it was typed over: a new seed (a fresh range, or the
  // contents arriving) starts over from that seed.
  const suggestionText =
    current.suggestion !== null && current.suggestion.seed === seed
      ? current.suggestion.text
      : seed;
  // What the editor opens with: the seed, or the text already typed over that same seed when
  // this composer is drawn again. Read once per seed, so typing never resets the editor.
  const opensWith = useMemo(() => {
    const kept = store.get().suggestion;
    return kept !== null && kept.seed === seed ? kept.text : seed;
  }, [store, seed]);

  const suggestionItem: CodeViewFileItem | null = useMemo(() => {
    if (fileContents === null) return null;
    const cacheKey = `${file}:${start}-${line}`;
    return {
      id: cacheKey,
      type: 'file',
      file: { name: file, contents: opensWith, cacheKey },
      edit: true,
      version: 1,
    };
  }, [fileContents, file, opensWith, start, line]);

  const suggestion = suggestionForSubmit(seed, suggestionText);
  // The anchor is the LAST line of the range, because that is the line
  // `resolveAnchor` checks server-side. Empty only when there are no contents to
  // read — which also means no suggestion editor, so nothing appliable is left
  // un-anchored.
  const anchorText = useMemo(
    () =>
      fileContents === null ? '' : seedFromRange(fileContents, line, line),
    [fileContents, line]
  );

  // Saves the comment. Both buttons reach here; `Apply now` chains an apply attempt onto it
  // (see `handleApplyNow` below). A save failure leaves the composer open with the draft
  // intact and the reason beneath it — `onSaved` is only called once `onSubmit` resolves.
  const handleSuggest = () => {
    const trimmed = body.trim();
    if (trimmed === '' || busy) return;
    store.set({ busy: true, error: null });
    onSubmit(trimmed, suggestion, anchorText)
      .then(() => onSaved())
      .catch((err: unknown) => {
        // Nothing was created — the draft stays in the box for the reviewer to
        // retry, with what went wrong shown rather than swallowed.
        store.set({ error: err instanceof Error ? err.message : SAVE_FAILED });
      })
      .finally(() => store.set({ busy: false }));
  };

  // `Apply now`: save, then immediately apply via `submitAndApplyNow`, which guarantees the
  // saved comment is never rolled back or hidden just because the apply step failed. Closes
  // the composer as soon as the SAVE resolves (matching `handleSuggest`) — not once apply
  // settles — so a slow or failing apply never leaves the composer, or the comment it already
  // wrote, stuck in limbo.
  const handleApplyNow = () => {
    const trimmed = body.trim();
    if (trimmed === '' || busy || onApply === undefined) return;
    if (suggestion === undefined) return;
    store.set({ busy: true, error: null });
    submitAndApplyNow(
      () => onSubmit(trimmed, suggestion, anchorText),
      onApply,
      (commentId, outcome) => onApplyNowFailed?.(commentId, outcome)
    )
      .then(() => onSaved())
      .catch((err: unknown) => {
        // The save itself failed — same as `handleSuggest`, nothing was created to apply.
        store.set({ error: err instanceof Error ? err.message : SAVE_FAILED });
      })
      .finally(() => store.set({ busy: false }));
  };

  return (
    // The composer is the same card as a thread — Linear's "Leave a comment…" box — with the
    // line reference as its 12px heading and a borderless textarea for the body.
    <div data-slot="review-composer" className={styles.card}>
      <div className={styles.author}>
        {startLine !== undefined && startLine !== line
          ? `Comment on lines ${startLine}–${line}`
          : `Comment on line ${line}`}
      </div>
      <textarea
        ref={bodyRef}
        className={cx('textarea', styles.field, styles.composerBody)}
        value={body}
        onChange={(e) => store.set({ body: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Claimed, so the app's window-level Escape (which honours `defaultPrevented`)
            // does not also close the task page: one press peels one layer.
            e.preventDefault();
            onCancel();
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) {
            handleSuggest();
          }
        }}
        aria-label={`Comment on line ${line}`}
        placeholder={COMPOSER_PLACEHOLDER[destination]}
      />
      {suggestionItem !== null && (
        <div data-testid="suggestion-editor" className={styles.suggestion}>
          <CodeView
            disableWorkerPool
            items={[suggestionItem]}
            onItemEditChange={(_item, changedFile) =>
              store.set({ suggestion: { seed, text: changedFile.contents } })
            }
            className={styles.suggestionCode}
          />
        </div>
      )}
      {error !== null && (
        <p
          role="alert"
          className={cx(styles.message, 'toneText')}
          data-tone="danger"
        >
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <ChipButton onClick={onCancel}>Cancel</ChipButton>
        {canApplyNow(seed, suggestionText, onApply !== undefined) && (
          <ChipButton
            disabled={body.trim() === '' || busy}
            onClick={handleApplyNow}
          >
            Apply now
          </ChipButton>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={body.trim() === '' || busy}
          onClick={handleSuggest}
        >
          {suggestion !== undefined ? 'Suggest' : 'Add comment'}
        </Button>
      </div>
    </div>
  );
}
