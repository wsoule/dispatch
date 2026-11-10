import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { InitialsAvatar } from '../components/initials-avatar';
import { Link } from '../lib/link';
import { SkeletonText } from '../shell/skeleton';
import { cx } from '../tasks/class-names';
import { DEFAULT_TASK_LABELS, isExternalHref } from './shared';
import styles from './task-comment-list.module.css';
import type { TaskComment, TaskCommentListProps } from './types';

/** True when a slot was given something to draw. */
function hasNode(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

/* One comment, as Gr8r's: a round avatar, the author (semibold) and the
   date in the meta voice (with a link to the comment in the tracker, and
   the host's actions at the end of the row), then the text as typed, and
   the host's footer under it. A reply steps in by one avatar column and
   is announced as one. The head is a div, not a p, so a host menu's own
   layer (a div) nests validly. */
function CommentItem({
  comment,
  openLabel,
  newTabLabel,
  replyLabel,
}: {
  comment: TaskComment;
  openLabel: string;
  newTabLabel: string;
  replyLabel: string;
}): ReactNode {
  const external = comment.href !== undefined && isExternalHref(comment.href);
  const hasContent = hasNode(comment.content);
  const reply = comment.reply === true;
  return (
    <li
      className={cx(
        styles.item,
        comment.tone === 'muted' ? styles.muted : undefined,
        reply ? styles.reply : undefined
      )}
      data-tone={comment.tone ?? 'default'}
      data-reply={reply ? 'true' : undefined}
    >
      <span className={styles.avatar}>
        <InitialsAvatar name={comment.author} size="md" />
      </span>
      <div className={styles.main}>
        <div className={styles.head}>
          {reply ? <span className="srOnly">{replyLabel}, </span> : null}
          <span className={styles.author} dir="auto">
            {comment.author}
          </span>
          <span className="srOnly">, </span>
          <time className={styles.at} dateTime={comment.dateTime}>
            {comment.at}
          </time>
          {comment.href !== undefined ? (
            <Link
              href={comment.href}
              className={styles.link}
              target={external ? '_blank' : undefined}
              rel={external ? 'noreferrer' : undefined}
            >
              <ArrowUpRight size={12} strokeWidth={1.8} aria-hidden="true" />
              <span className="srOnly">
                {openLabel}
                {external ? ` (${newTabLabel})` : null}
              </span>
            </Link>
          ) : null}
          {hasNode(comment.actions) ? (
            <span className={styles.actions}>{comment.actions}</span>
          ) : null}
        </div>
        {hasContent ? (
          <div className={styles.content}>{comment.content}</div>
        ) : (
          <div className={styles.body} dir="auto">
            {comment.body}
          </div>
        )}
        {hasNode(comment.footer) ? (
          <div className={styles.footer}>{comment.footer}</div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The task's comments, Gr8r's way: oldest first, each with a round pastel
 * avatar (its hue picked from the author's name), author, date, and the
 * text as typed (line breaks kept, nothing parsed, each line in its own
 * direction) or the host's own rendering in `content`. Bots and
 * integrations (tone="muted") go quiet. A reply (`reply`) steps in one
 * avatar column under the comment it answers; a host's `actions` (its "⋯"
 * menu) end the head row and its `footer` (a reply box) follows the body.
 * Loading shows skeleton lines, an error one line with an optional Retry.
 * Not a client module: with plain data it renders in a server component.
 */
export function TaskCommentList({
  items,
  label = DEFAULT_TASK_LABELS.comments,
  emptyLabel = DEFAULT_TASK_LABELS.noComments,
  loading = false,
  loadingLabel = DEFAULT_TASK_LABELS.loadingComments,
  error = null,
  errorLabel = DEFAULT_TASK_LABELS.error,
  onRetry,
  retryLabel = DEFAULT_TASK_LABELS.retry,
  openLabel = DEFAULT_TASK_LABELS.openComment,
  newTabLabel = DEFAULT_TASK_LABELS.opensInNewTab,
  replyLabel = DEFAULT_TASK_LABELS.reply,
}: TaskCommentListProps): ReactNode {
  if (loading) return <SkeletonText lines={3} label={loadingLabel} />;
  if (error !== null && error !== '') {
    return (
      <div className={styles.error} role="alert">
        <span className={styles.errorKey}>{errorLabel}</span>
        <p className={styles.errorText}>
          {error}
          {onRetry !== undefined ? (
            <>
              {' '}
              <button type="button" className={styles.retry} onClick={onRetry}>
                {retryLabel}
              </button>
            </>
          ) : null}
        </p>
      </div>
    );
  }
  if (items.length === 0) return <p className={styles.empty}>{emptyLabel}</p>;
  return (
    <ol className={styles.list} aria-label={label}>
      {items.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          openLabel={openLabel}
          newTabLabel={newTabLabel}
          replyLabel={replyLabel}
        />
      ))}
    </ol>
  );
}
