import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryRemote } from './helpers/memoryTransport.js';
import { foundedTeam, messagingReplica } from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';
import { MemoryV1 } from './helpers/serviceReplica.js';

let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const fp = async (r: MessagingReplica) => {
  const { fingerprint } = await import('@dispatch-foo/protocol/federation');
  return fingerprint(r.fed.keys.signPub, r.fed.keys.sealPub);
};

describe('channels across daemons', () => {
  it('converges concurrent joins and leaves last-writer-wins per member', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).engine.join('ops', 'human:ada');
    at(1).engine.join('ops', 'human:bob');
    await at(0).settleWith(at(1));
    await at(1).settleWith(at(0));
    expect(at(0).messages.members('ops')).toEqual(['human:ada', 'human:bob']);
    expect(at(1).messages.members('ops')).toEqual(['human:ada', 'human:bob']);
    at(1).clock.now = new Date(at(1).clock.now.getTime() + 1000);
    at(1).engine.leave('ops', 'human:ada');
    await at(0).settleWith(at(1));
    expect(at(0).messages.members('ops')).toEqual(['human:bob']);
  });

  it('publishes no membership while the founding pin is not firm', async () => {
    open = await foundedTeam('ada', 'bob');
    at(1).fed.setMeta('founder_pin', 'auto');
    const before = at(1).fed.head()?.seq;
    at(1).engine.join('ops', 'human:bob');
    at(1).channels.collect();
    expect(at(1).fed.head()?.seq).toBe(before);
  });

  it('keeps the newer of a join and a leave made concurrently', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).engine.join('ops', 'human:cy');
    await at(1).settleWith(at(0));
    // Bob leaves cy first; ada re-joins cy a second later, before either syncs.
    at(1).engine.leave('ops', 'human:cy');
    at(0).clock.now = new Date(at(0).clock.now.getTime() + 1000);
    at(0).engine.leave('ops', 'human:cy');
    at(0).engine.join('ops', 'human:cy');
    await at(0).service.syncNow();
    await at(1).service.syncNow();
    await at(0).service.syncNow();
    for (const r of open)
      expect(r.messages.members('ops')).toEqual(['human:cy']);
  });

  it('seeds memberships that predate the founding and never deletes a local row', async () => {
    const remote = new MemoryRemote();
    const v1 = new MemoryV1();
    const ada = messagingReplica('ada', remote, v1);
    const bob = messagingReplica('bob', remote, v1);
    open.push(ada, bob);
    ada.engine.join('design', 'human:ada');
    bob.engine.join('notes', 'human:bob');
    ada.roster.found('acme');
    await bob.settleWith(ada);
    await ada.settleWith(bob);
    ada.roster.admit(bob.fed.replica, { fingerprint: await fp(bob) });
    for (let i = 0; i < 3; i++) {
      await ada.settleWith(bob);
      await bob.settleWith(ada);
    }
    expect(ada.messages.members('design')).toEqual(['human:ada']);
    expect(bob.messages.members('design')).toEqual(['human:ada']);
    expect(ada.messages.members('notes')).toEqual(['human:bob']);
  });

  it('never publishes an a2a or overseer membership, and refuses one arriving', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).messages.ensureChannel('ops', '2026-09-26T00:00:00.000Z', false);
    at(0).messages.addMember(
      'ops',
      'agent:ada/overseer',
      '2026-09-26T00:00:00.000Z'
    );
    at(0).engine.join('ops', 'agent:ada/a2a.acme');
    await at(1).settleWith(at(0));
    expect(at(1).messages.members('ops')).toEqual([]);
    const log = JSON.stringify(at(0).remote.logs.get(at(0).fed.replica) ?? []);
    expect(log).not.toContain('overseer');
    expect(log).not.toContain('a2a.acme');
    at(0).fed.append({
      type: 'channel',
      body: { channel: 'ops', member: 'agent:ada/overseer', joined: true },
    });
    await at(1).settleWith(at(0));
    expect(at(1).messages.members('ops')).toEqual([]);
    expect(
      at(1)
        .fed.problems()
        .some((p) => p.message.includes('agent:ada/overseer'))
    ).toBe(true);
  });
});
