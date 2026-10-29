import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { problemText, sendProblem } from '../../lib/composer';
import type { Post } from '../../lib/posts';
import { UNDO_MS } from '../conversation/HomeComposer';
import { IconButton } from '@/ui/ai/icon-button';
import { NoticePill } from '@/ui/ai/notice-pill';
import { Pill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { SectionLabel } from '@/ui/chrome';
import { Input } from '@/ui/input';

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
  if (shown.length === 0 && fresh === 0) return null;
  return (
    <section
      aria-label="For you"
      data-testid="for-you"
      className="flex flex-col gap-1.5"
    >
      <h2 className="contents">
        <SectionLabel
          className="h-6"
          trailing={
            shown.length > 0 && (
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() => onClearAll(shown)}
                data-testid="for-you-clear-all"
              >
                Clear all
              </Button>
            )
          }
        >
          For you
        </SectionLabel>
      </h2>
      {shown.map((post) => (
        <ForYouPost
          key={post.key}
          post={post}
          label={label}
          onOpen={onOpen}
          onReply={onReply}
          onDismiss={onDismiss}
        />
      ))}
      {fresh > 0 && (
        <NoticePill onClick={() => setShown(posts)} className="self-center">
          {fresh} new
        </NoticePill>
      )}
    </section>
  );
}

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
    <IconButton
      label="Dismiss"
      data-testid="for-you-post-dismiss"
      onClick={() => onDismiss(post)}
    >
      <X />
    </IconButton>
  );
  if (!post.unread && receipt === null && held === null && !replying) {
    return (
      <div className="flex max-w-full min-w-0 items-center self-start">
        <Button
          variant="ghost"
          size="xs"
          data-testid="for-you-post-read"
          onClick={() => onOpen(post)}
          className="min-w-0 justify-start"
        >
          <span className="truncate">
            {byline} · {clock(post.latest.createdAt)}
          </span>
        </Button>
        {dismiss}
      </div>
    );
  }
  return (
    <article
      data-testid="for-you-post"
      className="bg-background border-border rounded-card flex min-w-0 flex-col gap-1.5 border-[0.5px] px-3 py-2 text-[13px]"
    >
      <div className="text-muted-foreground flex items-center gap-2 text-[12px]">
        <span className="text-foreground font-medium">{from}</span>
        <Pill>{subject}</Pill>
        {post.count > 1 && <span>{post.count} messages</span>}
        <span className="flex-1" />
        <span>{clock(post.latest.createdAt)}</span>
        {dismiss}
      </div>
      <p className="line-clamp-3 text-(--text-secondary)">{post.latest.body}</p>
      {receipt !== null ? (
        <p role="status" className="text-muted-foreground text-[12px]">
          {receipt}
        </p>
      ) : held !== null ? (
        <div role="status" className="flex items-center gap-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate">Sending to {subject}…</span>
          <Button
            size="xs"
            variant="outline"
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
          className="flex min-w-0 items-center gap-2"
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
          <Input
            ref={replyInputRef}
            aria-label={`${verb} ${subject}`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`${verb} ${subject}…`}
            className="min-w-0 flex-1"
          />
          {/* A short label, so a long address never squeezes the input; the
              full one stays in the accessible name and the tooltip. */}
          <Button
            size="xs"
            type="submit"
            disabled={body.trim() === ''}
            aria-label={`${asks ? 'Answer' : 'Send to'} ${subject}`}
            title={`${asks ? 'Answer' : 'Send to'} ${subject}`}
            className="shrink-0"
          >
            {asks ? 'Answer' : 'Send'}
          </Button>
        </form>
      ) : (
        <div className="flex gap-2">
          <Button size="xs" variant="outline" onClick={() => onOpen(post)}>
            Open
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setReplying(true)}>
            {asks ? 'Answer…' : 'Reply…'}
          </Button>
        </div>
      )}
      {error !== null && (
        <p
          role="alert"
          className="text-state-failed text-[12px] break-words whitespace-normal"
        >
          {error}
        </p>
      )}
    </article>
  );
}
