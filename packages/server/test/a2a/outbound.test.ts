import { writePeerCredential } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { addPeer, removePeer, setPeerEnabled } from '../../src/a2a/peers.js';
import { HUMAN, useTempProject, waitFor } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';
import { FixturePeer } from './fixturePeer.js';

const project = useTempProject();
const OPERATOR = { tier: 'operator' as const, ref: 'human:wyat' };
const PUBLIC = '93.184.216.34';
let f: Awaited<ReturnType<typeof bridgeFixture>>;
let peer: FixturePeer;

beforeEach(async () => {
  f = await bridgeFixture(project.root(), {}, { outbound: true });
  peer = new FixturePeer().start();
  await addPeer(
    f.peerDeps(),
    { alias: 'fixture', cardUrl: peer.cardUrl(), token: 'peer-token' },
    OPERATOR
  );
});
afterEach(async () => {
  f.close();
  await peer.stop();
});

const engine = () => f.messaging.engine;
const ask = async (body = 'Which colour?', to = ['a2a:fixture']) =>
  (
    await engine().send(
      { to, kind: 'question', blocking: true, body, choices: ['blue', 'red'] },
      HUMAN
    )
  ).message;
const row = (id: string) => f.store.getOutbound(id, 'fixture');
const notices = () =>
  engine()
    .inbox('human:wyat')
    .filter(({ message }) => message.kind === 'notice')
    .map(({ message }) => message.body);
const fromPeer = (thread: string, alias = 'fixture') =>
  engine()
    .thread(thread)
    .messages.filter((m) => m.from === `a2a:${alias}`);

describe('relaying and tracking', () => {
  it('relays a question with to reduced to the peer, then records the peer’s answer', async () => {
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'open');
    expect(peer.opened[0]).toMatchObject({
      clientMessageId: q.id,
      kind: 'ask',
      body: 'Which colour?',
      to: ['a2a:fixture'],
    });
    expect(f.messaging.store.deliveries({ messageId: q.id })[0].state).toBe(
      'pushed'
    );
    peer.answer(peer.latest(), 'Blue');
    await waitFor(() => engine().answerOf(q.id) !== null);
    expect(engine().answerOf(q.id)).toMatchObject({
      from: 'a2a:fixture',
      kind: 'answer',
      body: 'Blue',
      choice: 'blue',
    });
    await waitFor(() => row(q.id)?.state === 'done');
  });

  it('carries the peer’s own question back, and the answer continues the peer’s task', async () => {
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'open');
    peer.ask(peer.latest(), 'Which region?', ['us', 'eu']);
    await waitFor(() => fromPeer(q.thread).some((m) => m.kind === 'question'));
    const theirs = fromPeer(q.thread).find((m) => m.kind === 'question')!;
    expect(theirs).toMatchObject({
      blocking: true,
      replyTo: q.id,
      to: ['human:wyat'],
      choices: ['us', 'eu'],
    });
    const { message: mine } = await engine().reply(
      theirs.id,
      { body: '', choice: 'eu' },
      HUMAN
    );
    await waitFor(() => peer.continued.length === 1);
    expect(peer.continued[0]).toMatchObject({
      taskId: peer.latest(),
      body: 'eu',
      choice: 'eu',
    });
    await waitFor(() => row(mine.id)?.state === 'done');
    expect(row(q.id)?.state).toBe('open');
    expect(f.outbound.trackerCount('fixture')).toBe(1);
  });

  it('records a peer’s reply to a channel question as a message, never an answer', async () => {
    engine().join('ops', 'a2a:fixture');
    engine().join('ops', 'human:alice');
    const q = await ask('Standup: blockers?', ['channel:ops']);
    await waitFor(() => row(q.id)?.state === 'open');
    peer.answer(peer.latest(), 'none');
    await waitFor(() => fromPeer(q.thread).some((m) => m.kind !== 'notice'));
    expect(fromPeer(q.thread).find((m) => m.kind !== 'notice')).toMatchObject({
      kind: 'message',
      replyTo: q.id,
    });
    expect(engine().answerOf(q.id)).toBeNull();
  });

  it('closes an outbound handoff as the system when the peer accepts it', async () => {
    const { message: h } = await engine().send(
      {
        to: ['a2a:fixture'],
        kind: 'handoff',
        body: 'Rate-limit uploads\n\nDetails.',
      },
      HUMAN
    );
    await waitFor(() => engine().answerOf(h.id) !== null);
    expect(engine().answerOf(h.id)).toMatchObject({
      from: 'agent:dispatch',
      body: 'Closed: a2a:fixture accepted (WORKING)',
    });
    expect(peer.opened[0]).toMatchObject({
      kind: 'handoff',
      work: { skill: 'handoff', title: 'Rate-limit uploads' },
    });
  });

  it('relays deliveries held while the worker was down, once it starts', async () => {
    f.outboundStop();
    const q = await ask();
    expect(f.messaging.store.deliveries({ messageId: q.id })[0].state).toBe(
      'held'
    );
    f.restartOutbound();
    await waitFor(() => row(q.id)?.state === 'open');
    expect(peer.opened).toHaveLength(1);
  });
});

describe('failures', () => {
  it('retries a 503 with backoff and relays once the peer is back', async () => {
    peer.status = 503;
    const q = await ask();
    await waitFor(() => (row(q.id)?.attempts ?? 0) === 1);
    expect(row(q.id)).toMatchObject({
      state: 'queued',
      lastError: expect.stringContaining('503'),
    });
    peer.status = 200;
    const later = Date.now() + 60_000;
    f.deps.now = () => new Date(later);
    f.outbound.kick('fixture');
    await waitFor(() => row(q.id)?.state === 'open');
    expect(row(q.id)?.attempts).toBe(2);
  });

  it('gives up after 24 hours of failures: the question is closed', async () => {
    peer.status = 503;
    const q = await ask();
    await waitFor(() => (row(q.id)?.attempts ?? 0) === 1);
    const later = Date.now() + 25 * 3_600_000;
    f.deps.now = () => new Date(later);
    f.outbound.kick('fixture');
    await waitFor(() => row(q.id)?.state === 'failed');
    expect(row(q.id)?.lastError).toContain('unreachable for 24 h');
    expect(engine().answerOf(q.id)).toMatchObject({
      from: 'agent:dispatch',
      body: expect.stringContaining('a2a:fixture'),
    });
  });

  it('sends once when a delivery is enqueued again while its relay is in flight', async () => {
    peer.sendDelayMs = 200;
    const q = await ask();
    await waitFor(() => peer.sends === 1);
    f.outbound.kick('fixture');
    f.outbound.kick('fixture');
    await waitFor(() => row(q.id)?.state === 'open');
    await Bun.sleep(300);
    expect(peer.sends).toBe(1);
  });

  it('keeps one retry timer per peer, however many deliveries wait', async () => {
    peer.status = 503;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        (
          await engine().send(
            { to: ['a2a:fixture'], kind: 'message', body: `note ${i}` },
            HUMAN
          )
        ).message.id
      );
    await waitFor(() => ids.every((id) => (row(id)?.attempts ?? 0) === 1));
    expect(f.outbound.retryTimerCount()).toBe(1);
  });

  it('forgets the WORKING-notice clock once a row is finished', async () => {
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'open');
    expect(f.outbound.workingClockCount()).toBe(1);
    peer.answer(peer.latest(), 'Blue');
    await waitFor(() => row(q.id)?.state === 'done');
    expect(f.outbound.workingClockCount()).toBe(0);
  });

  it('gives up at once on another 4xx: the question is closed and the sender told', async () => {
    peer.status = 400;
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'failed');
    expect(engine().answerOf(q.id)).toMatchObject({
      from: 'agent:dispatch',
      body: expect.stringContaining('a2a:fixture'),
    });
    await waitFor(() => notices().some((b) => b.includes('a2a:fixture')));
  });

  it('fails only the message on FORBIDDEN_ADDRESS: the peer stays active and the sender is told', async () => {
    peer.refuseRecipient = true;
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'failed');
    expect(f.store.getPeer('fixture')?.status).toBe('active');
    expect(engine().answerOf(q.id)).toMatchObject({ from: 'agent:dispatch' });
    await waitFor(() =>
      notices().some((b) => b.includes('a2a:fixture refused the message'))
    );
  });

  it('marks the peer auth-failed on a 403 with an AUTH_ reason', async () => {
    peer.revoked = true;
    await ask();
    await waitFor(() => f.store.getPeer('fixture')?.status === 'auth-failed');
  });

  it('fails only the message on a 403 without an AUTH_ reason', async () => {
    peer.status = 403;
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'failed');
    expect(f.store.getPeer('fixture')?.status).toBe('active');
  });

  it('marks the peer auth-failed on 401, keeps the delivery held, and resumes on enable', async () => {
    await setPeerEnabled(f.peerDeps(), 'fixture', true, 'wrong-token');
    const q = await ask();
    await waitFor(() => f.store.getPeer('fixture')?.status === 'auth-failed');
    expect(f.messaging.store.deliveries({ messageId: q.id })[0].state).toBe(
      'held'
    );
    await setPeerEnabled(f.peerDeps(), 'fixture', true, 'peer-token');
    f.peers.emit('fixture', 'enabled');
    await waitFor(() => row(q.id)?.state === 'open');
  });

  it('tells the app when the worker marks a peer auth-failed or disables it', async () => {
    let broadcasts = 0;
    const off = f.events.subscribe((event) => {
      if (event.type === 'a2a.changed') broadcasts += 1;
    });
    try {
      await setPeerEnabled(f.peerDeps(), 'fixture', true, 'wrong-token');
      await ask();
      await waitFor(() => f.store.getPeer('fixture')?.status === 'auth-failed');
      await waitFor(() => broadcasts > 0);
    } finally {
      off();
    }
  });

  it('tells the app when a refresh the worker started disables the peer', async () => {
    // Each broadcast records the peer's status as the app would read it.
    const seen: (string | undefined)[] = [];
    const off = f.events.subscribe((event) => {
      if (event.type === 'a2a.changed')
        seen.push(f.store.getPeer('fixture')?.status);
    });
    try {
      peer.versionNotSupported = true;
      peer.cardPublicUrl = 'http://127.0.0.2:9';
      await ask();
      await waitFor(() => f.store.getPeer('fixture')?.status === 'disabled');
      await waitFor(() => seen.includes('disabled'));
    } finally {
      off();
    }
  });

  it('refreshes the card when the peer answers VERSION_NOT_SUPPORTED, and gives up on that delivery', async () => {
    const before = peer.cardFetches;
    peer.versionNotSupported = true;
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'failed');
    await waitFor(() => peer.cardFetches > before);
    expect(engine().answerOf(q.id)).toMatchObject({
      from: 'agent:dispatch',
      body: expect.stringContaining('a2a:fixture'),
    });
  });
});

describe('a peer that lost the task', () => {
  it('refreshes the card when reading the tracked task answers 404', async () => {
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'open');
    const before = peer.cardFetches;
    peer.forget(peer.latest());
    await waitFor(() => row(q.id)?.state === 'failed');
    await waitFor(() => peer.cardFetches > before);
  });
});

describe('the URL guard at every contact', () => {
  // A peer a deciding human added (public-address rules), reached in the test
  // through a fetch that maps the pinned public address onto the fixture peer.
  function decideTierPeer(alias: string, addresses: () => string[]): string[] {
    const host = `https://${alias}.example.com`;
    const contacts: string[] = [];
    f.peers.deps.lookup = () => Promise.resolve(addresses());
    f.peers.deps.fetchImpl = ((
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      contacts.push(url);
      const { tls: _tls, ...plain } = (init ?? {}) as RequestInit & {
        tls?: unknown;
      };
      return fetch(url.replace(`https://${PUBLIC}`, peer.url), plain);
    }) as typeof fetch;
    const base = f.store.getPeer('fixture')!;
    f.store.putPeer({
      ...base,
      alias,
      addedTier: 'decide',
      allowHttp: false,
      allowOrigin: false,
      cardUrl: `${host}/.well-known/agent-card.json`,
      interfaceUrl: `${host}/a2a/v1`,
    });
    writePeerCredential(f.deps.rootDir, alias, {
      scheme: 'bearer',
      token: 'peer-token',
    });
    f.peers.emit(alias, 'added');
    return contacts;
  }

  it('relays to a decide-tier peer only through its checked address', async () => {
    const contacts = decideTierPeer('pinned', () => [PUBLIC]);
    const q = await ask('Which colour?', ['a2a:pinned']);
    await waitFor(() => f.store.getOutbound(q.id, 'pinned')?.state === 'open');
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts.every((u) => u.startsWith(`https://${PUBLIC}/`))).toBe(
      true
    );
  });

  it('never contacts a decide-tier peer whose name now resolves privately, and closes its question', async () => {
    const contacts = decideTierPeer('rebound', () => ['10.0.0.9']);
    const q = await ask('Which colour?', ['a2a:rebound']);
    await waitFor(
      () => f.store.getOutbound(q.id, 'rebound')?.state === 'failed'
    );
    expect(contacts).toEqual([]);
    expect(peer.opened).toHaveLength(0);
    expect(engine().answerOf(q.id)).toMatchObject({
      from: 'agent:dispatch',
      body: expect.stringContaining('a2a:rebound'),
    });
    expect(f.store.getPeer('rebound')?.status).toBe('disabled');
    await waitFor(
      () =>
        notices().filter((b) => b.includes('a2a:rebound was disabled'))
          .length === 1
    );
  });

  it('re-checks before every read of a tracked task: after a rebind the peer’s answer is never recorded', async () => {
    let addresses = [PUBLIC];
    decideTierPeer('rebound', () => addresses);
    const q = await ask('Which colour?', ['a2a:rebound']);
    await waitFor(() => f.store.getOutbound(q.id, 'rebound')?.state === 'open');
    addresses = ['10.0.0.9'];
    // Lets a read that resolved before the rebind finish first.
    await Bun.sleep(100);
    peer.answer(peer.latest(), 'Blue');
    await waitFor(
      () => f.store.getOutbound(q.id, 'rebound')?.state === 'failed'
    );
    expect(engine().answerOf(q.id)).toMatchObject({ from: 'agent:dispatch' });
    expect(fromPeer(q.thread, 'rebound')).toHaveLength(0);
    expect(f.store.getPeer('rebound')?.status).toBe('disabled');
  });

  it('treats a refusal from the pinned fetch itself as final', async () => {
    // The pre-check passes, then the name rebinds before the connect.
    let calls = 0;
    decideTierPeer('racing', () => (calls++ === 0 ? [PUBLIC] : ['10.0.0.9']));
    const q = await ask('Which colour?', ['a2a:racing']);
    await waitFor(
      () => f.store.getOutbound(q.id, 'racing')?.state === 'failed'
    );
    expect(f.store.getOutbound(q.id, 'racing')?.attempts).toBe(1);
    expect(f.store.getPeer('racing')?.status).toBe('disabled');
    expect(peer.opened).toHaveLength(0);
  });

  it('retries a send while the peer’s name does not resolve, and never disables it', async () => {
    decideTierPeer('flaky', () => [PUBLIC]);
    f.peers.deps.lookup = () => Promise.reject(new Error('EAI_AGAIN'));
    const q = await ask('Which colour?', ['a2a:flaky']);
    await waitFor(
      () => (f.store.getOutbound(q.id, 'flaky')?.attempts ?? 0) === 1
    );
    expect(f.store.getOutbound(q.id, 'flaky')).toMatchObject({
      state: 'queued',
      lastError: expect.stringContaining('does not resolve'),
    });
    expect(f.store.getPeer('flaky')?.status).toBe('active');
    expect(engine().answerOf(q.id)).toBeNull();
    f.peers.deps.lookup = () => Promise.resolve([PUBLIC]);
    const later = Date.now() + 60_000;
    f.deps.now = () => new Date(later);
    f.outbound.kick('flaky');
    await waitFor(() => f.store.getOutbound(q.id, 'flaky')?.state === 'open');
  });

  it('keeps tracking while the peer’s name does not resolve', async () => {
    decideTierPeer('flaky', () => [PUBLIC]);
    const q = await ask('Which colour?', ['a2a:flaky']);
    await waitFor(() => f.store.getOutbound(q.id, 'flaky')?.state === 'open');
    f.peers.deps.lookup = () => Promise.reject(new Error('EAI_AGAIN'));
    // Lets a read that resolved before the change finish first.
    await Bun.sleep(100);
    peer.answer(peer.latest(), 'Blue');
    await Bun.sleep(200);
    expect(f.store.getOutbound(q.id, 'flaky')?.state).toBe('open');
    expect(f.store.getPeer('flaky')?.status).toBe('active');
    expect(engine().answerOf(q.id)).toBeNull();
    f.peers.deps.lookup = () => Promise.resolve([PUBLIC]);
    await waitFor(() => engine().answerOf(q.id) !== null);
    expect(engine().answerOf(q.id)?.from).toBe('a2a:flaky');
  });

  it('does not re-check an operator-tier peer, which may be private on purpose', async () => {
    f.peers.deps.lookup = () => Promise.resolve(['10.0.0.9']);
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'open');
    expect(f.store.getPeer('fixture')?.status).toBe('active');
  });
});

describe('tracking limits and load', () => {
  it('stops tracking at the 7-day limit even while the peer keeps streaming events', async () => {
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'open');
    const later = Date.now() + 8 * 86_400_000;
    f.deps.now = () => new Date(later);
    peer.ask(peer.latest(), 'Still there?');
    await waitFor(() => row(q.id)?.state === 'failed');
    expect(row(q.id)?.lastError).toBe('no result in 7 days');
    expect(engine().answerOf(q.id)).toMatchObject({
      from: 'agent:dispatch',
      body: expect.stringContaining('7 days'),
    });
    await waitFor(() => f.outbound.trackerCount('fixture') === 0);
  });
});

describe('removing or disabling a peer mid-flight', () => {
  it('removing a peer closes the run’s open question and stops tracking', async () => {
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'open');
    const before = fromPeer(q.thread).length;
    removePeer(f.peerDeps(), 'fixture');
    f.peers.emit('fixture', 'removed');
    await waitFor(() => engine().answerOf(q.id) !== null);
    expect(engine().answerOf(q.id)).toMatchObject({
      from: 'agent:dispatch',
      body: 'Closed: a2a:fixture was removed',
    });
    expect(row(q.id)?.state).toBe('failed');
    await waitFor(() => f.outbound.trackerCount('fixture') === 0);
    peer.answer(peer.latest(), 'Blue');
    await Bun.sleep(100);
    expect(fromPeer(q.thread)).toHaveLength(before);
  });

  it('closes the open questions the removed peer asked', async () => {
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'open');
    peer.ask(peer.latest(), 'Which region?', ['us', 'eu']);
    await waitFor(() => fromPeer(q.thread).some((m) => m.kind === 'question'));
    const theirs = fromPeer(q.thread).find((m) => m.kind === 'question')!;
    removePeer(f.peerDeps(), 'fixture');
    f.peers.emit('fixture', 'removed');
    await waitFor(() => engine().answerOf(theirs.id) !== null);
    expect(engine().answerOf(theirs.id)).toMatchObject({
      from: 'agent:dispatch',
      body: 'Closed: a2a:fixture was removed',
    });
  });

  it('lets a removed alias be added again, without its old context', async () => {
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'open');
    expect(f.store.contextFor('fixture', q.thread)).not.toBeNull();
    removePeer(f.peerDeps(), 'fixture');
    f.peers.emit('fixture', 'removed');
    await waitFor(() => row(q.id)?.state === 'failed');
    expect(f.store.contextFor('fixture', q.thread)).toBeNull();
    await addPeer(
      f.peerDeps(),
      { alias: 'fixture', cardUrl: peer.cardUrl(), token: 'peer-token' },
      OPERATOR
    );
    expect(f.store.getPeer('fixture')?.status).toBe('active');
  });

  it('refuses an alias that still has outbound history', async () => {
    f.store.putOutbound({
      messageId: 'm-old',
      alias: 'reused',
      thread: 'm-old',
      remoteTaskId: 'pt-old',
      remoteContextId: 'pc-old',
      state: 'done',
      attempts: 1,
      firstAttemptAt: new Date().toISOString(),
      nextAttemptAt: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    await expect(
      addPeer(
        f.peerDeps(),
        { alias: 'reused', cardUrl: peer.cardUrl(), token: 'peer-token' },
        OPERATOR
      )
    ).rejects.toMatchObject({ code: 'conflict', field: 'alias' });
  });

  it('keeps a row failed when the peer is removed while its send is in flight', async () => {
    peer.sendDelayMs = 300;
    const q = await ask();
    await waitFor(() => peer.sends === 1);
    removePeer(f.peerDeps(), 'fixture');
    f.peers.emit('fixture', 'removed');
    await Bun.sleep(500);
    expect(row(q.id)?.state).toBe('failed');
    expect(f.messaging.store.deliveries({ messageId: q.id })[0].state).not.toBe(
      'pushed'
    );
    expect(f.outbound.trackerCount('fixture')).toBe(0);
  });

  it('keeps the tombstone when a send fails after its peer was removed', async () => {
    peer.status = 503;
    peer.sendDelayMs = 300;
    const q = await ask();
    await waitFor(() => peer.sends === 1);
    removePeer(f.peerDeps(), 'fixture');
    f.peers.emit('fixture', 'removed');
    await waitFor(() => row(q.id)?.state === 'failed');
    const noticesBefore = notices().length;
    await Bun.sleep(500);
    expect(row(q.id)).toMatchObject({
      state: 'failed',
      lastError: 'a2a:fixture was removed',
      remoteTaskId: null,
      remoteContextId: null,
    });
    expect(notices()).toHaveLength(noticesBefore);
    peer.status = 200;
    peer.sendDelayMs = 0;
    await addPeer(
      f.peerDeps(),
      { alias: 'fixture', cardUrl: peer.cardUrl(), token: 'peer-token' },
      OPERATOR
    );
  });

  it('disabling stops tracking and enabling resumes it', async () => {
    const q = await ask();
    await waitFor(() => row(q.id)?.state === 'open');
    await setPeerEnabled(f.peerDeps(), 'fixture', false);
    f.peers.emit('fixture', 'disabled');
    await waitFor(() => f.outbound.trackerCount('fixture') === 0);
    peer.answer(peer.latest(), 'Blue');
    await Bun.sleep(100);
    expect(engine().answerOf(q.id)).toBeNull();
    await setPeerEnabled(f.peerDeps(), 'fixture', true);
    f.peers.emit('fixture', 'enabled');
    await waitFor(() => engine().answerOf(q.id) !== null);
    expect(engine().answerOf(q.id)?.from).toBe('a2a:fixture');
  });
});
