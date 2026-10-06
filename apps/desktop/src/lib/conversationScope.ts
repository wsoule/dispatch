import type { Message } from '@dispatch/client';

import { gateOf, isSystemMarker } from './gates';

/**
 * Where a message goes in Two views:
 * - `gate`: Needs you, nowhere else;
 * - `machine`: folded into "Agent chatter" in its home;
 * - `for-you`: a post in Overseer plus its home;
 * - `followed`: a followed room's combined hourly post plus its home;
 * - `home`: its home only.
 */
export type MessageScope = 'gate' | 'machine' | 'for-you' | 'followed' | 'home';

export interface ScopeContext {
  me: string;
  myTaskIds: ReadonlySet<string>;
  /** Room addresses (`channel:name`) you follow. */
  followed: ReadonlySet<string>;
  muted: ReadonlySet<string>;
  /** The author of a message by id, for "a reply to you"; null when unknown. */
  authorOf: (messageId: string) => string | null;
}

const isRunOrAgent = (address: string) =>
  address.startsWith('run:') || address.startsWith('agent:');

function handleOf(me: string): string {
  const colon = me.indexOf(':');
  return colon === -1 ? me : me.slice(colon + 1);
}

function mentions(body: string, me: string): boolean {
  const handle = handleOf(me).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)@${handle}(?![\\w.-])`).test(body);
}

function toMyTask(message: Message, ctx: ScopeContext): boolean {
  return message.to.some(
    (a) => a.startsWith('task:') && ctx.myTaskIds.has(a.slice('task:'.length))
  );
}

/** Routes one message; table-tested against every root shape the bus produces. */
export function scopeOf(message: Message, ctx: ScopeContext): MessageScope {
  if (gateOf(message) !== null) return 'gate';
  if (message.from === ctx.me || ctx.muted.has(message.from)) return 'home';
  if (isSystemMarker(message, 'x-breaker')) return 'for-you';
  const outside = message.from.startsWith('a2a:');
  const toMe = message.to.includes(ctx.me);
  if (toMe) return 'for-you';
  if (mentions(message.body, ctx.me)) return 'for-you';
  if (message.replyTo !== null && ctx.authorOf(message.replyTo) === ctx.me) {
    return 'for-you';
  }
  if (message.kind === 'handoff' && toMyTask(message, ctx)) return 'for-you';
  // Outside traffic is never folded, so a human can audit it.
  if (!outside && isRunOrAgent(message.from)) return 'machine';
  if (message.to.some((a) => ctx.followed.has(a))) return 'followed';
  return 'home';
}

/** The home a message belongs to: a task, then a room, then the other party. */
export function subjectOf(message: Message, me: string): string {
  const task =
    message.to.find((a) => a.startsWith('task:')) ??
    message.refs.filter((r) => r.type === 'task').map((r) => `task:${r.id}`)[0];
  if (task !== undefined) return task;
  const room = message.to.find((a) => a.startsWith('channel:'));
  if (room !== undefined) return room;
  if (message.from !== me) return message.from;
  return message.to.find((a) => a !== me) ?? message.from;
}
