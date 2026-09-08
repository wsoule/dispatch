import type { NotificationsConfig } from '@dispatch/core';
import { DEFAULT_NOTIFICATIONS } from '@dispatch/core';
import { beforeEach, describe, expect, it } from 'bun:test';

import type { DecisionItem } from '../src/decisionFeed.js';
import { EventBus } from '../src/events.js';
import type { WebhookPayload } from '../src/webhookDelivery.js';
import { WebhookDelivery } from '../src/webhookDelivery.js';

const URL_A = 'https://hooks.example.com/a';

function item(id: string, patch: Partial<DecisionItem> = {}): DecisionItem {
  const [kind] = id.split(':') as [DecisionItem['kind']];
  return {
    id,
    kind,
    summary: `summary for ${id}`,
    since: '2026-09-07T12:00:00.000Z',
    ageMs: 1000,
    state: 'open',
    disposition: 'blocking',
    ...patch,
  };
}

// The deliverer over an in-memory feed and a recording fetch: a test pushes
// items into `open`, fires `decisions.changed`, and reads what was posted.
interface Harness {
  delivery: WebhookDelivery;
  events: EventBus;
  open: DecisionItem[];
  config: NotificationsConfig;
  configError: Error | null;
  posts: { url: string; init: RequestInit; payload: WebhookPayload }[];
  logs: string[];
  responder: () => Promise<Response>;
  // One delivery pass, awaited — what the decisions.changed subscription
  // fires in production (covered by its own test below).
  change(): Promise<void>;
}

function harness(config?: Partial<NotificationsConfig>): Harness {
  const events = new EventBus();
  const open: DecisionItem[] = [];
  const posts: Harness['posts'] = [];
  const logs: string[] = [];
  const h: Harness = {
    events,
    open,
    posts,
    logs,
    config: {
      kinds: { ...DEFAULT_NOTIFICATIONS.kinds },
      webhook: URL_A,
      ...config,
    },
    configError: null,
    responder: () => Promise.resolve(new Response('ok', { status: 200 })),
    delivery: undefined as unknown as WebhookDelivery,
    change: () => h.delivery.deliverNew(),
  };
  h.delivery = new WebhookDelivery({
    rootDir: '/repo',
    feed: { list: () => open },
    events,
    readConfig: () => {
      if (h.configError !== null) throw h.configError;
      return h.config;
    },
    // The deliverer only ever passes a string URL and a string body; the
    // narrow signature here is what the cast below vouches for.
    fetch: ((url: string, init: RequestInit & { body: string }) => {
      posts.push({
        url,
        init,
        payload: JSON.parse(init.body) as WebhookPayload,
      });
      return h.responder();
    }) as unknown as typeof globalThis.fetch,
    log: (message) => logs.push(message),
    timeoutMs: 1000,
  });
  return h;
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('WebhookDelivery', () => {
  it('posts a newly open blocking item once, as JSON with the item intact', async () => {
    h.open.push(item('approval:req-1'));
    h.delivery.start();
    // Open at start: already delivered by whoever ran before this daemon.
    await h.change();
    expect(h.posts).toHaveLength(0);

    h.open.push(item('question:q-1', { runId: 'r-1', taskId: 't-1' }));
    await h.change();
    expect(h.posts).toHaveLength(1);
    const [post] = h.posts;
    expect(post.url).toBe(URL_A);
    expect(post.init.method).toBe('POST');
    expect((post.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json'
    );
    expect(post.payload.event).toBe('decision.opened');
    expect(post.payload.project).toEqual({ rootDir: '/repo' });
    expect(post.payload.item).toEqual(
      item('question:q-1', { runId: 'r-1', taskId: 't-1' })
    );
    expect(Number.isNaN(Date.parse(post.payload.sentAt))).toBe(false);

    // The same feed change again — nothing new, nothing sent.
    await h.change();
    await h.change();
    expect(h.posts).toHaveLength(1);
  });

  it('does not post while no webhook is configured, and does not dump the backlog once one is', async () => {
    h.config.webhook = undefined;
    h.delivery.start();
    h.open.push(item('question:q-1'));
    await h.change();
    expect(h.posts).toHaveLength(0);

    h.config.webhook = URL_A;
    await h.change();
    expect(h.posts).toHaveLength(0);

    h.open.push(item('question:q-2'));
    await h.change();
    expect(h.posts.map((p) => p.payload.item.id)).toEqual(['question:q-2']);
  });

  it('honours the per-kind toggles without dumping a backlog when a kind is switched on', async () => {
    h.config.kinds['run-stalled'] = false;
    h.delivery.start();
    h.open.push(item('run-stalled:r-1'), item('question:q-1'));
    await h.change();
    expect(h.posts.map((p) => p.payload.item.id)).toEqual(['question:q-1']);

    h.config.kinds['run-stalled'] = true;
    await h.change();
    expect(h.posts).toHaveLength(1);

    h.open.push(item('run-stalled:r-2'));
    await h.change();
    expect(h.posts.map((p) => p.payload.item.id)).toEqual([
      'question:q-1',
      'run-stalled:r-2',
    ]);
  });

  it('skips recorded items — only blocking ones reach beyond the app', async () => {
    h.delivery.start();
    h.open.push(item('question:q-1', { disposition: 'recorded' }));
    await h.change();
    expect(h.posts).toHaveLength(0);
  });

  it('posts again when an item resolves and the same id reopens', async () => {
    h.delivery.start();
    h.open.push(item('fix-loop-capped:t-1'));
    await h.change();
    expect(h.posts).toHaveLength(1);

    h.open.length = 0;
    await h.change();
    h.open.push(item('fix-loop-capped:t-1'));
    await h.change();
    expect(h.posts).toHaveLength(2);
  });

  it('re-reads the config on every pass, so a URL edit applies live', async () => {
    h.delivery.start();
    h.open.push(item('question:q-1'));
    await h.change();
    h.config.webhook = 'https://hooks.example.com/b';
    h.open.push(item('question:q-2'));
    await h.change();
    expect(h.posts.map((p) => p.url)).toEqual([
      URL_A,
      'https://hooks.example.com/b',
    ]);
  });

  it('logs a failed POST and does not retry it on the next change', async () => {
    h.responder = () => Promise.resolve(new Response('nope', { status: 500 }));
    h.delivery.start();
    h.open.push(item('question:q-1'));
    await h.change();
    expect(h.logs).toEqual([
      `dispatchd: webhook delivery of question:q-1 to ${URL_A} failed: HTTP 500`,
    ]);

    h.responder = () => Promise.reject(new Error('ECONNREFUSED'));
    h.open.push(item('question:q-2'));
    await h.change();
    expect(h.logs[1]).toBe(
      `dispatchd: webhook delivery of question:q-2 to ${URL_A} failed: ECONNREFUSED`
    );
    await h.change();
    expect(h.posts).toHaveLength(2);
  });

  it('logs a broken config once, then delivers what is still open once it parses', async () => {
    h.delivery.start();
    h.configError = new Error('invalid .dispatch/config.yml: boom');
    h.open.push(item('question:q-1'));
    await h.change();
    h.open.push(item('question:q-2'));
    await h.change();
    expect(h.posts).toHaveLength(0);
    expect(h.logs).toEqual([
      'dispatchd: webhook delivery skipped, could not read notifications config: invalid .dispatch/config.yml: boom',
    ]);

    // A pass that could not read config decided nothing and so marked nothing
    // seen: fixing the typo delivers everything still waiting, rather than
    // silently dropping the two that opened during the broken window.
    h.configError = null;
    h.open.push(item('question:q-3'));
    await h.change();
    expect(h.posts.map((p) => p.payload.item.id)).toEqual([
      'question:q-1',
      'question:q-2',
      'question:q-3',
    ]);
  });

  it('does not deliver an item that resolved while the config was broken', async () => {
    h.delivery.start();
    h.configError = new Error('invalid .dispatch/config.yml: boom');
    h.open.push(item('question:q-1'));
    await h.change();

    // Answered while nobody could read the config: it is gone from the feed,
    // so a recovered pass has nothing to say about it. Retrying an unread pass
    // must not turn into delivering stale items.
    h.open.length = 0;
    h.configError = null;
    h.open.push(item('question:q-2'));
    await h.change();
    expect(h.posts.map((p) => p.payload.item.id)).toEqual(['question:q-2']);
  });

  it('delivers on decisions.changed', async () => {
    h.delivery.start();
    h.open.push(item('question:q-1'));
    h.events.broadcast({ type: 'decisions.changed' });
    // The subscriber does not await its pass; give the fake fetch a few
    // ticks to settle rather than reaching into the deliverer for a promise.
    for (let i = 0; i < 10 && h.posts.length === 0; i++) await Bun.sleep(0);
    expect(h.posts.map((p) => p.payload.item.id)).toEqual(['question:q-1']);
  });

  it('ignores every event but decisions.changed', async () => {
    h.delivery.start();
    h.open.push(item('question:q-1'));
    h.events.broadcast({ type: 'task.changed' });
    await Promise.resolve();
    expect(h.posts).toHaveLength(0);
  });

  it('stops delivering once unsubscribed', async () => {
    const stop = h.delivery.start();
    stop();
    h.open.push(item('question:q-1'));
    h.events.broadcast({ type: 'decisions.changed' });
    await Promise.resolve();
    expect(h.posts).toHaveLength(0);
  });
});
