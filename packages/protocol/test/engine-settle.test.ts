import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SYSTEM_ADDRESS } from '../src/address.js';
import { DeliveryEngine } from '../src/engine.js';
import type { EngineEvent } from '../src/engine.js';
import type { Message } from '../src/envelope.js';
import type { RemoteTarget } from '../src/host.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';
import { FakeFederation, FakeHost } from './fakeHost.js';

const ME = 'wyat-0000000a';
const BOB = 'bob-0000000b';
const CY = 'cy-0000000c';
const ADA = 'ada-0000000d';
const TASK_ID = 't-00000a01';
const TASK = `task:${TASK_ID}`;
const wyat = { address: 'human:wyat', canDecide: true };

let db: SqliteDatabase;
let store: SqliteMessageStore;
let host: FakeHost;
let fed: FakeFederation;
let engine: DeliveryEngine;
let tick = 0;

function remote(id: string, over: Partial<Message> = {}): Message {
  tick += 1;
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'human:bob',
    to: ['human:wyat'],
    kind: 'message',
    body: `body of ${id}`,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-26T10:00:00.000Z',
    hlc: `1758880000000.${String(tick).padStart(4, '0')}.${BOB}`,
    ...over,
  };
}
const here = (
  recipient: string,
  via: 'direct' | 'channel' = 'direct',
  wakeAt?: string
): RemoteTarget => ({
  recipient,
  via,
  homes: [ME],
  ...(wakeAt === undefined ? {} : { wakeAt }),
});
const there = (recipient: string, homes = [BOB]): RemoteTarget => ({
  recipient,
  via: 'direct',
  homes,
});
const fromBob = (targets: RemoteTarget[], forwardTarget?: string) => ({
  replica: BOB,
  targets,
  ...(forwardTarget === undefined ? {} : { forwardTarget }),
});

beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
  host = new FakeHost();
  fed = new FakeFederation(ME);
  fed.labels.set(BOB, 'bob');
  fed.labels.set(CY, 'cy');
  host.federation = fed;
  engine = new DeliveryEngine({ store, host });
});
afterEach(() => db.close());

function answerTo(q: Message, id: string, from: string, body = 'yes'): Message {
  return remote(id, {
    from,
    kind: 'answer',
    thread: q.thread,
    replyTo: q.id,
    to: [q.from],
    body,
  });
}

describe('at the settler: the question was asked here', () => {
  let q: Message;
  beforeEach(async () => {
    host.startRun(TASK_ID, 'r-00000000000a');
    fed.placements.set('human:bob', {
      kind: 'remote',
      homes: [BOB],
      alsoLocal: false,
    });
    fed.placements.set('human:cy', {
      kind: 'remote',
      homes: [CY],
      alsoLocal: false,
    });
    q = (
      await engine.send(
        {
          to: ['human:bob', 'human:cy'],
          kind: 'question',
          blocking: true,
          body: 'ship it?',
        },
        { address: 'run:r-00000000000a', canDecide: false }
      )
    ).message;
  });

  it('accepts the first answer it applies and records the settlement', async () => {
    await engine.receive(
      answerTo(q, 'm-a1', 'human:bob'),
      fromBob([here('run:r-00000000000a')])
    );
    expect(store.answersTo(q.id).map((m) => m.id)).toEqual(['m-a1']);
    expect(store.settledAs('m-a1')).toBe('accepted');
    expect(store.settlement(q.id)).toMatchObject({
      answerId: 'm-a1',
      settler: ME,
      closedReason: null,
    });
  });

  it('keeps a later remote answer as a superseded reply and tells its sender', async () => {
    await engine.receive(
      answerTo(q, 'm-a1', 'human:bob'),
      fromBob([here('run:r-00000000000a')])
    );
    await engine.receive(answerTo(q, 'm-a2', 'human:cy'), {
      replica: CY,
      targets: [here('run:r-00000000000a')],
    });
    expect(store.getMessage('m-a2')?.kind).toBe('message');
    expect(store.settledAs('m-a2')).toBe('superseded');
    const noticeRow = store
      .remoteDeliveries({ recipient: 'human:cy' })
      .find((r) => r.messageId !== q.id);
    expect(store.getMessage(noticeRow?.messageId ?? '')?.body).toBe(
      'm-a2 was already answered by human:bob; yours was kept as a reply.'
    );
  });

  it('answers a later local answer with conflict, as today', async () => {
    await engine.receive(
      answerTo(q, 'm-a1', 'human:bob'),
      fromBob([here('run:r-00000000000a')])
    );
    await expect(
      engine.reply(q.id, { body: 'me too' }, wyat)
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('accepts the first local answer and records the settlement the router publishes', async () => {
    const { message: a } = await engine.reply(
      q.id,
      { body: 'from here' },
      wyat
    );
    expect(store.settledAs(a.id)).toBe('accepted');
    expect(store.settlement(q.id)).toMatchObject({
      answerId: a.id,
      settler: ME,
      closedReason: null,
    });
    expect(store.answersTo(q.id).map((m) => m.id)).toEqual([a.id]);
  });
});

describe('a settle for a question not stored yet', () => {
  it("honours only the question's origin, whoever settled first", async () => {
    engine.applySettlement(
      {
        t: 'settle',
        question: 'm-q2',
        answer: 'm-a7',
        at: '2026-09-26T10:05:00.000Z',
      },
      CY
    );
    engine.applySettlement(
      {
        t: 'settle',
        question: 'm-q2',
        answer: 'm-a8',
        at: '2026-09-26T10:06:00.000Z',
      },
      BOB
    );
    expect(store.settlement('m-q2')).toBeNull();
    const q2 = remote('m-q2', {
      kind: 'question',
      blocking: true,
      to: ['human:wyat', 'human:cy'],
    });
    await engine.receive(
      q2,
      fromBob([here('human:wyat'), there('human:cy', [CY])])
    );
    expect(store.settlement('m-q2')).toMatchObject({
      answerId: 'm-a8',
      settler: BOB,
    });
    expect(store.earlySettlements('m-q2')).toEqual([]);
    expect(fed.problems).toContainEqual({
      subject: 'message:m-q2',
      message: `${CY} sent a settle for m-q2; only the question's origin settles it`,
    });
    await engine.receive(answerTo(q2, 'm-a7', 'human:cy'), {
      replica: CY,
      targets: [there('human:bob')],
    });
    await engine.receive(answerTo(q2, 'm-a8', 'human:cy'), {
      replica: CY,
      targets: [there('human:bob')],
    });
    expect(store.settledAs('m-a7')).toBe('superseded');
    expect(store.settledAs('m-a8')).toBe('accepted');
  });

  it("never accepts on a non-origin's word, even when the answer arrived before its question", async () => {
    engine.applySettlement(
      {
        t: 'settle',
        question: 'm-q4',
        answer: 'm-a9',
        at: '2026-09-26T10:05:00.000Z',
      },
      CY
    );
    const q4 = remote('m-q4', {
      kind: 'question',
      blocking: true,
      to: ['human:wyat', 'human:cy'],
    });
    await engine.receive(answerTo(q4, 'm-a9', 'human:cy'), {
      replica: CY,
      targets: [there('human:bob'), here('human:wyat')],
    });
    expect(store.settledAs('m-a9')).toBe('pending');
    await engine.receive(
      q4,
      fromBob([here('human:wyat'), there('human:cy', [CY])])
    );
    expect(store.settledAs('m-a9')).toBe('pending');
    expect(store.settlement('m-q4')).toBeNull();
  });
});

describe('an answer that arrived before its question', () => {
  it('stores the question answered on arrival, so nobody is asked it again', async () => {
    const q5 = remote('m-q5', {
      kind: 'question',
      blocking: true,
      to: ['human:wyat', 'human:cy'],
    });
    await engine.receive(answerTo(q5, 'm-a5', 'human:cy'), {
      replica: CY,
      targets: [there('human:bob'), here('human:wyat')],
    });
    expect(store.settledAs('m-a5')).toBe('pending');
    const r = await engine.receive(
      q5,
      fromBob([here('human:wyat'), there('human:cy', [CY])])
    );
    expect(r.deliveries.map((d) => [d.recipient, d.state])).toEqual([
      ['human:wyat', 'answered'],
    ]);
    expect(
      store.deliveries({ messageId: 'm-q5', recipient: 'human:wyat' })[0]?.state
    ).toBe('answered');
    expect(host.hooks('notifyHuman')).not.toContainEqual([
      'human:wyat',
      'm-q5',
    ]);
  });

  it('leaves the question open when the answers that came first would have been refused', async () => {
    const q6 = remote('m-q6', {
      kind: 'question',
      blocking: true,
      to: ['human:wyat', 'human:cy'],
      choices: ['ship', 'wait'],
    });
    await engine.receive(
      { ...answerTo(q6, 'm-a6', 'human:cy'), choice: 'panic' },
      { replica: CY, targets: [there('human:bob'), here('human:wyat')] }
    );
    await engine.receive(
      { ...answerTo(q6, 'm-a7', 'human:ada'), choice: 'ship' },
      { replica: ADA, targets: [there('human:bob'), here('human:wyat')] }
    );
    const r = await engine.receive(
      q6,
      fromBob([here('human:wyat'), there('human:cy', [CY])])
    );
    expect(r.deliveries.map((d) => [d.recipient, d.state])).toEqual([
      ['human:wyat', 'notified'],
    ]);
    expect(host.hooks('notifyHuman')).toContainEqual(['human:wyat', 'm-q6']);
    expect(store.answersTo('m-q6')).toEqual([]);
    expect(['m-a6', 'm-a7'].map((id) => store.settledAs(id))).toEqual([
      'candidate',
      'candidate',
    ]);
  });

  it('answers the question with the first early answer that holds up', async () => {
    const q8 = remote('m-q8', {
      kind: 'question',
      blocking: true,
      to: ['human:wyat', 'human:cy'],
      choices: ['ship', 'wait'],
    });
    const fromCy = {
      replica: CY,
      targets: [there('human:bob'), here('human:wyat')],
    };
    await engine.receive(
      { ...answerTo(q8, 'm-a8', 'human:cy'), choice: 'panic' },
      fromCy
    );
    await engine.receive(
      { ...answerTo(q8, 'm-a9', 'human:cy'), choice: 'wait' },
      fromCy
    );
    const r = await engine.receive(
      q8,
      fromBob([here('human:wyat'), there('human:cy', [CY])])
    );
    expect(r.deliveries.map((d) => [d.recipient, d.state])).toEqual([
      ['human:wyat', 'answered'],
    ]);
    expect(store.answersTo('m-q8').map((m) => m.id)).toEqual(['m-a9']);
    expect(['m-a8', 'm-a9'].map((id) => store.settledAs(id))).toEqual([
      'candidate',
      'pending',
    ]);
  });
});

describe("elsewhere: Bob's question, received here", () => {
  let q: Message;
  beforeEach(async () => {
    fed.placements.set('human:bob', {
      kind: 'remote',
      homes: [BOB],
      alsoLocal: false,
    });
    q = remote('m-q', {
      kind: 'question',
      blocking: true,
      to: ['human:wyat', 'human:cy'],
    });
    await engine.receive(
      q,
      fromBob([here('human:wyat'), there('human:cy', [CY])])
    );
  });

  // The accepted answer went to the asker only, never here: the settle
  // alone tells this replica its own answer lost.
  it('supersedes its own pending answer on a settle naming an answer it never sees', async () => {
    const { message: mine } = await engine.reply(q.id, { body: 'no' }, wyat);
    expect(store.settledAs(mine.id)).toBe('pending');
    engine.applySettlement(
      {
        t: 'settle',
        question: q.id,
        answer: 'm-acy',
        at: '2026-09-26T10:05:00.000Z',
      },
      BOB
    );
    expect(store.settledAs(mine.id)).toBe('superseded');
    expect(store.getMessage(mine.id)?.kind).toBe('message');
    expect(store.settlement(q.id)?.answerId).toBe('m-acy');
    // Its sender is told, as a later answer's sender is at the settler.
    await new Promise((r) => setTimeout(r, 10));
    const notice = host
      .hooks('notifyHuman')
      .map((args) => store.getMessage(String(args[1])))
      .find((m) => m?.from === SYSTEM_ADDRESS && m.body.startsWith(mine.id));
    expect(notice?.body).toBe(
      `${mine.id} was already answered; yours was kept as a reply.`
    );
  });

  it('stores the first answer seen as pending and later ones as candidates', async () => {
    const { message: mine } = await engine.reply(q.id, { body: 'yes' }, wyat);
    expect(store.settledAs(mine.id)).toBe('pending');
    expect(
      store.deliveries({ messageId: q.id, recipient: 'human:wyat' })[0]?.state
    ).toBe('answered');
    await engine.receive(answerTo(q, 'm-a2', 'human:cy'), {
      replica: CY,
      targets: [there('human:bob')],
    });
    expect(store.settledAs('m-a2')).toBe('candidate');
    expect(store.getMessage('m-a2')?.kind).toBe('message');
  });

  it('swaps in the settled answer when the answer arrives first', async () => {
    await engine.reply(q.id, { body: 'yes' }, wyat);
    await engine.receive(answerTo(q, 'm-a2', 'human:cy'), {
      replica: CY,
      targets: [there('human:bob')],
    });
    engine.applySettlement(
      {
        t: 'settle',
        question: q.id,
        answer: 'm-a2',
        at: '2026-09-26T10:05:00.000Z',
      },
      BOB
    );
    expect(store.answersTo(q.id).map((m) => m.id)).toEqual(['m-a2']);
    expect(store.settledAs('m-a2')).toBe('accepted');
  });

  it('records a settle whose answer has not arrived and applies it when it lands', async () => {
    engine.applySettlement(
      {
        t: 'settle',
        question: q.id,
        answer: 'm-a2',
        at: '2026-09-26T10:05:00.000Z',
      },
      BOB
    );
    await engine.receive(answerTo(q, 'm-a2', 'human:cy'), {
      replica: CY,
      targets: [there('human:bob')],
    });
    expect(store.settledAs('m-a2')).toBe('accepted');
    expect(
      store.deliveries({ messageId: q.id, recipient: 'human:wyat' })[0]?.state
    ).toBe('answered');
  });

  it('settles two candidates to the one the settler named, in either arrival order', async () => {
    await engine.receive(answerTo(q, 'm-a3', 'human:cy'), {
      replica: CY,
      targets: [there('human:bob')],
    });
    await engine.receive(
      answerTo(q, 'm-a4', 'human:bob'),
      fromBob([there('human:bob')])
    );
    engine.applySettlement(
      {
        t: 'settle',
        question: q.id,
        answer: 'm-a4',
        at: '2026-09-26T10:05:00.000Z',
      },
      BOB
    );
    expect(
      store.answerCandidates(q.id).map((c) => [c.message.id, c.settledAs])
    ).toEqual([
      ['m-a3', 'superseded'],
      ['m-a4', 'accepted'],
    ]);
  });

  it("writes the settler's close under its id, from agent:dispatch, with the settler as origin", () => {
    engine.applySettlement(
      {
        t: 'settle',
        question: q.id,
        answer: 'm-close1',
        closed: 'the run ended',
        at: '2026-09-26T10:05:00.000Z',
      },
      BOB
    );
    expect(store.getMessage('m-close1')).toMatchObject({
      from: SYSTEM_ADDRESS,
      kind: 'answer',
      origin: BOB,
      data: { type: 'x-closed', reason: 'the run ended' },
    });
    expect(
      store.deliveries({ messageId: q.id, recipient: 'human:wyat' })[0]?.state
    ).toBe('answered');
  });

  it('believes only the settler', () => {
    expect(() =>
      engine.applySettlement(
        {
          t: 'settle',
          question: q.id,
          answer: 'm-a9',
          at: '2026-09-26T10:05:00.000Z',
        },
        CY
      )
    ).toThrow();
    expect(store.settlement(q.id)).toBeNull();
  });

  it('turns a refused local answer back into a plain reply and reopens the question', async () => {
    const { message: mine } = await engine.reply(q.id, { body: 'yes' }, wyat);
    engine.applyState(
      [
        {
          t: 'refused',
          message: mine.id,
          reason: 'conflict: already answered',
          at: '2026-09-26T10:05:00.000Z',
        },
      ],
      BOB
    );
    expect(store.getMessage(mine.id)?.kind).toBe('message');
    expect(store.settledAs(mine.id)).toBeNull();
    expect(
      store.deliveries({ messageId: q.id, recipient: 'human:wyat' })[0]?.state
    ).toBe('notified');
  });

  it("keeps a pending local answer when a replica other than the question's settler refuses it", async () => {
    fed.placements.set('human:bob', {
      kind: 'remote',
      homes: [BOB, CY],
      alsoLocal: false,
    });
    const { message: mine } = await engine.reply(q.id, { body: 'yes' }, wyat);
    engine.applyState(
      [
        {
          t: 'refused',
          message: mine.id,
          reason: 'invalid: body',
          at: '2026-09-26T10:05:00.000Z',
        },
      ],
      CY
    );
    expect(store.settledAs(mine.id)).toBe('pending');
    expect(
      store.deliveries({ messageId: q.id, recipient: 'human:wyat' })[0]?.state
    ).toBe('answered');
  });

  it('ignores a settle that names a message not answering the question', async () => {
    await engine.receive(remote('m-other'), fromBob([here('human:wyat')]));
    await engine.receive(
      remote('m-reply', { thread: q.thread, replyTo: q.id }),
      fromBob([here('human:wyat')])
    );
    for (const answer of ['m-other', 'm-reply'])
      engine.applySettlement(
        { t: 'settle', question: q.id, answer, at: '2026-09-26T10:05:00.000Z' },
        BOB
      );
    for (const id of ['m-other', 'm-reply']) {
      expect(store.getMessage(id)?.kind).toBe('message');
      expect(store.settledAs(id)).toBeNull();
    }
    expect(store.answersTo(q.id)).toEqual([]);
    expect(store.settlement(q.id)).toBeNull();
    await engine.receive(answerTo(q, 'm-a2', 'human:cy'), {
      replica: CY,
      targets: [there('human:bob')],
    });
    expect(store.settledAs('m-a2')).toBe('pending');
  });

  it("clocks the settler's close here, so it sorts after what this replica has seen", () => {
    engine.applySettlement(
      {
        t: 'settle',
        question: q.id,
        answer: 'm-close1',
        closed: 'the run ended',
        at: '2026-09-26T10:05:00.000Z',
      },
      BOB
    );
    expect(store.getMessage('m-close1')?.hlc).toEndWith(`.${ME}`);
  });
});

describe('applyState and claims', () => {
  it('keeps the maximum per recipient; refused only when every home refused; a later report replaces it', async () => {
    fed.placements.set('human:ada', {
      kind: 'remote',
      homes: [BOB, CY],
      alsoLocal: false,
    });
    const { message } = await engine.send(
      { to: ['human:ada'], kind: 'message', body: 'x' },
      wyat
    );
    engine.applyState(
      [
        {
          t: 'delivery',
          message: message.id,
          recipient: 'human:ada',
          state: 'read',
          at: 't1',
        },
      ],
      BOB
    );
    engine.applyState(
      [
        {
          t: 'delivery',
          message: message.id,
          recipient: 'human:ada',
          state: 'notified',
          at: 't2',
        },
      ],
      CY
    );
    expect(store.remoteDeliveries({ messageId: message.id })[0]?.state).toBe(
      'read'
    );
    const { message: other } = await engine.send(
      { to: ['human:ada'], kind: 'message', body: 'y' },
      wyat
    );
    engine.applyState(
      [{ t: 'refused', message: other.id, reason: 'invalid: body', at: 't3' }],
      BOB
    );
    expect(store.remoteDeliveries({ messageId: other.id })[0]?.state).toBe(
      'forwarded'
    );
    engine.applyState(
      [{ t: 'refused', message: other.id, reason: 'invalid: body', at: 't4' }],
      CY
    );
    expect(store.remoteDeliveries({ messageId: other.id })[0]?.state).toBe(
      'refused'
    );
    engine.applyState(
      [
        {
          t: 'delivery',
          message: other.id,
          recipient: 'human:ada',
          state: 'notified',
          at: 't5',
        },
      ],
      CY
    );
    expect(store.remoteDeliveries({ messageId: other.id })[0]?.state).toBe(
      'notified'
    );
  });

  it("moves a human's other device to read once any home reports read", async () => {
    await engine.receive(
      remote('m-01', { to: ['human:wyat'] }),
      fromBob([{ recipient: 'human:wyat', via: 'direct', homes: [ME, CY] }])
    );
    engine.applyState(
      [
        {
          t: 'delivery',
          message: 'm-01',
          recipient: 'human:wyat',
          state: 'read',
          at: 't1',
        },
      ],
      CY
    );
    expect(store.deliveries({ messageId: 'm-01' })[0]?.state).toBe('read');
  });

  it('retires a held task copy when another home reports it pushed', async () => {
    await engine.receive(
      remote('m-01', { to: [TASK] }),
      fromBob([{ recipient: TASK, via: 'direct', homes: [ME, CY] }])
    );
    engine.applyState(
      [
        {
          t: 'delivery',
          message: 'm-01',
          recipient: TASK,
          state: 'pushed',
          at: 't1',
        },
      ],
      CY
    );
    expect(store.deliveries({ messageId: 'm-01' })).toEqual([]);
    expect(
      store.remoteDeliveries({ messageId: 'm-01', recipient: TASK })[0]?.state
    ).toBe('pushed');
  });

  it('claimRemote turns forwarded task rows into held deliveries', async () => {
    await engine.receive(
      remote('m-01', { to: [TASK] }),
      fromBob([there(TASK)])
    );
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const claimed = engine.claimRemote(TASK_ID);
    expect(claimed.map((d) => [d.recipient, d.state])).toEqual([
      [TASK, 'held'],
    ]);
    expect(store.remoteDeliveries({ recipient: TASK })).toEqual([]);
    expect(events).toContainEqual({
      type: 'remote',
      messageId: 'm-01',
      recipient: TASK,
    });
  });
});
