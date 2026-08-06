import type { ReviewComment } from '@dispatch/client';
import { Check, CornerDownRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

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

interface ReviewThreadProps {
  comment: ReviewComment;
  /** How the anchor has fared since the comment was written. */
  anchor: 'exact' | 'moved' | 'outdated';
  onResolve: (resolved: boolean) => Promise<void>;
  onReply: (body: string) => Promise<void>;
  destination?: ReviewDestination;
}

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
}: ReviewThreadProps) {
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        {canResolve && (
          <button
            type="button"
            onClick={() => void toggleResolved()}
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
        )}
      </div>

      <p className="mt-1.5 text-[12.5px] leading-relaxed">{comment.body}</p>

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
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void sendReply();
              }}
              placeholder={REPLY_PLACEHOLDER[destination]}
              className="shadow-hairline min-w-0 flex-1 rounded-md px-2 py-1 text-[12px] outline-none"
            />
          </div>
        ))}
    </div>
  );
}

interface ComposerProps {
  line: number;
  /** First line of a range comment; omitted for a single line. */
  startLine?: number;
  /** Resolves once the note is stored; the caller closes the composer then. */
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  destination?: ReviewDestination;
}

/** The inline "comment on line N" box, anchored beneath the line it targets. */
export function ReviewComposer({
  line,
  startLine,
  onSubmit,
  onCancel,
  destination = 'agent',
}: ComposerProps) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only a successful write closes this box (the caller unmounts it), so a
  // failed one leaves the composed note on screen with the reason beneath it
  // rather than discarding what the reviewer just wrote.
  async function submit() {
    const text = body.trim();
    if (text === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
        placeholder={COMPOSER_PLACEHOLDER[destination]}
        className="mt-1.5 min-h-[52px] w-full resize-y bg-transparent text-[12.5px] outline-none"
      />
      {error !== null && (
        <p role="alert" className="text-destructive text-[11.5px]">
          {error}
        </p>
      )}
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          disabled={busy || body.trim() === ''}
          onClick={() => void submit()}
          className="bg-accent text-accent-foreground rounded-md px-2.5 py-1 text-[12px] disabled:opacity-50"
        >
          Add comment
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
