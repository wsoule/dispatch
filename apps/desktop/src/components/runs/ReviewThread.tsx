import type { ReviewComment } from '@dispatch/client';
import type { CodeViewFileItem } from '@pierre/diffs';
import { CodeView } from '@pierre/diffs/react';
import { Check, CornerDownRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { ApplySuggestionOutcome } from '@/lib/suggestionRange';
import {
  canApplyNow,
  resolveApplySuggestionFailure,
  seedFromRange,
  submitAndApplyNow,
  suggestionForSubmit,
} from '@/lib/suggestionRange';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Panel } from '@/ui/chrome';
import { Input } from '@/ui/input';
import { ScrollArea } from '@/ui/scroll-area';
import { Textarea } from '@/ui/textarea';

/**
 * Where a note written here ends up: back to the agent on a run's own diff, or
 * onto the pull request on GitHub. Only the wording differs — the two paths
 * are otherwise identical — but telling a reviewer the wrong one is the exact
 * misrepresentation the PR composer was held back for.
 */
export type ReviewDestination = 'agent' | 'github';

const REPLY_PLACEHOLDER: Record<ReviewDestination, string> = {
  agent: 'Reply — the agent reads this when you send the work back',
  github: 'Reply — posts to this thread on GitHub',
};

const COMPOSER_PLACEHOLDER: Record<ReviewDestination, string> = {
  agent: 'What should change? This goes back with the work.',
  github: 'What should change? This publishes with your review.',
};

// The third reply state, shown in place of the input on a staged GitHub
// draft. There is no thread on GitHub to reply into until a verdict
// publishes the note, so the box is withheld rather than left to fail.
const STAGED_REPLY_NOTE =
  'Staged — this note reaches GitHub when you submit your review. ' +
  'Replying and resolving open up then.';

// Shown when a note is on GitHub but Dispatch has not read its ids back yet
// (a thread sync that failed, or a PR past the 100-thread page). Replying
// would 409, so the box waits for the next refresh instead of failing.
const UNLINKED_REPLY_NOTE =
  'Not linked to its GitHub thread yet — reopen this review to pick it up.';

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
    // Panel's own border replaces `shadow-hairline` here — same swap as every other card in
    // this sweep (e.g. EnrichReview), not a diff-rendering change.
    <Panel
      className={cn('my-1.5 ml-[90px] p-3', comment.resolved && 'opacity-60')}
    >
      <div className="flex items-center gap-2">
        <span className="text-accent-foreground text-[11px] font-medium">
          {comment.author}
        </span>
        {anchor === 'moved' && (
          <span className="dense-meta">moved to line {comment.line}</span>
        )}
        {anchor === 'outdated' && (
          <span className="dense-meta text-state-waiting">
            outdated — the code here changed
          </span>
        )}
        <span className="flex-1" />
        {canResolve && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => void toggleResolved()}
            className={cn(
              'h-auto p-0 text-[11px] font-normal hover:bg-transparent',
              comment.resolved
                ? 'text-state-review hover:text-state-review'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {comment.resolved ? (
              <span className="inline-flex items-center gap-1">
                <Check className="size-3" />
                resolved
              </span>
            ) : (
              'resolve'
            )}
          </Button>
        )}
      </div>

      <p className="mt-1.5 text-[12.5px] leading-relaxed">{comment.body}</p>

      {comment.suggestion !== undefined && onApply !== undefined && (
        <div className="mt-1.5 flex items-center gap-2">
          {/* A landed apply reads "Applied" and stops taking clicks: a second one would
              splice over the line the suggestion just replaced, and come back as 409
              anchor-drifted — "the code here has changed" — which is a baffling way to
              find out the first click worked. */}
          <Button
            type="button"
            disabled={
              applyState.status === 'applying' ||
              applyState.status === 'succeeded' ||
              (applyState.status === 'failed' && applyState.disabled)
            }
            onClick={handleApply}
            className="h-auto rounded-md px-2.5 py-1 text-[12px]"
          >
            {applyState.status === 'applying'
              ? 'Applying…'
              : applyState.status === 'succeeded'
                ? 'Applied'
                : 'Apply'}
          </Button>
          {applyState.status === 'failed' && (
            <span className="text-destructive text-[11px]">
              {applyState.message}
            </span>
          )}
        </div>
      )}

      {comment.replies.map((r) => (
        <div key={r.id} className="mt-2 flex gap-2">
          <CornerDownRight className="text-muted-foreground mt-0.5 size-3 shrink-0" />
          <div>
            <span className="text-accent-foreground text-[11px] font-medium">
              {r.author}
            </span>
            <p className="text-[12.5px] leading-relaxed">{r.body}</p>
          </div>
        </div>
      ))}

      {error !== null && (
        <p role="alert" className="text-destructive mt-1.5 text-[11.5px]">
          {error}
        </p>
      )}

      {!comment.resolved &&
        (!canReply ? (
          <p className="text-muted-foreground mt-2 text-[11.5px]">
            {replyNote}
          </p>
        ) : (
          <div className="mt-2 flex gap-2">
            <Input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void sendReply();
              }}
              placeholder={REPLY_PLACEHOLDER[destination]}
              className="h-auto min-w-0 flex-1 px-2 py-1 text-[12px]"
            />
          </div>
        ))}
    </Panel>
  );
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
}: ComposerProps) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = startLine ?? line;
  const seed = useMemo(
    () =>
      fileContents === null ? '' : seedFromRange(fileContents, start, line),
    [fileContents, start, line]
  );
  // Tracks the suggestion editor's live text, reported by `CodeView`'s `onItemEditChange` on
  // every keystroke. Reset to the seed whenever the target range changes (a fresh compose) —
  // `seed` only changes value when contents resolve or the range moves, so this does not loop.
  const [suggestionText, setSuggestionText] = useState(seed);
  useEffect(() => setSuggestionText(seed), [seed]);

  const suggestionItem: CodeViewFileItem | null = useMemo(() => {
    if (fileContents === null) return null;
    const cacheKey = `${file}:${start}-${line}`;
    return {
      id: cacheKey,
      type: 'file',
      file: { name: file, contents: seed, cacheKey },
      edit: true,
      version: 1,
    };
  }, [fileContents, file, seed, start, line]);

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
    setBusy(true);
    setError(null);
    onSubmit(trimmed, suggestion, anchorText)
      .then(() => onSaved())
      .catch((err: unknown) => {
        // Nothing was created — the draft stays in the box for the reviewer to
        // retry, with what went wrong shown rather than swallowed.
        setError(err instanceof Error ? err.message : SAVE_FAILED);
      })
      .finally(() => setBusy(false));
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
    setBusy(true);
    setError(null);
    submitAndApplyNow(
      () => onSubmit(trimmed, suggestion, anchorText),
      onApply,
      (commentId, outcome) => onApplyNowFailed?.(commentId, outcome)
    )
      .then(() => onSaved())
      .catch((err: unknown) => {
        // The save itself failed — same as `handleSuggest`, nothing was created to apply.
        setError(err instanceof Error ? err.message : SAVE_FAILED);
      })
      .finally(() => setBusy(false));
  };

  return (
    // Panel's own border replaces `shadow-hairline-strong` — same swap as `ReviewThread`'s
    // own card above, not a diff-rendering change.
    <Panel className="my-1.5 ml-[90px] p-3">
      <div className="dense-label text-accent-foreground">
        {startLine !== undefined && startLine !== line
          ? `Comment on lines ${startLine}–${line}`
          : `Comment on line ${line}`}
      </div>
      <Textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) {
            handleSuggest();
          }
        }}
        placeholder={COMPOSER_PLACEHOLDER[destination]}
        className="mt-1.5 min-h-[52px] w-full resize-y bg-transparent text-[12.5px]"
      />
      {suggestionItem !== null && (
        <ScrollArea
          data-testid="suggestion-editor"
          className="border-border mt-1.5 max-h-40 rounded-md border"
        >
          <CodeView
            disableWorkerPool
            items={[suggestionItem]}
            onItemEditChange={(_item, changedFile) =>
              setSuggestionText(changedFile.contents)
            }
            className="text-[12px]"
          />
        </ScrollArea>
      )}
      {error !== null && (
        <p role="alert" className="text-destructive text-[11.5px]">
          {error}
        </p>
      )}
      <div className="mt-1.5 flex gap-2">
        <Button
          type="button"
          disabled={body.trim() === '' || busy}
          onClick={handleSuggest}
          className="h-auto rounded-md px-2.5 py-1 text-[12px]"
        >
          {suggestion !== undefined ? 'Suggest' : 'Add comment'}
        </Button>
        {canApplyNow(seed, suggestionText, onApply !== undefined) && (
          <Button
            type="button"
            variant="outline"
            disabled={body.trim() === '' || busy}
            onClick={handleApplyNow}
            className="h-auto rounded-md px-2.5 py-1 text-[12px]"
          >
            Apply now
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          className="h-auto rounded-md px-2.5 py-1 text-[12px]"
        >
          Cancel
        </Button>
      </div>
    </Panel>
  );
}
