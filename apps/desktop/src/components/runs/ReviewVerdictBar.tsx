import type { ReviewComment, ReviewVerdict } from '@dispatch/client';
import type { RadioOption } from '@dispatch/ui';
import {
  Button,
  Checkbox,
  ChipButton,
  cx,
  RadioGroup,
  SectionHeader,
} from '@dispatch/ui';
import { Bot, Check, MessageSquare, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import styles from './ReviewVerdictBar.module.css';

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
  /** True while a review agent's run is live over this run's branch — derived from the run list
   * (see `liveReviewAgentFor`), so it survives navigating away and back, which the click-local
   * "Starting…" state below cannot. Disables re-dispatching a second agent onto the same diff. */
  reviewAgentLive?: boolean;
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

// The verdicts as radio options: each label is its icon and words, and its hint (what the
// verdict will actually do) is the radio's description, a visible line or a tooltip by layout.
const VERDICT_OPTIONS: readonly RadioOption[] = VERDICTS.map((v) => {
  const Icon = v.icon;
  return {
    value: v.value,
    label: (
      <span className={styles.verdictLabel}>
        <Icon
          className={styles.verdictIcon}
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        {v.label}
      </span>
    ),
    hint: v.hint,
  };
});

// Narrows a radio's value back to a verdict; the group only ever reports one of VERDICTS.
function isVerdict(value: string): value is ReviewVerdict {
  return VERDICTS.some((v) => v.value === value);
}

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
  reviewAgentLive = false,
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

  // Once the agent's own run shows up in the run list, the derived indicator
  // owns the story — clearing the local state here means it can't linger as a
  // stale "started" after that run finishes and the indicator goes away.
  useEffect(() => {
    if (reviewAgentLive) setAiReview({ status: 'idle' });
  }, [reviewAgentLive]);

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
          ? `Review sent. ${res.published} comment${res.published === 1 ? '' : 's'}.`
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

  const pickVerdict = (value: string) => {
    if (isVerdict(value)) setVerdict(value);
  };

  const count = <span className={cx(styles.count, 'num')}>{countText}</span>;

  const warnings =
    extraWarnings.length > 0 ? (
      <span className={cx(styles.message, 'toneText')} data-tone="warning">
        {extraWarnings.join(' · ')}
      </span>
    ) : null;

  const aiReviewButton =
    onStartAiReview === undefined ? null : (
      <ChipButton
        disabled={reviewAgentLive || aiReview.status === 'starting'}
        onClick={() => void startAiReview()}
      >
        <Bot size={14} strokeWidth={1.8} aria-hidden="true" />
        {reviewAgentLive
          ? 'Agent reviewing…'
          : aiReview.status === 'starting'
            ? 'Starting…'
            : 'Ask an agent to review'}
      </ChipButton>
    );

  // A review agent at work is in progress (the info tone); a failed start is danger.
  const aiReviewStatus = reviewAgentLive ? (
    <p className={cx(styles.message, 'toneText')} data-tone="info">
      An agent is reviewing this run — its findings land here once it finishes.
    </p>
  ) : aiReview.status === 'started' ? (
    <p className={cx(styles.message, 'toneText')} data-tone="info">
      Review started — its findings land here once it finishes.
    </p>
  ) : aiReview.status === 'error' ? (
    <p className={cx(styles.message, 'toneText')} data-tone="danger">
      Couldn&rsquo;t start the review: {aiReview.message}
    </p>
  ) : null;

  const errorLine =
    error === null ? null : (
      <p className={cx(styles.message, 'toneText')} data-tone="danger">
        {error}
      </p>
    );

  const sentLine =
    sent === null ? null : (
      <p className={cx(styles.message, 'toneText')} data-tone="success">
        {sent}
      </p>
    );

  // Shown only for a run whose work is on a PR. The explanation is the checkbox's note,
  // inside its label, in both layouts: leaving the box off is not "skip the review", it is
  // "keep the review off GitHub", and a hover `title` says that to nobody using a keyboard
  // or a screen reader. The library Checkbox is a native input, so its `checked` is what
  // ReviewVerdictBar.test.tsx and ReviewCommentsPanel.test.tsx read.
  const githubCheckbox = !canPostToGitHub ? null : (
    <Checkbox
      label="Also post to GitHub"
      note="Off, the review still goes back to the agent — only the pull request is left alone."
      checked={postToGitHub}
      onChange={setPostToGitHub}
    />
  );

  const submitButton = (
    <Button
      variant="primary"
      size="sm"
      busy={busy}
      busyLabel="Submitting…"
      disabled={!canSubmit}
      onClick={() => void submit()}
    >
      Submit review
    </Button>
  );

  // The footer form: one row, so the diff above it keeps the height. Verdict hints move to
  // a Tooltip on each radio (shown on hover and keyboard focus, and kept as the radio's
  // description) — there is no room for three lines of explanation on a single row.
  if (layout === 'bar') {
    return (
      <div className={styles.bar}>
        <div className={styles.barRow}>
          <input
            type="text"
            className={cx('input', styles.summaryInput)}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            aria-label="Review summary"
            placeholder="Anything the agent should know overall…"
          />
          <div className={styles.verdicts}>
            <RadioGroup
              label="Verdict"
              options={VERDICT_OPTIONS}
              value={verdict}
              onChange={pickVerdict}
              orientation="horizontal"
              size="sm"
              hintAs="tooltip"
            />
          </div>
          <div className={styles.actions}>
            {aiReviewButton}
            {submitButton}
          </div>
        </div>
        <div className={styles.status}>
          {count}
          {githubCheckbox}
          {warnings}
          <span className={styles.spacer} />
          {aiReviewStatus}
          {errorLine}
          {sentLine}
        </div>
      </div>
    );
  }

  // The stacked card: the heading, the agent-review button, the summary, the verdicts with
  // their hints as visible lines, the GitHub choice, then the count and the submit button.
  return (
    <div className={styles.card}>
      <SectionHeader name="Finish the review" />

      {aiReviewButton !== null && (
        <div className={styles.aiReview}>
          {aiReviewButton}
          {aiReviewStatus}
        </div>
      )}

      <textarea
        className={cx('textarea', styles.summaryArea)}
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        aria-label="Review summary"
        placeholder="Anything the agent should know overall…"
      />

      {/* Each verdict states what it will actually do — that "approve" means "queues a
          merge" is not guessable from the word alone — so the hints stay visible here. */}
      <RadioGroup
        label="Verdict"
        options={VERDICT_OPTIONS}
        value={verdict}
        onChange={pickVerdict}
      />

      {githubCheckbox}
      {errorLine}
      {sentLine}

      <div className={styles.foot}>
        <span className={styles.footCount}>{count}</span>
        {warnings}
        {submitButton}
      </div>
    </div>
  );
}
