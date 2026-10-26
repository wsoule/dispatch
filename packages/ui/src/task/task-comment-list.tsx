import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { InitialsAvatar } from '../components/initials-avatar';
import { Link } from '../lib/link';
import { SkeletonText } from '../shell/skeleton';
import { cx } from '../tasks/class-names';
import { DEFAULT_TASK_LABELS, isExternalHref } from './shared';
import styles from './task-comment-list.module.css';
import type { TaskComment, TaskCommentListProps } from './types';

/* One comment, as Gr8r's: a round avatar, the author (semibold) and the
   date in the meta voice (with a link to the comment in the tracker), then
   the text as typed. */
function CommentItem({
  comment,
  openLabel,
  newTabLabel,
}: {
  comment: TaskComment;
  openLabel: string;
  newTabLabel: string;
}): ReactNode {
  const external = comment.href !== undefined && isExternalHref(comment.href);
  const hasContent =
    comment.content !== undefined &&
    comment.content !== null &&
    comment.content !== false;
  return (
    <li
      className={cx(
        styles.item,
        comment.tone === 'muted' ? styles.muted : undefined
      )}
      data-tone={comment.tone ?? 'default'}
    >
      <span className={styles.avatar}>
        <InitialsAvatar name={comment.author} size="md" />
      </span>
      <div className={styles.main}>
        <p className={styles.head}>
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
        </p>
        {hasContent ? (
          <div className={styles.content}>{comment.content}</div>
        ) : (
          <div className={styles.body} dir="auto">
            {comment.body}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The task's comments, Gr8r's way: oldest first, each with a round pastel
 * avatar (its hue picked from the author's name), author, date, and the
 * text as typed (line breaks kept, nothing parsed, each line in its own
 * direction) or the host's own rendering in `content`. Bots and
 * integrations (tone="muted") go quiet. Loading shows skeleton lines, an
 * error one line with an optional Retry. Not a client module: with plain
 * data it renders in a server component.
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
        />
      ))}
    </ol>
  );
}
