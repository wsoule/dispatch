import { describe, expect, it, spyOn } from 'bun:test';

import type { DecisionItem } from '../src/decisionFeed.js';
import {
  DecisionReminders,
  REMIND_AFTER_MS,
} from '../src/decisionReminders.js';
import type { ServerEvent } from '../src/events.js';
import { EventBus } from '../src/events.js';

const SINCE = Date.parse('2026-10-26T12:00:00.000Z');

function item(id: string, patch: Partial<DecisionItem> = {}): DecisionItem {
  const [kind] = id.split(':') as [DecisionItem['kind']];
  return {
    id,
    kind,
    summary: `summary for ${id}`,
    since: new Date(SINCE).toISOString(),
    ageMs: 0,
    state: 'open',
    disposition: 'blocking',
    messageId: id.split(':')[1],
    ...patch,
  };
}

// Reminders over an in-memory feed and a settable clock; `sent` records
// every decision.reminder broadcast.
function harness(open: DecisionItem[]) {
  const events = new EventBus();
  const sent: ServerEvent[] = [];
  events.subscribe((e) => {
    if (e.type === 'decision.reminder') sent.push(e);
  });
  const clock = { now: SINCE };
  const reminders = new DecisionReminders({
    feed: { list: () => open },
    events,
    now: () => clock.now,
  });
  return { reminders, sent, clock };
}

describe('DecisionReminders', () => {
  it('reminds a scope request once, after it has waited REMIND_AFTER_MS', () => {
    const { reminders, sent, clock } = harness([item('scope-request:m-1')]);
    clock.now = SINCE + REMIND_AFTER_MS - 1;
    expect(reminders.sweep()).toEqual([]);
    clock.now = SINCE + REMIND_AFTER_MS;
    expect(reminders.sweep()).toEqual(['scope-request:m-1']);
    clock.now += REMIND_AFTER_MS;
    expect(reminders.sweep()).toEqual([]);
    expect(sent).toEqual([
      {
        type: 'decision.reminder',
        itemId: 'scope-request:m-1',
        messageId: 'm-1',
      },
    ]);
  });

  it('leaves other kinds and recorded items alone', () => {
    const { reminders, clock } = harness([
      item('question:m-2'),
      item('approval:m-3'),
      item('scope-request:m-4', { disposition: 'recorded' }),
    ]);
    clock.now = SINCE + 2 * REMIND_AFTER_MS;
    expect(reminders.sweep()).toEqual([]);
  });

  it('reminds again when an id leaves the feed and comes back', () => {
    const open = [item('scope-request:m-5')];
    const { reminders, clock } = harness(open);
    clock.now = SINCE + REMIND_AFTER_MS;
    expect(reminders.sweep()).toEqual(['scope-request:m-5']);
    const [held] = open.splice(0);
    expect(reminders.sweep()).toEqual([]);
    if (held !== undefined) open.push(held);
    expect(reminders.sweep()).toEqual(['scope-request:m-5']);
  });

  it('logs a feed read that throws instead of throwing out of the timer', () => {
    const events = new EventBus();
    const reminders = new DecisionReminders({
      feed: {
        list: () => {
          throw new Error('database is locked');
        },
      },
      events,
    });
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(reminders.sweep()).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});
