import type { Delivery, MailboxItem, Message } from '@dispatch/client';

import { type ScopeContext, scopeOf, subjectOf } from './conversationScope';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNREAD: ReadonlySet<string> = new Set(['held', 'notified', 'pushed']);

/** One "For you" post: everything about one subject, newest message on top. */
export interface Post {
  key: string;
  subject: string;
  kind: 'for-you' | 'followed';
  latest: Message;
  count: number;
  unread: boolean;
  /** My unread deliveries behind it, marked read when it is opened. */
  deliveries: Delivery[];
}

/**
 * The Overseer's "For you" posts, built from my mailbox and never stored: a DM,
 * mention, reply, handoff or breaker trip is one post per subject while unread;
 * a followed room is at most one combined post per room per hour. Posts older
 * than a day drop off; a solo user sees none (the caller decides that).
 */
export function buildPosts(
  mailbox: readonly MailboxItem[],
  ctx: ScopeContext & { now: number }
): Post[] {
  const posts = new Map<string, Post>();
  for (const { delivery, message } of mailbox) {
    if (ctx.now - Date.parse(message.createdAt) > DAY_MS) continue;
    const scope = scopeOf(message, ctx);
    if (scope !== 'for-you' && scope !== 'followed') continue;
    const subject =
      scope === 'followed'
        ? (message.to.find((a) => ctx.followed.has(a)) ??
          subjectOf(message, ctx.me))
        : subjectOf(message, ctx.me);
    const key =
      scope === 'followed'
        ? `${subject}@${message.createdAt.slice(0, 13)}`
        : subject;
    const unread = delivery.recipient === ctx.me && UNREAD.has(delivery.state);
    const post = posts.get(key);
    if (post === undefined) {
      posts.set(key, {
        key,
        subject,
        kind: scope,
        latest: message,
        count: 1,
        unread,
        deliveries: unread ? [delivery] : [],
      });
      continue;
    }
    post.count++;
    if (message.createdAt > post.latest.createdAt) post.latest = message;
    if (unread) {
      post.unread = true;
      post.deliveries.push(delivery);
    }
  }
  return [...posts.values()].sort((a, b) =>
    a.latest.createdAt.localeCompare(b.latest.createdAt)
  );
}
