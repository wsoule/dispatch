import type { ReviewComment } from '@dispatch/client';
import { useMemo } from 'react';

import { ReviewThread } from './ReviewThread';
import { SectionLabel } from '@/ui/chrome/SectionLabel';

interface ReviewThreadIndexProps {
  comments: ReviewComment[];
  onResolve: (commentId: string, resolved: boolean) => Promise<void>;
  onReply: (commentId: string, body: string) => Promise<void>;
  /** Scrolls the diff to a thread. Omitted when there is no diff to scroll. */
  onJumpTo?: (comment: ReviewComment) => void;
}

/**
 * Every thread on this review, grouped by file.
 *
 * Threads appear here as well as under their lines because the two answer different questions —
 * "what did I say about this line" is inline, "what have I said overall" is here.
 */
export function ReviewThreadIndex({
  comments,
  onResolve,
  onReply,
  onJumpTo,
}: ReviewThreadIndexProps) {
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

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel rule count={comments.length}>
        Review
      </SectionLabel>

      {comments.length === 0 ? (
        <p className="text-muted-foreground text-[12.5px]">
          Hover a diff line and click the ✎ to leave a note. Nothing reaches the
          agent until you submit the review.
        </p>
      ) : (
        [...byFile.entries()].map(([path, list]) => (
          <div key={path}>
            <div className="dense-meta mb-1 truncate">{path}</div>
            {list.map((c) => (
              <div key={c.id}>
                <div className="flex items-center gap-1.5 px-1">
                  <button
                    type="button"
                    disabled={onJumpTo === undefined}
                    onClick={() => onJumpTo?.(c)}
                    className="dense-meta hover:text-accent-foreground"
                  >
                    {c.startLine !== undefined && c.startLine !== c.line
                      ? `L${c.startLine}–${c.line}`
                      : `L${c.line}`}
                  </button>
                  {c.pending && (
                    <span className="dense-meta text-state-waiting">
                      pending
                    </span>
                  )}
                </div>
                <ReviewThread
                  comment={c}
                  anchor="exact"
                  onResolve={(resolved) => void onResolve(c.id, resolved)}
                  onReply={(body) => void onReply(c.id, body)}
                />
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
