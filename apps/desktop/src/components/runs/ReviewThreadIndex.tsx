import type { ReviewComment } from '@dispatch/client';
import { useMemo } from 'react';

import type { ReviewDestination } from './ReviewThread';
import { ReviewThread } from './ReviewThread';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome/SectionLabel';

interface ReviewThreadIndexProps {
  comments: ReviewComment[];
  onResolve: (commentId: string, resolved: boolean) => Promise<void>;
  onReply: (commentId: string, body: string) => Promise<void>;
  /** Scrolls the diff to a thread. Omitted when there is no diff to scroll. */
  onJumpTo?: (comment: ReviewComment) => void;
  /** Where notes written here end up. Defaults to the run wording. */
  destination?: ReviewDestination;
}

const EMPTY_HINT: Record<ReviewDestination, string> = {
  agent:
    'Hover a diff line and click the ✎ to leave a note. Nothing reaches ' +
    'the agent until you submit the review.',
  github:
    'Hover a diff line and click the ✎ to leave a note. Nothing reaches ' +
    'GitHub until you submit a review from the panel above.',
};

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
  destination = 'agent',
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
          {EMPTY_HINT[destination]}
        </p>
      ) : (
        [...byFile.entries()].map(([path, list]) => (
          <div key={path}>
            <div className="dense-meta mb-1 truncate">{path}</div>
            {list.map((c) => (
              <div key={c.id}>
                <div className="flex items-center gap-1.5 px-1">
                  {/* Button's own `text-sm font-medium` are Tailwind utilities, which — per
                      `.dense-meta`'s own doc comment in global.css — always beat a
                      `@layer components` class on the same element regardless of source
                      order. Both have to be cancelled explicitly or the line reference
                      would render at the wrong size/weight. */}
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={onJumpTo === undefined}
                    onClick={() => onJumpTo?.(c)}
                    className="dense-meta hover:text-accent-foreground h-auto p-0 text-[length:var(--text-meta)] font-normal hover:bg-transparent"
                  >
                    {c.startLine !== undefined && c.startLine !== c.line
                      ? `L${c.startLine}–${c.line}`
                      : `L${c.line}`}
                  </Button>
                  {c.pending && (
                    <span className="dense-meta text-state-waiting">
                      pending
                    </span>
                  )}
                </div>
                <ReviewThread
                  comment={c}
                  anchor="exact"
                  destination={destination}
                  onResolve={(resolved) => onResolve(c.id, resolved)}
                  onReply={(body) => onReply(c.id, body)}
                />
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
