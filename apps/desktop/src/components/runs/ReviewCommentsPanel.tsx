import type { ReviewComment, ReviewVerdict } from '@dispatch/client';

import { ReviewThreadIndex } from './ReviewThreadIndex';
import { ReviewVerdictBar } from './ReviewVerdictBar';

interface ReviewCommentsPanelProps {
  comments: ReviewComment[];
  onResolve: (commentId: string, resolved: boolean) => Promise<void>;
  onReply: (commentId: string, body: string) => Promise<void>;
  onSubmit: (
    verdict: ReviewVerdict,
    body: string
  ) => Promise<{ published: number; error?: string }>;
  /** Scrolls the diff to a thread. Omitted when there is no diff to scroll. */
  onJumpTo?: (comment: ReviewComment) => void;
  /** Dispatches a review agent over this run's diff instead of a human reading it here. Omitted
   * where starting one doesn't make sense (a PR's review, say) — the button hides rather than
   * disabling, since there's nothing the omission leaves for the reviewer to do about it. */
  onStartAiReview?: () => Promise<void>;
}

/**
 * The review's thread index and its verdict, stacked in one column.
 *
 * Kept as a single component because the in-Runs review renders both halves together in a narrow
 * column. The full-page review composes `ReviewThreadIndex` and `ReviewVerdictBar` itself, so it
 * can collapse the threads and put the verdict in a footer bar instead.
 */
export function ReviewCommentsPanel({
  comments,
  onResolve,
  onReply,
  onSubmit,
  onJumpTo,
  onStartAiReview,
}: ReviewCommentsPanelProps) {
  return (
    <div className="flex flex-col gap-4">
      <ReviewThreadIndex
        comments={comments}
        onResolve={onResolve}
        onReply={onReply}
        onJumpTo={onJumpTo}
      />
      <ReviewVerdictBar
        layout="stacked"
        comments={comments}
        onSubmit={onSubmit}
        onStartAiReview={onStartAiReview}
      />
    </div>
  );
}
