import type { ReviewComment } from '@dispatch/client';
import { Button, cx, SectionHeader } from '@dispatch/ui';
import { useMemo } from 'react';

import type { ReviewDestination } from './ReviewThread';
import { ReviewThread } from './ReviewThread';
import styles from './ReviewThreadIndex.module.css';

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
    <div className={styles.root}>
      {/* The count is part of the heading's words, so it reads "Review 3". */}
      <SectionHeader name="Review" count={comments.length} rule />

      {comments.length === 0 ? (
        <p className={styles.empty}>{EMPTY_HINT[destination]}</p>
      ) : (
        [...byFile.entries()].map(([path, list]) => (
          <div key={path} className={styles.file}>
            <div className={styles.path} title={path}>
              {path}
            </div>
            {list.map((c) => (
              <div key={c.id} className={styles.thread}>
                <div className={styles.threadHead}>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={onJumpTo === undefined}
                    onClick={() => onJumpTo?.(c)}
                    className={styles.line}
                  >
                    {c.startLine !== undefined && c.startLine !== c.line
                      ? `L${c.startLine}–${c.line}`
                      : `L${c.line}`}
                  </Button>
                  {c.pending && (
                    <span
                      className={cx(styles.pending, 'toneText')}
                      data-tone="warning"
                    >
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
