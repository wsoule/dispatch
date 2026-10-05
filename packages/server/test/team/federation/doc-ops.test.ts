import { afterEach, describe, expect, it } from 'bun:test';

import type { RecordingDocsPort } from './helpers/docsPort.js';
import { marker } from './helpers/docsPort.js';
import { foundedTeamWith } from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';

let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const port = (r: MessagingReplica): RecordingDocsPort => {
  if (r.docsPort === null) throw new Error('no docs port');
  return r.docsPort;
};
const sync = (r: MessagingReplica) => {
  if (r.docSync === null) throw new Error('no doc sync');
  return r.docSync;
};
const parked = (r: MessagingReplica) =>
  r.fed.db
    .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM fed_parked')
    .get()?.n;

describe('doc ops (the routing the docs plan binds to)', () => {
  it("reach the docs port in clock order, speaking only for the publisher's own human", async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const [ada, bob] = open as [MessagingReplica, MessagingReplica];
    sync(bob).publish(marker('one'));
    sync(bob).publish(marker('two'));
    await ada.settleWith(bob);
    expect(port(ada).seen.map((s) => s.title)).toEqual(['one', 'two']);
    expect(
      port(ada).seen.every(
        (s) => s.replica === bob.fed.replica && s.forBob && !s.forAda
      )
    ).toBe(true);
    expect(sync(ada).speaksFor(bob.fed.replica, 'human:bob')).toBe(true);
    expect(sync(ada).speaksFor(bob.fed.replica, 'agent:bob/x')).toBe(false);
  });

  it('drops a malformed doc body with a rolling note, never reaching the port', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const [ada, bob] = open as [MessagingReplica, MessagingReplica];
    bob.fed.append({ type: 'doc', body: { doc: 'd-1', kind: 'put', n: 1 } });
    await ada.settleWith(bob);
    expect(port(ada).seen).toEqual([]);
    expect(
      ada.fed
        .problems()
        .some((p) => p.subject === `malformed:${bob.fed.replica}`)
    ).toBe(true);
  });

  it('keeps a parked doc op in fed_parked and offers it again next pass', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const [ada, bob] = open as [MessagingReplica, MessagingReplica];
    port(ada).answer = 'parked';
    sync(bob).publish(marker('waits'));
    await ada.settleWith(bob);
    expect(parked(ada)).toBe(1);
    port(ada).answer = 'applied';
    await ada.service.syncNow();
    expect(port(ada).seen).toHaveLength(2);
    expect(parked(ada)).toBe(0);
  });

  it('re-delivers the ops a docs fold asks for again', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const [ada, bob] = open as [MessagingReplica, MessagingReplica];
    const op = sync(bob).publish(marker('again'));
    await ada.settleWith(bob);
    sync(ada).rereadOps(bob.fed.replica, [op.seq]);
    await ada.service.syncNow();
    expect(port(ada).seen.map((s) => s.seq)).toEqual([op.seq, op.seq]);
    // Asked once: the next pass re-reads nothing.
    await ada.service.syncNow();
    expect(port(ada).seen).toHaveLength(2);
  });

  it('never re-delivers an op whose bytes differ from the one verified', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const [ada, bob] = open as [MessagingReplica, MessagingReplica];
    const op = sync(bob).publish(marker('kept'));
    await ada.settleWith(bob);
    ada.remote.tamper(bob.fed.replica, op.seq, (e) => ({
      ...e,
      body: marker('forged') as never,
    }));
    sync(ada).rereadOps(bob.fed.replica, [op.seq]);
    await ada.service.syncNow();
    expect(port(ada).seen.map((s) => s.title)).toEqual(['kept']);
  });

  it('publishes what the docs port has pending each pass, then tells it', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const [ada, bob] = open as [MessagingReplica, MessagingReplica];
    port(bob).pending = [marker('p1'), marker('p2')];
    await ada.settleWith(bob);
    expect(port(bob).publishedBatches).toEqual([['p1', 'p2']]);
    expect(port(ada).seen.map((s) => s.title)).toEqual(['p1', 'p2']);
    await bob.service.syncNow();
    expect(port(bob).publishedBatches).toHaveLength(1);
  });

  it('tells the docs port when a complete pass ends, and not on an offline one', async () => {
    open = await foundedTeamWith({ docs: true }, 'ada', 'bob');
    const [ada] = open as [MessagingReplica];
    const before = port(ada).passes;
    await ada.service.syncNow();
    expect(port(ada).passes).toBe(before + 1);
    ada.remote.offline = true;
    await ada.service.syncNow();
    expect(port(ada).passes).toBe(before + 1);
  });

  it('tells the docs port when the cap drops a parked doc op', async () => {
    open = await foundedTeamWith(
      { docs: true, maxParkedPerPublisher: 1 },
      'ada',
      'bob'
    );
    const [ada, bob] = open as [MessagingReplica, MessagingReplica];
    port(ada).answer = 'parked';
    const first = sync(bob).publish(marker('first'));
    sync(bob).publish(marker('second'));
    await ada.settleWith(bob);
    expect(port(ada).dropped).toEqual([
      { replica: bob.fed.replica, seq: first.seq, reason: 'overflow' },
    ]);
    expect(parked(ada)).toBe(1);
  });

  it('tells the docs port when a settled revocation drops a parked doc op', async () => {
    open = await foundedTeamWith(
      { docs: true, admins: ['cy'] },
      'ada',
      'cy',
      'bob'
    );
    const [ada, cy, bob] = open as [
      MessagingReplica,
      MessagingReplica,
      MessagingReplica,
    ];
    port(ada).answer = 'parked';
    const op = sync(bob).publish(marker('cut'));
    await ada.settleWith(bob);
    expect(parked(ada)).toBe(1);
    // Cy has not read bob's op, so its cut lands below it.
    cy.roster.revoke(bob.fed.replica, 'left the team');
    await ada.settleWith(cy);
    await ada.service.syncNow();
    expect(port(ada).dropped).toEqual([
      { replica: bob.fed.replica, seq: op.seq, reason: 'revoked' },
    ]);
    expect(parked(ada)).toBe(0);
  });

  it("publishes nothing from an observer's machine", async () => {
    open = await foundedTeamWith(
      { docs: true, observers: ['bob'] },
      'ada',
      'bob'
    );
    const [ada, bob] = open as [MessagingReplica, MessagingReplica];
    port(bob).pending = [marker('watcher')];
    await ada.settleWith(bob);
    expect(port(bob).publishedBatches).toEqual([]);
    expect(port(ada).seen).toEqual([]);
  });
});
