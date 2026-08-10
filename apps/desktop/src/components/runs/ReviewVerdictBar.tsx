import type { ReviewComment, ReviewVerdict } from '@dispatch/client';
import { Bot, Check, GitPullRequest, MessageSquare, Undo2 } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { ButtonGroup } from '@/ui/button-group';
import { Panel } from '@/ui/chrome';
import { SectionLabel } from '@/ui/chrome/SectionLabel';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { Textarea } from '@/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';

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
  //
  // `CheckboxPrimitive.Root asChild` around a real `<input>`, not the shadcn
  // `Checkbox` wrapper — same device AgentsSection.tsx already uses for its
  // radios (`RadioGroupPrimitive.Item asChild`). Slot's mergeProps gives the
  // child's own `type`/`checked` priority over Radix's `type="button"`, and
  // `checked` is consumed internally by the primitive rather than re-emitted
  // onto the trigger, so the rendered node is a genuine native checkbox with
  // a working `.checked` — `getByLabelText(...).checked` in both
  // ReviewVerdictBar.test.tsx and ReviewCommentsPanel.test.tsx keeps working
  // unedited. `readOnly` only silences React's "controlled input needs
  // onChange" warning; Radix's own composed `onClick` still drives
  // `onCheckedChange` (`readonly` is inert on a checkbox input in the DOM).
  const githubCheckbox = !canPostToGitHub ? null : (
    <label className="flex min-w-0 cursor-pointer flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px]">
      <CheckboxPrimitive.Root
        checked={postToGitHub}
        onCheckedChange={(checked) => setPostToGitHub(checked === true)}
        asChild
      >
        <input
          type="checkbox"
          checked={postToGitHub}
          readOnly
          className="accent-accent size-3 shrink-0"
        />
      </CheckboxPrimitive.Root>
      <GitPullRequest className="size-3 shrink-0" />
      Also post to GitHub
      <span className="text-muted-foreground text-[11px] leading-snug">
        Off, the review still goes back to the agent — only the pull request is
        left alone.
      </span>
    </label>
  );

  const submitButton = (
    <Button
      disabled={busy || !canSubmit}
      onClick={() => void submit()}
      className="shrink-0"
    >
      {busy ? 'Submitting…' : 'Submit review'}
    </Button>
  );

  // The footer form: one row, so the diff above it keeps the height. Verdict hints move to
  // a Tooltip on each radio — there is no room for three lines of explanation on a single row,
  // and unlike a hover `title` a Tooltip actually reaches keyboard/screen-reader users.
  if (layout === 'bar') {
    return (
      <div className="border-border flex shrink-0 flex-col gap-1.5 border-t pt-3">
        <div className="flex items-center gap-3">
          <Input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Anything the agent should know overall…"
            className="h-auto min-w-0 flex-1 border-none bg-transparent px-0 text-[12.5px] shadow-none outline-none focus-visible:ring-0"
          />
          {/* RadioGroup's own base is `grid gap-3` (a vertical stack) — `flex-row` alone
              can't dedupe against that `display: grid` via twMerge (different utility
              group), so `flex` has to be spelled out too or the grid layout survives
              underneath it, same trap as shadow-hairline-strong vs shadow-lg.
              A local TooltipProvider, not just App's root one: this component renders
              standalone in its own tests, with no ambient provider above it. */}
          <TooltipProvider>
            <RadioGroup
              value={verdict}
              onValueChange={(value) => setVerdict(value as ReviewVerdict)}
              className="flex shrink-0 flex-row items-center gap-2"
            >
              {VERDICTS.map((v) => {
                const Icon = v.icon;
                const active = verdict === v.value;
                return (
                  <Label
                    key={v.value}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-normal',
                      active ? 'bg-accent/15' : 'hover:bg-muted/40'
                    )}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <RadioGroupItem value={v.value} className="size-3" />
                      </TooltipTrigger>
                      <TooltipContent>{v.hint}</TooltipContent>
                    </Tooltip>
                    <Icon className="size-3" />
                    {v.label}
                  </Label>
                );
              })}
            </RadioGroup>
          </TooltipProvider>
          <ButtonGroup>
            {aiReviewButton}
            {submitButton}
          </ButtonGroup>
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
    <Panel className="p-3">
      <SectionLabel>Finish the review</SectionLabel>

      {/* A row of its own rather than riding beside the label — this column is narrow enough
          that a button sharing the label's row wraps "Finish the review" onto three lines. */}
      {aiReviewButton !== null && (
        <div className="mt-2 flex flex-col gap-1">
          {aiReviewButton}
          {aiReviewStatus}
        </div>
      )}

      <Textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Anything the agent should know overall…"
        className="mt-2 min-h-[64px] w-full resize-y border-none bg-transparent px-0 text-[12.5px] shadow-none outline-none focus-visible:ring-0"
      />

      {/* Hints stay visible text here (unlike the bar layout's Tooltip) — there's room for
          them on their own line under each option. */}
      <RadioGroup
        value={verdict}
        onValueChange={(value) => setVerdict(value as ReviewVerdict)}
        className="mt-2 gap-1"
      >
        {VERDICTS.map((v) => {
          const Icon = v.icon;
          const active = verdict === v.value;
          return (
            <Label
              key={v.value}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 font-normal',
                active ? 'bg-accent/15' : 'hover:bg-muted/40'
              )}
            >
              <RadioGroupItem value={v.value} className="mt-0.5 size-3.5" />
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
            </Label>
          );
        })}
      </RadioGroup>

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
    </Panel>
  );
}
