import type { NotificationKind } from '@dispatch-foo/core';

import type { DecisionItem } from './decisionFeed.js';
import type { EventBus } from './events.js';

/** How long a blocking item waits before its one reminder. Matches the old
 *  scope-gate expiry, so a request that used to be silently denied at this
 *  point now pings a human instead. */
export const REMIND_AFTER_MS = 30 * 60_000;

const SWEEP_MS = 30_000;

// The kinds that park a run until a human answers and never expire, so being
// missed costs a paused run. Others either time out on their own (a plain
// question returns to the agent after 30 minutes) or wait for no one.
const REMINDED_KINDS: ReadonlySet<NotificationKind> = new Set([
  'scope-request',
]);

/** The slice of DecisionFeed this reads: the open items, classified. */
interface ReminderFeed {
  list(): DecisionItem[];
}

export interface DecisionRemindersContext {
  feed: ReminderFeed;
  events: Pick<EventBus, 'broadcast'>;
  /** Test seams. Default to REMIND_AFTER_MS and `Date.now`. */
  remindAfterMs?: number;
  now?: () => number;
}

/**
 * Broadcasts `decision.reminder` once for each blocking scope request that has
 * waited REMIND_AFTER_MS, so the desktop app and the webhook can ping a human
 * again. Scope requests never expire (the run stays paused on the gate), so
 * without this a request missed on its first notification sits unseen.
 *
 * The reminded set lives in memory: a daemon restart reminds each overdue
 * item once more, which is better than missing one. An id is forgotten once
 * its item leaves the feed, so the set stays bounded by what is open.
 */
export class DecisionReminders {
  private readonly reminded = new Set<string>();
  private readonly remindAfterMs: number;
  private readonly now: () => number;

  constructor(private readonly ctx: DecisionRemindersContext) {
    this.remindAfterMs = ctx.remindAfterMs ?? REMIND_AFTER_MS;
    this.now = ctx.now ?? Date.now;
  }

  /** Starts the periodic sweep; returns its stop. */
  start(sweepMs = SWEEP_MS): () => void {
    const timer = setInterval(() => this.sweep(), sweepMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** One pass; returns the ids it reminded. Never throws: a feed read that
   *  fails is logged and the next pass tries again. */
  sweep(): string[] {
    let open: DecisionItem[];
    try {
      open = this.ctx.feed.list();
    } catch (err) {
      console.error('dispatchd: decision reminder sweep failed', err);
      return [];
    }
    const openIds = new Set(open.map((item) => item.id));
    for (const id of this.reminded)
      if (!openIds.has(id)) this.reminded.delete(id);
    const nowMs = this.now();
    const due = open.filter(
      (item) =>
        item.disposition === 'blocking' &&
        REMINDED_KINDS.has(item.kind) &&
        !this.reminded.has(item.id) &&
        nowMs - Date.parse(item.since) >= this.remindAfterMs
    );
    for (const item of due) {
      this.reminded.add(item.id);
      this.ctx.events.broadcast({
        type: 'decision.reminder',
        itemId: item.id,
        ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
      });
    }
    return due.map((item) => item.id);
  }
}
