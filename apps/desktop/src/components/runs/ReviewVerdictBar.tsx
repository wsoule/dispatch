import type { ReviewComment, ReviewVerdict } from '@dispatch/client';
import { Bot, Check, GitPullRequest, MessageSquare, Undo2 } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome/SectionLabel';

interface ReviewVerdictBarProps {
  /** 'stacked' is the card the in-Runs review shows in its column; 'bar' is the footer the
   * full-page review uses, laid out on one row under the diff. */
  layout: 'stacked' | 'bar';
  comments: ReviewComment[];
  onSubmit: (
    verdict: ReviewVerdict,
    body: string,
    postToGitHub: boolean
  ) => Promise<{ published: number; error?: string }>;
  /** True when this run's work is on a pull request, which is the only case
   * where posting the review to GitHub is possible at all. The checkbox is
   * hidden rather than disabled otherwise: there is nothing the reviewer
   * could do about a run that has no PR. */
  canPostToGitHub?: boolean;
  /** Dispatches a review agent over this run's diff instead of a human reading it here. Omitted
   * where starting one doesn't make sense (a PR's review, say) — the button hides rather than
   * disabling, since there's nothing the omission leaves for the reviewer to do about it. */
  onStartAiReview?: () => Promise<void>;
  /** What approving would wave through — dead guards, open findings. Stated beside the pending
   * count rather than blocking submit: the human makes the call, this only says what the call is. */
  extraWarnings?: string[];
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
 * Finishing the review: the overall note, the verdict, and what submitting would do.
 *
 * Comments are *staged* rather than sent — you read the whole diff, leave notes as you go, and
 * the agent hears about them once, with a decision attached. That is why this counts pending
 * comments instead of just offering a button.
 */
export function ReviewVerdictBar({
  layout,
  comments,
  onSubmit,
  onStartAiReview,
  canPostToGitHub = false,
  extraWarnings = [],
}: ReviewVerdictBarProps) {
  const [verdict, setVerdict] = useState<ReviewVerdict>('comment');
  // Off by default, matching the API: submitting is about telling the agent,
  // and mirroring that onto the PR is a separate, deliberate choice.
  const [postToGitHub, setPostToGitHub] = useState(false);
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
      const res = await onSubmit(
        verdict,
        summary.trim(),
        canPostToGitHub && postToGitHub
      );
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

  const countText =
    pending.length > 0
      ? `${pending.length} pending`
      : open.length > 0
        ? `${open.length} already sent`
        : 'no comments';

  const warnings =
    extraWarnings.length > 0 ? (
      <span className="text-state-waiting text-[11.5px]">
        {extraWarnings.join(' · ')}
      </span>
    ) : null;

  const aiReviewButton =
    onStartAiReview === undefined ? null : (
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
    );

  const aiReviewStatus =
    aiReview.status === 'started' ? (
      <p className="text-state-review text-[11px]">
        Review started — its findings land here once it finishes.
      </p>
    ) : aiReview.status === 'error' ? (
      <p className="text-state-failed text-[11px]">
        Couldn&rsquo;t start the review: {aiReview.message}
      </p>
    ) : null;

  // Shown only for a run whose work is on a PR. The explanation sits inside
  // the label, in both layouts: leaving the box off is not "skip the review",
  // it is "keep the review off GitHub", and a hover `title` says that to
  // nobody using a keyboard or a screen reader.
  const githubCheckbox = !canPostToGitHub ? null : (
    <label className="flex min-w-0 cursor-pointer flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px]">
      <input
        type="checkbox"
        checked={postToGitHub}
        onChange={(e) => setPostToGitHub(e.target.checked)}
        className="accent-accent size-3 shrink-0"
      />
      <GitPullRequest className="size-3 shrink-0" />
      Also post to GitHub
      <span className="text-muted-foreground text-[11px] leading-snug">
        Off, the review still goes back to the agent — only the pull request is
        left alone.
      </span>
    </label>
  );

  const submitButton = (
    <button
      type="button"
      disabled={busy || !canSubmit}
      onClick={() => void submit()}
      className="bg-accent text-accent-foreground shrink-0 rounded-md px-2.5 py-1 text-[12px] disabled:opacity-50"
    >
      {busy ? 'Submitting…' : 'Submit review'}
    </button>
  );

  // The footer form: one row, so the diff above it keeps the height. Verdict hints move to
  // `title` — there is no room for three lines of explanation on a single row.
  if (layout === 'bar') {
    return (
      <div className="border-border flex shrink-0 flex-col gap-1.5 border-t pt-3">
        <div className="flex items-center gap-3">
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Anything the agent should know overall…"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
          />
          <div className="flex shrink-0 items-center gap-2">
            {VERDICTS.map((v) => {
              const Icon = v.icon;
              const active = verdict === v.value;
              return (
                <label
                  key={v.value}
                  title={v.hint}
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px]',
                    active ? 'bg-accent/15' : 'hover:bg-muted/40'
                  )}
                >
                  <input
                    type="radio"
                    name="verdict-bar"
                    checked={active}
                    onChange={() => setVerdict(v.value)}
                    className="accent-accent size-3 shrink-0"
                  />
                  <Icon className="size-3" />
                  {v.label}
                </label>
              );
            })}
          </div>
          {aiReviewButton}
          {submitButton}
        </div>
        {/* Wraps: the GitHub label carries a full sentence, which on a narrow
            window would otherwise squeeze the status text beside it. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="dense-meta shrink-0">{countText}</span>
          {githubCheckbox}
          {warnings}
          <span className="flex-1" />
          {aiReviewStatus}
          {error !== null && (
            <span className="text-state-failed text-[11.5px]">{error}</span>
          )}
          {sent !== null && (
            <span className="text-state-review text-[11.5px]">{sent}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="shadow-hairline rounded-lg p-3">
      <SectionLabel>Finish the review</SectionLabel>

      {/* A row of its own rather than riding beside the label — this column is narrow enough
          that a button sharing the label's row wraps "Finish the review" onto three lines. */}
      {aiReviewButton !== null && (
        <div className="mt-2 flex flex-col gap-1">
          {aiReviewButton}
          {aiReviewStatus}
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

      {githubCheckbox !== null && <div className="mt-2">{githubCheckbox}</div>}

      {error !== null && (
        <p className="text-state-failed mt-2 text-[12px]">{error}</p>
      )}
      {sent !== null && (
        <p className="text-state-review mt-2 text-[12px]">{sent}</p>
      )}

      <div className="mt-2 flex items-center gap-2">
        <span className="dense-meta flex-1">{countText}</span>
        {warnings}
        {submitButton}
      </div>
    </div>
  );
}
