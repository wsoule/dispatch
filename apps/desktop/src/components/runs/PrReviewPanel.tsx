import type {
  Finding,
  PrConversationItem,
  PrDetail,
  PrReviewEvent,
  PrStatus,
  RunMeta,
} from '@dispatch/client';
import { Button, cx, SkeletonText } from '@dispatch/ui';
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
import styles from './PrReviewPanel.module.css';
import {
  PrChecksPill,
  REVIEW_VERDICT,
  STATE_TONE,
  StatusPill,
} from './PrStatusPills';

// The 14px glyph a heading row or a button leads with; the 12px one inside a chip.
const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;
const CHIP_ICON = { size: 12, strokeWidth: 1.8, 'aria-hidden': true } as const;

// The header row: PR number + title, its open/merged state, review decision,
// CI check counts, mergeability, the diffstat, and a link out to GitHub.
function PrStatusHeader({ status }: { status: PrStatus }) {
  const { checks } = status;
  return (
    <div className={styles.header}>
      <div className={styles.titleRow}>
        <GitPullRequest className={styles.titleIcon} {...ICON} />
        <span className={styles.title}>{status.title}</span>
        <a
          href={status.url}
          target="_blank"
          rel="noreferrer"
          className={styles.prLink}
        >
          #{status.number}
          <ExternalLink {...CHIP_ICON} />
        </a>
      </div>
      <div className={styles.facts}>
        <StatusPill
          tone={status.isDraft ? 'muted' : STATE_TONE[status.state]}
          icon={<GitPullRequest {...CHIP_ICON} />}
        >
          {status.isDraft ? 'Draft' : status.state.toLowerCase()}
        </StatusPill>

        {status.reviewDecision === 'APPROVED' && (
          <StatusPill tone="success" icon={<Check {...CHIP_ICON} />}>
            Approved
          </StatusPill>
        )}
        {status.reviewDecision === 'CHANGES_REQUESTED' && (
          <StatusPill tone="warning" icon={<X {...CHIP_ICON} />}>
            Changes requested
          </StatusPill>
        )}
        {status.reviewDecision === 'REVIEW_REQUIRED' && (
          <StatusPill icon={<CircleDot {...CHIP_ICON} />}>
            Review required
          </StatusPill>
        )}

        <PrChecksPill checks={checks} />

        {status.mergeable === 'CONFLICTING' && (
          <StatusPill tone="danger" icon={<GitMerge {...CHIP_ICON} />}>
            Conflicts
          </StatusPill>
        )}

        {/* The diffstat follows the diff's own colours (the Pierre theme's
            green insertions and red deletions, ChangedFilesCard, ToolCard's
            edit diff): + in the success ink, − in the danger ink. The signs
            carry the meaning; the tones only reinforce them. */}
        <span className={cx(styles.meta, styles.diffstat)}>
          <span className="toneText" data-tone="success">
            +{status.additions}
          </span>{' '}
          <span className="toneText" data-tone="danger">
            −{status.deletions}
          </span>{' '}
          · {status.changedFiles} file
          {status.changedFiles === 1 ? '' : 's'}
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
    <div className={styles.entry}>
      <div className={styles.entryHead}>
        <span className={styles.author}>{item.author}</span>
        {verdict !== undefined && (
          <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
        )}
        {item.kind === 'comment' && (
          <span className={styles.meta}>commented</span>
        )}
        {item.kind === 'line-comment' && item.path !== undefined && (
          <span className={styles.path}>
            {item.path}
            {item.line !== undefined ? `:${item.line}` : ''}
          </span>
        )}
        {item.createdAt !== '' && (
          <span className={cx(styles.meta, styles.end)}>
            {formatRelativeTimeFromIso(item.createdAt)}
          </span>
        )}
      </div>
      {item.body.trim() !== '' && (
        <Markdown content={item.body} className={styles.entryBody} />
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
      <p className={cx(styles.error, 'toneText')} data-tone="danger">
        Couldn&rsquo;t load the agent&rsquo;s findings: {error}
      </p>
    );
  }
  const open = findings.filter((f) => f.verdict === 'open');
  // Never a "no findings" line: an empty list means no review has run, and
  // saying otherwise would read as a clean bill of health.
  if (open.length === 0) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>What the agent found</h3>
      {open.map((f) => (
        <div key={f.id} className={styles.finding}>
          <div className={styles.findingHead}>
            {/* Amber: an open finding is at risk until someone rules on it.
                The severity word beside it says how much. */}
            <span
              className={cx(styles.findingMark, 'toneText')}
              data-tone="warning"
            >
              <TriangleAlert {...CHIP_ICON} />
            </span>
            <span className={styles.meta}>{f.severity}</span>
            <span className={styles.findingTitle}>{f.title}</span>
            {f.file !== null && (
              <span className={styles.path}>
                {f.file}
                {f.line !== null && `:${f.line}`}
              </span>
            )}
          </div>
          <p className={styles.detail}>{f.detail}</p>
        </div>
      ))}
    </section>
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
function ForkConfirm({
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
    <div className={styles.fork} data-tone="warning">
      <p className={styles.forkText}>
        This PR comes from a fork owned by{' '}
        <span className={styles.owner}>{owner}</span>. Reviewing it checks that
        code out and runs it on this machine.
      </p>
      <div className={styles.actions}>
        <Button variant="quiet" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          icon={<Bot {...ICON} />}
          onClick={onConfirm}
        >
          Run the review
        </Button>
      </div>
    </div>
  );
}

/**
 * The GitHub PR review surface shown beside the Pierre diff on the full-page PR review: the
 * PR's live status (state, checks, review decision, mergeability, diffstat), its conversation
 * (reviews + PR comments + code-line comments), and a composer to approve / request changes /
 * comment — each action shelling out to `gh` server-side and syncing straight to GitHub. The
 * diff itself stays rendered by PrReviewView's own diff surface (PierreReviewDiff); this
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
    <div className={styles.panel}>
      {loading && detail === undefined ? (
        <SkeletonText lines={2} label="Loading the pull request" />
      ) : error !== null ? (
        <p className={cx(styles.error, 'toneText')} data-tone="danger">
          Couldn&rsquo;t load the PR: {error}
        </p>
      ) : detail === undefined ? null : (
        <>
          <PrStatusHeader status={detail.status} />

          <AgentFindings findings={findings} error={findingsError} />

          {detail.conversation.length > 0 && (
            <section className={styles.section}>
              <h3 className={styles.heading}>Conversation</h3>
              {detail.conversation.map((item, i) => (
                <ConversationRow key={i} item={item} />
              ))}
            </section>
          )}

          {actionError !== null && (
            <p className={cx(styles.error, 'toneText')} data-tone="danger">
              {actionError}
            </p>
          )}

          {!isOpen ? (
            <div className={styles.composer}>
              <div className={styles.closed}>
                <p className={styles.closedLine}>
                  {state === 'MERGED' ? (
                    <GitMerge {...ICON} />
                  ) : (
                    <X {...ICON} />
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
              <textarea
                rows={2}
                aria-label="Comment"
                placeholder="Leave a comment…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className={cx('textarea', styles.textarea)}
              />
              <div className={styles.actions}>
                <Button
                  size="sm"
                  disabled={busy || needsBody}
                  icon={<MessageSquare {...ICON} />}
                  onClick={() => void act(() => onComment(draft.trim()))}
                >
                  Comment
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.composer}>
              {dispatchedRunId !== null && (
                <p className={styles.meta}>
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
                  <span className={styles.start}>
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={busy}
                      icon={<Bot {...ICON} />}
                      onClick={() => {
                        if (forkOwner !== undefined) setAskedForPr(prNumber);
                        else void dispatchAgentReview(false);
                      }}
                    >
                      Review with agent
                    </Button>
                  </span>
                ))}
              <textarea
                rows={2}
                aria-label="Review comment"
                placeholder="Leave a review comment…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className={cx('textarea', styles.textarea)}
              />
              <div className={styles.actions}>
                <Button
                  size="sm"
                  disabled={busy || needsBody}
                  icon={<MessageSquare {...ICON} />}
                  onClick={() =>
                    void act(() =>
                      stagedNotes > 0
                        ? onReview('comment', draft.trim())
                        : onComment(draft.trim())
                    )
                  }
                >
                  Comment
                </Button>
                <Button
                  size="sm"
                  disabled={busy || needsBody}
                  icon={<X {...ICON} />}
                  onClick={() =>
                    void act(() => onReview('request-changes', draft.trim()))
                  }
                >
                  Request changes
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  icon={<Check {...ICON} />}
                  onClick={() =>
                    void act(() =>
                      onReview(
                        'approve',
                        draft.trim() === '' ? undefined : draft.trim()
                      )
                    )
                  }
                >
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
