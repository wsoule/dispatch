import type { ReviewComment, ReviewVerdict } from '@dispatch/client';
import { Bot, Check, MessageSquare, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ReviewThread } from './ReviewThread';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome/SectionLabel';

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

const VERDICTS: {
  value: ReviewVerdict;
  label: string;
  hint: string;
  icon: typeof Check;
}[] = [
  {
    value: 'comment',
    label: 'Comment',
    hint: 'Sends the notes. Nothing else happens.',
    icon: MessageSquare,
  },
  {
    value: 'request-changes',
    label: 'Request changes',
    hint: 'Resumes the agent on the same branch with your review attached.',
    icon: Undo2,
  },
  {
    value: 'approve',
    label: 'Approve',
    hint: 'Queues the work to land, once verify passes.',
    icon: Check,
  },
];

/**
 * The review's thread index and its verdict.
 *
 * Comments are *staged* rather than sent: you read the whole diff, leave notes as you go, and
 * the agent hears about them once, with a decision attached. That is what makes this a review
 * rather than a stream of interruptions, and it is why the submit block counts pending comments
 * instead of just offering a button.
 *
 * Threads appear here as well as under their lines because the two answer different questions —
 * "what did I say about this line" is inline, "what have I said overall, and am I done" is here.
 */
export function ReviewCommentsPanel({
  comments,
  onResolve,
  onReply,
  onSubmit,
  onJumpTo,
  onStartAiReview,
}: ReviewCommentsPanelProps) {
  const [verdict, setVerdict] = useState<ReviewVerdict>('comment');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  // Idle/starting/started/error rather than a couple of booleans, so a stale error can't linger
  // once a second attempt is under way and there's exactly one thing to show at a time.
  const [aiReview, setAiReview] = useState<
    | { status: 'idle' }
    | { status: 'starting' }
    | { status: 'started' }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  async function startAiReview() {
    if (onStartAiReview === undefined) return;
    setAiReview({ status: 'starting' });
    try {
      await onStartAiReview();
      setAiReview({ status: 'started' });
    } catch (err) {
      setAiReview({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const pending = comments.filter((c) => c.pending);
  const open = comments.filter((c) => !c.resolved && !c.pending);

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

  // Requesting changes with an empty review would resume the agent to tell it nothing.
  const canSubmit =
    verdict !== 'request-changes' ||
    summary.trim() !== '' ||
    pending.length > 0 ||
    open.length > 0;

  async function submit() {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const res = await onSubmit(verdict, summary.trim());
      if (res.error !== undefined) {
        // The comments published even though the verdict action failed — report both, so the
        // reviewer knows their writing survived and only the action needs retrying.
        setError(
          `${res.published} comment${res.published === 1 ? '' : 's'} published, but the verdict did not apply: ${res.error}`
        );
        return;
      }
      setSummary('');
      setSent(
        res.published > 0
          ? `Review sent — ${res.published} comment${res.published === 1 ? '' : 's'}.`
          : 'Review sent.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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

      <div className="shadow-hairline rounded-lg p-3">
        <SectionLabel>Finish the review</SectionLabel>

        {/* A row of its own rather than riding beside the label — this column is narrow enough
            that a button sharing the label's row wraps "Finish the review" onto three lines. */}
        {onStartAiReview !== undefined && (
          <div className="mt-2 flex flex-col gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={aiReview.status === 'starting'}
              onClick={() => void startAiReview()}
              className="self-start"
            >
              <Bot className="size-3.5" />
              {aiReview.status === 'starting'
                ? 'Starting…'
                : 'Ask an agent to review'}
            </Button>
            {aiReview.status === 'started' && (
              <p className="text-state-review text-[11px]">
                Review started — its findings land on the task once it finishes.
              </p>
            )}
            {aiReview.status === 'error' && (
              <p className="text-state-failed text-[11px]">
                Couldn&rsquo;t start the review: {aiReview.message}
              </p>
            )}
          </div>
        )}

        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Anything the agent should know overall…"
          className="mt-2 min-h-[64px] w-full resize-y bg-transparent text-[12.5px] outline-none"
        />

        <div className="mt-2 flex flex-col gap-1">
          {VERDICTS.map((v) => {
            const Icon = v.icon;
            const active = verdict === v.value;
            return (
              <label
                key={v.value}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5',
                  active ? 'bg-accent/15' : 'hover:bg-muted/40'
                )}
              >
                <input
                  type="radio"
                  name="verdict"
                  checked={active}
                  onChange={() => setVerdict(v.value)}
                  className="accent-accent mt-0.5 size-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[12.5px]">
                    <Icon className="size-3" />
                    {v.label}
                  </span>
                  {/* Each verdict states what it will actually do — that "approve" means
                      "queues a merge" is not guessable from the word alone. */}
                  <span className="text-muted-foreground block text-[11px] leading-snug">
                    {v.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {error !== null && (
          <p className="text-state-failed mt-2 text-[12px]">{error}</p>
        )}
        {sent !== null && (
          <p className="text-state-review mt-2 text-[12px]">{sent}</p>
        )}

        <div className="mt-2 flex items-center gap-2">
          <span className="dense-meta flex-1">
            {pending.length > 0
              ? `${pending.length} pending`
              : open.length > 0
                ? `${open.length} already sent`
                : 'no comments'}
          </span>
          <button
            type="button"
            disabled={busy || !canSubmit}
            onClick={() => void submit()}
            className="bg-accent text-accent-foreground rounded-md px-2.5 py-1 text-[12px] disabled:opacity-50"
          >
            {busy ? 'Submitting…' : 'Submit review'}
          </button>
        </div>
      </div>
    </div>
  );
}
