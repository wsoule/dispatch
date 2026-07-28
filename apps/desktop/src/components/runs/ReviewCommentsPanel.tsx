import type { ReviewComment } from '@dispatch/client';
import { useMemo, useState } from 'react';

import { SectionLabel } from '../ui/SectionLabel';
import { ReviewThread } from './ReviewThread';
import { cn } from '@/lib/utils';

interface ReviewCommentsPanelProps {
  comments: ReviewComment[];
  onResolve: (commentId: string, resolved: boolean) => Promise<void>;
  onReply: (commentId: string, body: string) => Promise<void>;
  onSendBack: (note: string) => Promise<void>;
}

/**
 * Review comments for a run, beside its diff.
 *
 * Commenting now happens inline, on the diff line itself (see AnnotatedDiff). What is left here
 * is what a per-line thread cannot do: an index of every thread across every file, so you can
 * see the shape of a review without scrolling the diff, and the send-back block that ends it.
 *
 * The file/line picker is gone with it — you click the line.
 */
export function ReviewCommentsPanel({
  comments,
  onResolve,
  onReply,
  onSendBack,
}: ReviewCommentsPanelProps) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = comments.filter((c) => !c.resolved);
  const byFile = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const bucket = map.get(c.file);
      if (bucket === undefined) map.set(c.file, [c]);
      else bucket.push(c);
    }
    for (const list of map.values()) list.sort((a, b) => a.line - b.line);
    return map;
  }, [comments]);

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel rule count={comments.length}>
        Review comments
      </SectionLabel>

      {error !== null && (
        <p className="text-state-failed text-[12px]">{error}</p>
      )}

      {comments.length === 0 ? (
        <p className="text-muted-foreground text-[12.5px]">
          No comments yet. Hover a diff line and click the ✎ to leave one —
          anything unresolved goes back to the agent with the work.
        </p>
      ) : (
        [...byFile.entries()].map(([path, list]) => (
          <div key={path}>
            <div className="dense-meta mb-1 truncate">{path}</div>
            {list.map((c) => (
              <ReviewThread
                key={c.id}
                comment={c}
                // The panel has no file contents to compare against, so it never claims a
                // comment has moved or gone stale — only the diff-side renderer could know.
                anchor="exact"
                onResolve={(resolved) =>
                  void guard(() => onResolve(c.id, resolved))
                }
                onReply={(body) => void guard(() => onReply(c.id, body))}
              />
            ))}
          </div>
        ))
      )}

      <div className="shadow-hairline rounded-lg p-3">
        <SectionLabel>Send it back</SectionLabel>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything the agent should know before it tries again…"
          className="mt-2 min-h-[64px] w-full resize-y bg-transparent text-[12.5px] outline-none"
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="dense-meta flex-1">
            {open.length === 0
              ? 'No open threads — the note goes on its own.'
              : `${open.length} open ${open.length === 1 ? 'thread travels' : 'threads travel'} with it.`}
          </span>
          <button
            type="button"
            disabled={busy || (note.trim() === '' && open.length === 0)}
            onClick={() =>
              void guard(async () => {
                await onSendBack(note.trim());
                setNote('');
              })
            }
            className={cn(
              'bg-accent text-accent-foreground rounded-md px-2.5 py-1 text-[12px]',
              'disabled:opacity-50'
            )}
          >
            Send back with notes
          </button>
        </div>
      </div>
    </div>
  );
}
