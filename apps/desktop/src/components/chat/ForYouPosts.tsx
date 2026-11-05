import {
  Button,
  Chip,
  ChipButton,
  cx,
  Panel,
  SectionHeader,
  TextField,
} from '@dispatch/ui';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { problemText, sendProblem } from '../../lib/composer';
import type { Post } from '../../lib/posts';
import { UNDO_MS } from '../conversation/HomeComposer';
import styles from './posts.module.css';

const dismissIcon = <X size={14} strokeWidth={1.8} aria-hidden />;

// A message's time of day ("19:17"), or nothing for an unparseable stamp.
function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
}

// A run subject reads as its address label (the run's task title), not its id.
function subjectLabel(
  subject: string,
  label: (address: string) => string
): string {
  if (subject.startsWith('run:')) return label(subject);
  if (subject.startsWith('task:')) return subject.slice('task:'.length);
  if (subject.startsWith('channel:'))
    return `# ${subject.slice('channel:'.length)}`;
  return subject.replace(/^(human|a2a):/, '');
}

export interface ForYouPostsProps {
  posts: readonly Post[];
  label: (address: string) => string;
  /** Opens the post's home in a peek or page; never switches the view on its own. */
  onOpen: (post: Post) => void;
  onReply: (post: Post, body: string) => Promise<void>;
  /** Hides a post until a newer message lands on its subject. */
  onDismiss: (post: Post) => void;
  /** Hides every post showing. */
  onClearAll: (posts: readonly Post[]) => void;
  /** During an agent turn new posts wait behind a pill, so the stream holds still. */
  holding: boolean;
}

/** "For you": DMs, mentions, replies and handoffs, built from the mailbox, never stored. */
export function ForYouPosts({
  posts,
  label,
  onOpen,
  onReply,
  onDismiss,
  onClearAll,
  holding,
}: ForYouPostsProps) {
  const [shown, setShown] = useState<readonly Post[]>(posts);
  useEffect(() => {
    if (!holding) setShown(posts);
  }, [posts, holding]);
  const fresh = posts.filter((p) => !shown.some((s) => s.key === p.key)).length;
  // Holding keeps new posts out, not the person's own dismissals: a post
  // dismissed (or cleared) during an agent turn leaves the stream at once.
  const dismiss = (post: Post) => {
    onDismiss(post);
    setShown((current) => current.filter((s) => s.key !== post.key));
  };
  const clearAll = () => {
    onClearAll(shown);
    setShown([]);
  };
  if (shown.length === 0 && fresh === 0) return null;
  return (
    <section
      aria-label="For you"
      data-testid="for-you"
      className={styles.stack}
    >
      <SectionHeader
        as="h2"
        name="For you"
        actions={
          shown.length > 0 && (
            <Button
              variant="quiet"
              size="sm"
              onClick={clearAll}
              data-testid="for-you-clear-all"
            >
              Clear all
            </Button>
          )
        }
      />
      {shown.map((post) => (
        <ForYouPost
          key={post.key}
          post={post}
          label={label}
          onOpen={onOpen}
          onReply={onReply}
          onDismiss={dismiss}
        />
      ))}
      {fresh > 0 && (
        <div className={styles.fresh}>
          <ChipButton tone="accent" onClick={() => setShown(posts)}>
            {fresh} new
          </ChipButton>
        </div>
      )}
    </section>
  );
}

// One post: a card while unread (or while a reply is held, sent or being
// written), else a single quiet line that opens it.
function ForYouPost({
  post,
  label,
  onOpen,
  onReply,
  onDismiss,
}: {
  post: Post;
  label: (address: string) => string;
  onOpen: (post: Post) => void;
  onReply: (post: Post, body: string) => Promise<void>;
  onDismiss: (post: Post) => void;
}) {
  const subject = subjectLabel(post.subject, label);
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState('');
  const [held, setHeld] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const replyRef = useRef(onReply);
  // The reply field takes focus when it opens.
  const replyInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (replying) replyInputRef.current?.focus();
  }, [replying]);
  useEffect(() => {
    replyRef.current = onReply;
  });
  useEffect(() => {
    if (held === null) return;
    const timer = setTimeout(() => {
      setHeld(null);
      replyRef.current(post, held).then(
        () =>
          setReceipt(
            `You replied on ${subject} · ${clock(new Date().toISOString())}`
          ),
        (err: unknown) => {
          setBody(held);
          setReplying(true);
          setError(problemText(sendProblem(err)));
        }
      );
    }, UNDO_MS);
    return () => clearTimeout(timer);
  }, [held, post, subject]);

  const from = label(post.latest.from);
  // A question's reply answers it (see App's replyToPost), so the form says so.
  const asks = post.latest.kind === 'question';
  const verb = asks ? 'Answer' : 'Reply on';
  // A run writing about itself reads once, not "Title on Title".
  const byline = from === subject ? subject : `${from} on ${subject}`;
  const dismiss = (
    <Button
      variant="quiet"
      size="sm"
      icon={dismissIcon}
      aria-label="Dismiss"
      data-testid="for-you-post-dismiss"
      onClick={() => onDismiss(post)}
      className={styles.rowAction}
    />
  );
  if (!post.unread && receipt === null && held === null && !replying) {
    return (
      <div className={styles.readRow}>
        <Button
          variant="quiet"
          size="sm"
          data-testid="for-you-post-read"
          onClick={() => onOpen(post)}
          className={styles.readButton}
        >
          <span className={styles.truncate}>
            {byline} · {clock(post.latest.createdAt)}
          </span>
        </Button>
        {dismiss}
      </div>
    );
  }
  return (
    // An <article> per card, as before the Panel: each post is a
    // self-contained item in the For you feed.
    <article data-testid="for-you-post" className={styles.post}>
      <Panel as="div">
        <div className={styles.meta}>
          <span className={styles.from} title={from}>
            {from}
          </span>
          {/* A run writing about itself names itself once, as the byline does. */}
          {from !== subject && (
            <span className={styles.subject}>
              <Chip title={subject}>
                <span className={styles.subjectText}>{subject}</span>
              </Chip>
            </span>
          )}
          {post.count > 1 && (
            <span className={styles.count}>{post.count} messages</span>
          )}
          <span className={styles.time}>{clock(post.latest.createdAt)}</span>
          {dismiss}
        </div>
        <p className={styles.body}>{post.latest.body}</p>
        {receipt !== null ? (
          <p role="status" className={styles.status}>
            {receipt}
          </p>
        ) : held !== null ? (
          <div role="status" className={styles.hold}>
            <span className={styles.rowText}>Sending to {subject}…</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setBody(held);
                setHeld(null);
                setReplying(true);
              }}
            >
              Undo
            </Button>
          </div>
        ) : replying ? (
          <form
            className={styles.replyForm}
            onSubmit={(e) => {
              e.preventDefault();
              const text = body.trim();
              if (text === '') return;
              setError(null);
              setReplying(false);
              setBody('');
              setHeld(text);
            }}
          >
            <TextField
              ref={replyInputRef}
              size="sm"
              aria-label={`${verb} ${subject}`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`${verb} ${subject}…`}
              className={styles.replyInput}
            />
            {/* A short label, so a long address never squeezes the input; the
              full one stays in the accessible name and the tooltip. */}
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={body.trim() === ''}
              aria-label={`${asks ? 'Answer' : 'Send to'} ${subject}`}
              title={`${asks ? 'Answer' : 'Send to'} ${subject}`}
              className={styles.rowAction}
            >
              {asks ? 'Answer' : 'Send'}
            </Button>
          </form>
        ) : (
          <div className={styles.actions}>
            <Button size="sm" variant="secondary" onClick={() => onOpen(post)}>
              Open
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setReplying(true)}>
              {asks ? 'Answer…' : 'Reply…'}
            </Button>
          </div>
        )}
        {error !== null && (
          <p
            role="alert"
            className={cx('toneText', styles.error)}
            data-tone="danger"
          >
            {error}
          </p>
        )}
      </Panel>
    </article>
  );
}
