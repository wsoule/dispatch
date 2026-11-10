import type { Message } from '@dispatch-foo/protocol';
import { describe, expect, test } from 'bun:test';

import { decisionTitle, parseMobileSettings } from '../../src/mobile/host.js';
import type {
  MobilePushPayload,
  RunSnapshot,
} from '../../src/mobile/notifier.js';
import {
  diffSnapshots,
  MobileNotifier,
  payloadFor,
  PushSubscriptions,
} from '../../src/mobile/notifier.js';
import type { PushOutcome } from '../../src/mobile/webPush.js';
import { generateVapidKeys } from '../../src/mobile/webPush.js';

// Test vectors as spaced hex bytes, turned into the base64url the code reads.
const b64u = (bytes: string): string =>
  Buffer.from(bytes.replaceAll(' ', ''), 'hex').toString('base64url');

const KEYS = {
  p256dh:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: b64u('05 30 59 32 a1 c7 ea be 13 b6 ce c9 fd a4 88 82'),
};
const vapid = generateVapidKeys();

function run(id: string, state: string, reviewed = false): RunSnapshot {
  return { id, title: `task for ${id}`, state, reviewed };
}

// A notifier on a hand-cranked clock, recording what it would have pushed.
function harness(outcome: PushOutcome = { kind: 'sent' }) {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sent: Array<{ endpoint: string; payload: MobilePushPayload }> = [];
  const subscriptions = new PushSubscriptions(null);
  subscriptions.put('d-phone', {
    endpoint: 'https://push.example/1',
    keys: KEYS,
  });
  const notifier = new MobileNotifier({
    subscriptions,
    vapid: () => vapid,
    subject: 'https://dispatch.foo',
    deviceExists: () => true,
    windowMs: 10_000,
    now: () => now,
    setTimer: (fn, ms) => timers.push({ at: now + ms, fn }),
    send: (sub, message) => {
      sent.push({
        endpoint: sub.endpoint,
        payload: message.payload as MobilePushPayload,
      });
      return Promise.resolve(outcome);
    },
    log: () => {},
  });
  return {
    notifier,
    subscriptions,
    sent,
    advance(ms: number) {
      now += ms;
      for (const t of timers.splice(0))
        if (t.at <= now) t.fn();
        else timers.push(t);
    },
  };
}

describe('diffSnapshots', () => {
  const empty = {
    decisions: new Set<string>(),
    runs: new Map<string, string>(),
  };

  test('a new decision is news; one already open is not', () => {
    expect(
      diffSnapshots(
        { ...empty, decisions: new Set(['m-old']) },
        [
          { id: 'm-old', title: 'old' },
          { id: 'm-new', title: 'Question · fix login' },
        ],
        []
      )
    ).toEqual([
      { kind: 'decision', id: 'm-new', title: 'Question · fix login' },
    ]);
  });

  test('a run failing is news once', () => {
    const before = { ...empty, runs: new Map([['r-1', 'running']]) };
    expect(diffSnapshots(before, [], [run('r-1', 'failed')])).toEqual([
      { kind: 'run-failed', id: 'r-1', title: 'task for r-1' },
    ]);
    const failed = { ...empty, runs: new Map([['r-1', 'failed']]) };
    expect(
      diffSnapshots(failed, [], [run('r-1', 'interrupted-dirty')])
    ).toEqual([]);
  });

  test('a run seen running that finishes unreviewed is ready for review', () => {
    const before = { ...empty, runs: new Map([['r-1', 'running']]) };
    expect(diffSnapshots(before, [], [run('r-1', 'finished')])).toEqual([
      { kind: 'run-review', id: 'r-1', title: 'task for r-1' },
    ]);
    expect(diffSnapshots(before, [], [run('r-1', 'finished', true)])).toEqual(
      []
    );
  });

  test('a run that first appears finished, or was cancelled, is not news', () => {
    expect(diffSnapshots(empty, [], [run('r-1', 'finished')])).toEqual([]);
    const before = { ...empty, runs: new Map([['r-1', 'running']]) };
    expect(diffSnapshots(before, [], [run('r-1', 'cancelled')])).toEqual([]);
  });
});

describe('payloadFor', () => {
  test('one event names itself; several become a count', () => {
    expect(
      payloadFor([{ kind: 'decision', id: 'm-1', title: 'Question · x' }])
    ).toEqual({
      kind: 'decision',
      id: 'm-1',
      title: 'Question · x',
      body: 'Waiting on you',
    });
    expect(
      payloadFor([
        { kind: 'decision', id: 'm-1', title: 'a' },
        { kind: 'run-failed', id: 'r-1', title: 'b' },
      ])
    ).toEqual({
      kind: 'summary',
      id: null,
      title: '2 updates in Dispatch',
      body: '1 waiting on you',
    });
  });
});

describe('MobileNotifier', () => {
  test('the first snapshot after boot only seeds the baseline', async () => {
    const h = harness();
    h.notifier.observe([{ id: 'm-1', title: 'waiting since before' }], []);
    await h.notifier.settled();
    expect(h.sent).toEqual([]);
  });

  test('pushes a new decision at once', async () => {
    const h = harness();
    h.notifier.observe([], []);
    h.notifier.observe([{ id: 'm-1', title: 'Question · login' }], []);
    await h.notifier.settled();
    expect(h.sent).toEqual([
      {
        endpoint: 'https://push.example/1',
        payload: {
          kind: 'decision',
          id: 'm-1',
          title: 'Question · login',
          body: 'Waiting on you',
        },
      },
    ]);
  });

  test('coalesces a burst into one follow-up after the window', async () => {
    const h = harness();
    h.notifier.observe([], []);
    h.notifier.observe([{ id: 'm-1', title: 'a' }], []);
    await h.notifier.settled();
    h.advance(1_000);
    h.notifier.observe(
      [
        { id: 'm-1', title: 'a' },
        { id: 'm-2', title: 'b' },
      ],
      []
    );
    h.notifier.observe(
      [
        { id: 'm-1', title: 'a' },
        { id: 'm-2', title: 'b' },
        { id: 'm-3', title: 'c' },
      ],
      []
    );
    await h.notifier.settled();
    expect(h.sent).toHaveLength(1);
    h.advance(9_000);
    await h.notifier.settled();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].payload).toEqual({
      kind: 'summary',
      id: null,
      title: '2 updates in Dispatch',
      body: '2 waiting on you',
    });
  });

  test('forgets a subscription the push service says is gone', async () => {
    const h = harness({ kind: 'gone' });
    h.notifier.observe([], []);
    h.notifier.observe([{ id: 'm-1', title: 'a' }], []);
    await h.notifier.settled();
    expect(h.subscriptions.has('d-phone')).toBe(false);
  });
});

describe('PushSubscriptions', () => {
  test('a device keeps one subscription; a renewed one replaces it', () => {
    const subs = new PushSubscriptions(null);
    subs.put('d-1', { endpoint: 'https://push.example/a', keys: KEYS });
    subs.put('d-1', { endpoint: 'https://push.example/b', keys: KEYS });
    expect(subs.all().map((s) => s.endpoint)).toEqual([
      'https://push.example/b',
    ]);
    subs.removeDevice('d-1');
    expect(subs.all()).toEqual([]);
  });
});

describe('decisionTitle', () => {
  const base: Message = {
    id: 'm-1',
    thread: 'm-1',
    replyTo: null,
    from: 'run:r-1',
    to: ['human:wyat'],
    kind: 'question',
    body: 'Should I delete the production database? password=hunter2',
    refs: [],
    urgent: false,
    blocking: true,
    wake: 'none',
    createdAt: '2026-10-20T00:00:00Z',
  };
  const titles = (id: string) => (id === 'r-1' ? 'Fix login' : undefined);

  test("names the kind and the run's task, never the body", () => {
    const title = decisionTitle(base, titles);
    expect(title).toBe('Question · Fix login');
    expect(title).not.toContain('hunter2');
  });

  test('names a gate by its type and the run it parks', () => {
    expect(
      decisionTitle(
        {
          ...base,
          from: 'system',
          data: {
            type: 'tool-approval',
            requestId: 'q',
            runId: 'r-1',
            tool: 'Bash',
            input: { command: 'rm -rf /' },
            floor: false,
          },
        },
        titles
      )
    ).toBe('Approve a tool call · Fix login');
  });
});

describe('parseMobileSettings', () => {
  test('accepts an https public URL and keeps only its origin', () => {
    expect(
      parseMobileSettings({
        port: 4800,
        publicUrl: 'https://laptop.tailnet.ts.net/some/path',
      })
    ).toEqual({
      ok: true,
      settings: { port: 4800, publicUrl: 'https://laptop.tailnet.ts.net' },
    });
  });

  test('refuses a plain-http public URL off this machine', () => {
    expect(
      parseMobileSettings({ port: 4800, publicUrl: 'http://laptop.local' }).ok
    ).toBe(false);
  });

  test('refuses a port that is not a port', () => {
    expect(parseMobileSettings({ port: 70000, publicUrl: null }).ok).toBe(
      false
    );
    expect(parseMobileSettings({ port: '4800', publicUrl: null }).ok).toBe(
      false
    );
  });
});
