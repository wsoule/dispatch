import type {
  Finding,
  PrConversationItem,
  PrDetail,
  PrReviewEvent,
  PrStatus,
  RunMeta,
} from '@dispatch/client';
import {
  Bot,
  Check,
  CircleDot,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useState } from 'react';

import { formatRelativeTimeFromIso } from '../../lib/format';
import { Markdown } from './Markdown';
import {
  PrChecksPill,
  REVIEW_VERDICT,
  STATE_TONE,
  StatusPill,
} from './PrStatusPills';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { Textarea } from '@/ui/textarea';

// The header row: PR number + title, its open/merged state, review decision,
// CI check counts, mergeability, the diffstat, and a link out to GitHub.
function PrStatusHeader({ status }: { status: PrStatus }) {
  const { checks } = status;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <GitPullRequest className="text-muted-foreground size-4 shrink-0" />
        <span className="text-foreground min-w-0 truncate text-[13px] font-medium">
          {status.title}
        </span>
        <a
          href={status.url}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex shrink-0 items-center gap-1 text-[11px]"
        >
          #{status.number}
          <ExternalLink className="size-3" />
        </a>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill
          tone={status.isDraft ? 'muted' : STATE_TONE[status.state]}
          icon={<GitPullRequest className="size-3" />}
        >
          {status.isDraft ? 'Draft' : status.state.toLowerCase()}
        </StatusPill>

        {status.reviewDecision === 'APPROVED' && (
          <StatusPill tone="green" icon={<Check className="size-3" />}>
            Approved
          </StatusPill>
        )}
        {status.reviewDecision === 'CHANGES_REQUESTED' && (
          <StatusPill tone="amber" icon={<X className="size-3" />}>
            Changes requested
          </StatusPill>
        )}
        {status.reviewDecision === 'REVIEW_REQUIRED' && (
          <StatusPill icon={<CircleDot className="size-3" />}>
            Review required
          </StatusPill>
        )}

        <PrChecksPill checks={checks} />

        {status.mergeable === 'CONFLICTING' && (
          <StatusPill tone="red" icon={<GitMerge className="size-3" />}>
            Conflicts
          </StatusPill>
        )}

        <span className="text-muted-foreground ml-1 font-mono text-[11px]">
          <span className="text-state-review">+{status.additions}</span>{' '}
          <span className="text-destructive">−{status.deletions}</span> ·{' '}
          {status.changedFiles} file{status.changedFiles === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  );
}

// One conversation entry — a submitted review (with its verdict), a PR-level
// comment, or a code-line comment (tagged with its file:line).
function ConversationRow({ item }: { item: PrConversationItem }) {
  const verdict =
    item.kind === 'review' && item.state !== undefined
      ? REVIEW_VERDICT[item.state]
      : undefined;
  return (
    <div className="border-border/60 flex flex-col gap-1 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-foreground font-medium">{item.author}</span>
        {verdict !== undefined && (
          <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
        )}
        {item.kind === 'comment' && (
          <span className="text-muted-foreground">commented</span>
        )}
        {item.kind === 'line-comment' && item.path !== undefined && (
          <span className="text-muted-foreground font-mono">
            {item.path}
            {item.line !== undefined ? `:${item.line}` : ''}
          </span>
        )}
        {item.createdAt !== '' && (
          <span className="text-muted-foreground/60 ml-auto">
            {formatRelativeTimeFromIso(item.createdAt)}
          </span>
        )}
      </div>
      {item.body.trim() !== '' && (
        <Markdown content={item.body} className="text-[13px]" />
      )}
    </div>
  );
}

/**
 * What agent reviews of this PR found, open findings only.
 *
 * A located finding is also a line comment on the diff, and shows here too —
 * this section is the whole verdict in one place. The findings that need it
 * are the unlocated ones ("this approach is wrong"): they have nowhere to
 * anchor as a comment, and a PR has no run behind it whose findings panel
 * would otherwise catch them.
 */
function AgentFindings({
  findings,
  error,
}: {
  findings: Finding[];
  error: string | null;
}) {
  // A failed fetch must not fall through to the silent case below: an empty
  // panel would read as "no review has run" when the truth is "unknown".
  if (error !== null) {
    return (
      <p className="text-destructive text-[12px]">
        Couldn&rsquo;t load the agent&rsquo;s findings: {error}
      </p>
    );
  }
  const open = findings.filter((f) => f.verdict === 'open');
  // Never a "no findings" line: an empty list means no review has run, and
  // saying otherwise would read as a clean bill of health.
  if (open.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        What the agent found
      </div>
      {open.map((f) => (
        <div key={f.id} className="text-[12.5px]">
          <div className="flex items-baseline gap-1.5">
            <TriangleAlert className="text-state-waiting size-3 shrink-0 self-center" />
            <span className="dense-meta shrink-0">{f.severity}</span>
            <span className="min-w-0 flex-1">{f.title}</span>
            {f.file !== null && (
              <span className="dense-meta shrink-0 font-mono">
                {f.file}
                {f.line !== null && `:${f.line}`}
              </span>
            )}
          </div>
          <p className="text-muted-foreground pl-4.5 text-[11px] leading-snug">
            {f.detail}
          </p>
        </div>
      ))}
    </div>
  );
}

interface PrReviewPanelProps {
  detail: PrDetail | undefined;
  loading: boolean;
  error: string | null;
  onReview: (event: PrReviewEvent, body?: string) => Promise<void>;
  onComment: (body: string) => Promise<void>;
  /**
   * Line notes staged for this PR but not yet on GitHub. With any queued,
   * Comment submits them as a COMMENT review — a bare conversation comment
   * would leave them staged, which is what "Comment" nowhere else means.
   */
  stagedNotes?: number;
  /**
   * Hands this PR to a review agent, which checks its head out and runs in
   * that code. Absent where there is nothing to dispatch — a run's own PR
   * panel reviews the run's worktree instead.
   */
  onAgentReview?: (confirmFork: boolean) => Promise<RunMeta>;
  /**
   * The login owning the head repository, set only when it is a fork. Its
   * presence is what turns the review button into a confirmation first.
   */
  forkOwner?: string;
  /**
   * Findings agent reviews of this PR raised. Defaults to none, which is what
   * a run's own PR panel has — its findings show in the run's case panel.
   */
  findings?: Finding[];
  /** Why the findings fetch failed, so an empty list is not read as "none". */
  findingsError?: string | null;
}

// The fork half of spec Decision 3: a fork PR's code is a stranger's, and
// reviewing it runs that code here. Named owner, plain sentence, no jargon —
// the user is agreeing to execution, not to a checkbox.
// Exported so Landing's worktree "Check out" reuses this surface for the
// same fork gate, instead of a second copy of the wording.
export function ForkConfirm({
  owner,
  busy,
  onCancel,
  onConfirm,
}: {
  owner: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="border-state-waiting-edge bg-state-waiting-surface flex flex-col gap-2 rounded-md border p-2">
      <p className="text-foreground text-[12px]">
        This PR comes from a fork owned by{' '}
        <span className="font-medium">{owner}</span>. Reviewing it checks that
        code out and runs it on this machine.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={onConfirm}>
          <Bot className="size-3.5" />
          Run the review
        </Button>
      </div>
    </div>
  );
}

/**
 * The GitHub PR review surface shown alongside the Pierre diff once a run has an open PR: the
 * PR's live status (state, checks, review decision, mergeability, diffstat), its conversation
 * (reviews + PR comments + code-line comments), and a composer to approve / request changes /
 * comment — each action shelling out to `gh` server-side and syncing straight to GitHub. The
 * diff itself stays rendered by RunReviewView's own diff surface (RunDiffView); this
 * panel is the review layer on top of it.
 */
export function PrReviewPanel({
  detail,
  loading,
  error,
  onReview,
  onComment,
  stagedNotes = 0,
  onAgentReview,
  forkOwner,
  findings = [],
  findingsError = null,
}: PrReviewPanelProps) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Which PR the fork confirm was opened for, not a bare flag: this panel is
  // reused as the queue switches rows, and agreeing to run one PR's code must
  // never carry over to the next.
  const [askedForPr, setAskedForPr] = useState<number | null>(null);
  // Same reasoning for the dispatched-run notice: it belongs to the PR it was
  // dispatched for, and must not read as this PR's once the queue moves on.
  const [dispatched, setDispatched] = useState<{
    prNumber: number;
    runId: string;
  } | null>(null);
  const prNumber = detail?.status.number ?? null;
  const askingFork = askedForPr !== null && askedForPr === prNumber;
  const dispatchedRunId =
    dispatched !== null && dispatched.prNumber === prNumber
      ? dispatched.runId
      : null;

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await run();
      setDraft('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Dispatching is not a composer action, so it shares act()'s busy/error
  // state but must not clear a draft the user is still writing. The server
  // gates forks too — `confirmFork` only reports what the user answered.
  async function dispatchAgentReview(confirmFork: boolean) {
    if (onAgentReview === undefined) return;
    setAskedForPr(null);
    setBusy(true);
    setActionError(null);
    try {
      const meta = await onAgentReview(confirmFork);
      // Saying which run started is what stops a second click: without it the
      // pane looks identical before and after a successful dispatch.
      if (prNumber !== null) setDispatched({ prNumber, runId: meta.id });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // GitHub takes a *review* only while the PR is open, and the server refuses
  // the batch before the POST once it is not. An ordinary comment it still
  // takes, so a closed PR narrows the composer rather than losing it.
  const state = detail?.status.state;
  const isOpen = state === undefined || state === 'OPEN';
  const needsBody = draft.trim() === '';

  return (
    <div className="border-border bg-muted/20 flex flex-col gap-3 rounded-md border p-3">
      {loading && detail === undefined ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-64 rounded-md" />
          <Skeleton className="h-5 w-40 rounded-md" />
        </div>
      ) : error !== null ? (
        <p className="text-destructive text-[12px]">
          Couldn&rsquo;t load the PR: {error}
        </p>
      ) : detail === undefined ? null : (
        <>
          <PrStatusHeader status={detail.status} />

          <AgentFindings findings={findings} error={findingsError} />

          {detail.conversation.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Conversation
              </div>
              {detail.conversation.map((item, i) => (
                <ConversationRow key={i} item={item} />
              ))}
            </div>
          )}

          {actionError !== null && (
            <p className="text-destructive text-[12px]">{actionError}</p>
          )}

          {!isOpen ? (
            <div className="flex flex-col gap-2">
              <div className="text-muted-foreground flex flex-col gap-1 text-[12px]">
                <p className="flex items-center gap-1.5">
                  {state === 'MERGED' ? (
                    <GitMerge className="size-3.5" />
                  ) : (
                    <X className="size-3.5" />
                  )}
                  This PR is {state === 'MERGED' ? 'merged' : 'closed'}.
                </p>
                {/* The whole point of showing the state here: notes staged
                    against a PR that has since closed cannot be published, and
                    a dead Comment button would never say so. */}
                {stagedNotes > 0 && (
                  <p>
                    {`GitHub does not accept reviews on a pull request that is ` +
                      `no longer open, so your ${stagedNotes} staged ` +
                      `note${stagedNotes === 1 ? '' : 's'} cannot be sent. ` +
                      'They stay saved here, and on the diff.'}
                  </p>
                )}
              </div>
              {/* Only the verdict is refused. A plain comment still lands, so
                  the composer narrows to onComment — never onReview, which
                  is the call the server 409s on a PR that is not open. */}
              <Textarea
                rows={2}
                placeholder="Leave a comment…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="text-[13px]"
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || needsBody}
                  onClick={() => void act(() => onComment(draft.trim()))}
                >
                  <MessageSquare className="size-3.5" />
                  Comment
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {dispatchedRunId !== null && (
                <p className="text-muted-foreground text-[12px]">
                  Review dispatched &mdash; run {dispatchedRunId}.
                </p>
              )}
              {onAgentReview !== undefined &&
                (askingFork && forkOwner !== undefined ? (
                  <ForkConfirm
                    owner={forkOwner}
                    busy={busy}
                    onCancel={() => setAskedForPr(null)}
                    onConfirm={() => void dispatchAgentReview(true)}
                  />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    className="self-start"
                    onClick={() => {
                      if (forkOwner !== undefined) setAskedForPr(prNumber);
                      else void dispatchAgentReview(false);
                    }}
                  >
                    <Bot className="size-3.5" />
                    Review with agent
                  </Button>
                ))}
              <Textarea
                rows={2}
                placeholder="Leave a review comment…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="text-[13px]"
              />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || needsBody}
                  onClick={() =>
                    void act(() =>
                      stagedNotes > 0
                        ? onReview('comment', draft.trim())
                        : onComment(draft.trim())
                    )
                  }
                >
                  <MessageSquare className="size-3.5" />
                  Comment
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || needsBody}
                  className="hover:text-state-waiting"
                  onClick={() =>
                    void act(() => onReview('request-changes', draft.trim()))
                  }
                >
                  <X className="size-3.5" />
                  Request changes
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      onReview(
                        'approve',
                        draft.trim() === '' ? undefined : draft.trim()
                      )
                    )
                  }
                >
                  <Check className="size-3.5" />
                  Approve
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
