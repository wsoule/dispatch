import type {
  PrConversationItem,
  PrDetail,
  PrReviewEvent,
  PrStatus,
} from '@dispatch/client';
import {
  Check,
  CircleDot,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
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

interface PrReviewPanelProps {
  detail: PrDetail | undefined;
  loading: boolean;
  error: string | null;
  onReview: (event: PrReviewEvent, body?: string) => Promise<void>;
  onComment: (body: string) => Promise<void>;
}

/**
 * The GitHub PR review surface shown alongside the Pierre diff once a run has an open PR: the
 * PR's live status (state, checks, review decision, mergeability, diffstat), its conversation
 * (reviews + PR comments + code-line comments), and a composer to approve / request changes /
 * comment — each action shelling out to `gh` server-side and syncing straight to GitHub. The
 * diff itself stays rendered by RunReviewView's per-file FileDiff stack (RunDiffView); this
 * panel is the review layer on top of it.
 */
export function PrReviewPanel({
  detail,
  loading,
  error,
  onReview,
  onComment,
}: PrReviewPanelProps) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const isMerged = detail?.status.state === 'MERGED';
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

          {isMerged ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-[12px]">
              <GitMerge className="size-3.5" />
              This PR is merged.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
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
                  onClick={() => void act(() => onComment(draft.trim()))}
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
