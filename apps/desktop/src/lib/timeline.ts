import type { TaskComment } from '@dispatch-foo/core/browser';
import type { Message } from '@dispatch/client';

import type { MessageScope } from './conversationScope';

/** One row of a home's flat timeline. */
export type TimelineEntry =
  | { kind: 'message'; key: string; at: string; message: Message }
  | { kind: 'comment'; key: string; at: string; comment: TaskComment }
  | {
      kind: 'fold';
      key: string;
      at: string;
      messages: Message[];
      /** Who was talking, in order of first appearance. */
      between: string[];
      first: string;
      last: string;
    };

/** Messages and comments in time order, each run of chatter folded into one entry. */
export function buildTimeline(
  messages: readonly Message[],
  comments: readonly TaskComment[],
  scope: (message: Message) => MessageScope
): TimelineEntry[] {
  const merged = [
    ...messages.map((message) => ({
      at: message.createdAt,
      key: message.id,
      message,
    })),
    ...comments.map((comment) => ({
      at: comment.created,
      key: comment.id,
      comment,
    })),
  ].sort((a, b) =>
    a.at === b.at ? a.key.localeCompare(b.key) : a.at.localeCompare(b.at)
  );

  const entries: TimelineEntry[] = [];
  for (const row of merged) {
    if ('comment' in row) {
      entries.push({ kind: 'comment', ...row });
      continue;
    }
    const { message } = row;
    if (scope(message) !== 'machine') {
      entries.push({ kind: 'message', key: row.key, at: row.at, message });
      continue;
    }
    const last = entries[entries.length - 1];
    if (last?.kind === 'fold') {
      last.messages.push(message);
      last.last = message.createdAt;
      if (!last.between.includes(message.from)) last.between.push(message.from);
      for (const to of message.to) {
        if (to.startsWith('run:') && !last.between.includes(to)) {
          last.between.push(to);
        }
      }
      continue;
    }
    entries.push({
      kind: 'fold',
      key: `fold:${message.id}`,
      at: row.at,
      messages: [message],
      between: [
        message.from,
        ...message.to.filter(
          (to) => to.startsWith('run:') && to !== message.from
        ),
      ],
      first: message.createdAt,
      last: message.createdAt,
    });
  }
  return entries;
}

/** A reply's one-line quote of its parent, or null when the parent is not in view. */
export function quoteOf(
  message: Message,
  byId: ReadonlyMap<string, Message>
): { from: string; at: string; text: string } | null {
  if (message.replyTo === null) return null;
  const parent = byId.get(message.replyTo);
  if (parent === undefined) return null;
  const flat = parent.body.replace(/\s+/g, ' ').trim();
  return {
    from: parent.from,
    at: parent.createdAt,
    text: flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`,
  };
}
