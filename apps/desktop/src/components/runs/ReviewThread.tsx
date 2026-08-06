import type { ReviewComment } from '@dispatch/client';
import type { CodeViewFileItem } from '@pierre/diffs';
import { CodeView } from '@pierre/diffs/react';
import { Check, CornerDownRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  resolveApplySuggestionFailure,
  seedFromRange,
  suggestionForSubmit,
} from '@/lib/suggestionRange';
import { cn } from '@/lib/utils';

interface ReviewThreadProps {
  comment: ReviewComment;
  /** How the anchor has fared since the comment was written. */
  anchor: 'exact' | 'moved' | 'outdated';
  onResolve: (resolved: boolean) => void;
  onReply: (body: string) => void;
  /** Commits this comment's suggestion onto the run branch. Omitted where there is nowhere to
   * apply it into (no run in scope, same as `PierreReviewDiff`'s `onAdd`) — the Apply button is
   * withheld entirely rather than shown disabled, since there is nothing the reviewer could do
   * about it here. */
  onApply?: () => Promise<void>;
}

/** Where the thread's Apply button stands: never attempted, in flight, or failed with a reason
 *  and whether that failure means retrying is pointless. */
type ApplyState =
  | { status: 'idle' }
  | { status: 'applying' }
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
  onApply,
}: ReviewThreadProps) {
  const [reply, setReply] = useState('');
  const [applyState, setApplyState] = useState<ApplyState>({
    status: 'idle',
  });

  // Fires the apply and turns any rejection into the sentence + disable decision
  // `resolveApplySuggestionFailure` makes — see its own doc comment for why only
  // anchor-drifted disables the button rather than every failure.
  const handleApply = () => {
    if (onApply === undefined) return;
    setApplyState({ status: 'applying' });
    onApply()
      .then(() => setApplyState({ status: 'idle' }))
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
      className={cn(
        'bg-card shadow-hairline my-1.5 ml-[90px] rounded-lg p-3',
        comment.resolved && 'opacity-60'
      )}
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
        <button
          type="button"
          onClick={() => onResolve(!comment.resolved)}
          className={cn(
            'text-[11px]',
            comment.resolved
              ? 'text-state-review'
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
        </button>
      </div>

      <p className="mt-1.5 text-[12.5px] leading-relaxed">{comment.body}</p>

      {comment.suggestion !== undefined && onApply !== undefined && (
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            disabled={
              applyState.status === 'applying' ||
              (applyState.status === 'failed' && applyState.disabled)
            }
            onClick={handleApply}
            className="bg-accent text-accent-foreground rounded-md px-2.5 py-1 text-[12px] disabled:opacity-50"
          >
            {applyState.status === 'applying' ? 'Applying…' : 'Apply'}
          </button>
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

      {!comment.resolved && (
        <div className="mt-2 flex gap-2">
          <input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reply.trim() !== '') {
                onReply(reply.trim());
                setReply('');
              }
            }}
            placeholder="Reply — the agent reads this when you send the work back"
            className="shadow-hairline min-w-0 flex-1 rounded-md px-2 py-1 text-[12px] outline-none"
          />
        </div>
      )}
    </div>
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
  onSubmit: (body: string, suggestion?: string) => void;
  onCancel: () => void;
}

/**
 * The inline "comment on line N" box, anchored beneath the line it targets. Beneath the prose
 * textarea it nests a second, real Pierre `CodeView` holding one editable file item — the
 * suggestion editor — seeded from the commented range so a reviewer can write the exact
 * replacement text rather than describing it in words.
 *
 * That nested `CodeView` relies on an ancestor `EditProvider` to resolve its editor factory
 * (`PierreReviewDiff` already supplies one around the whole diff); it does not create its own,
 * so standalone render tests must wrap this component in one themselves.
 */
export function ReviewComposer({
  line,
  startLine,
  file,
  fileContents,
  onSubmit,
  onCancel,
}: ComposerProps) {
  const [body, setBody] = useState('');
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

  const submit = () => {
    const trimmed = body.trim();
    if (trimmed === '') return;
    onSubmit(trimmed, suggestionForSubmit(seed, suggestionText));
  };

  return (
    <div className="bg-card shadow-hairline-strong my-1.5 ml-[90px] rounded-lg p-3">
      <div className="dense-label text-accent-foreground">
        {startLine !== undefined && startLine !== line
          ? `Comment on lines ${startLine}–${line}`
          : `Comment on line ${line}`}
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) {
            submit();
          }
        }}
        placeholder="What should change? This goes back with the work."
        className="mt-1.5 min-h-[52px] w-full resize-y bg-transparent text-[12.5px] outline-none"
      />
      {suggestionItem !== null && (
        <div
          data-testid="suggestion-editor"
          className="shadow-hairline mt-1.5 max-h-40 overflow-auto rounded-md"
        >
          <CodeView
            disableWorkerPool
            items={[suggestionItem]}
            onItemEditChange={(_item, changedFile) =>
              setSuggestionText(changedFile.contents)
            }
            className="text-[12px]"
          />
        </div>
      )}
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          disabled={body.trim() === ''}
          onClick={submit}
          className="bg-accent text-accent-foreground rounded-md px-2.5 py-1 text-[12px] disabled:opacity-50"
        >
          {suggestionText !== seed ? 'Suggest' : 'Add comment'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="shadow-hairline rounded-md px-2.5 py-1 text-[12px]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
