import type { Message } from '@dispatch-foo/protocol';
import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryRemote } from './helpers/memoryTransport.js';
import {
  foundedTeam,
  foundedTeamWith,
  messagingReplica,
} from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';
import { MemoryV1 } from './helpers/serviceReplica.js';

let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
async function team(...handles: string[]): Promise<MessagingReplica[]> {
  open = await foundedTeam(...handles);
  return open;
}
const at = (i: number): MessagingReplica => open[i];
const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm-01',
  thread: 'm-01',
  replyTo: null,
  from: 'human:ada',
  to: ['human:bob'],
  kind: 'message',
  body: 'x',
  refs: [],
  urgent: false,
  blocking: false,
  wake: 'none',
  createdAt: '2026-09-26T10:00:00.000Z',
  ...over,
});
const direct = (recipient: string) => ({ recipient, via: 'direct' as const });

describe('homes', () => {
  it('homes a human on their admitted replicas', async () => {
    await team('ada', 'bob');
    expect(at(0).homes.of('human:bob')).toEqual([at(1).fed.replica]);
    expect(at(0).homes.of('human:ada')).toEqual([at(0).fed.replica]);
    expect(at(0).homes.of('human:nobody')).toEqual([]);
  });

  it('never homes anyone on an observer, not even its own handle', async () => {
    open = await foundedTeamWith({ observers: ['ops'] }, 'ada', 'ops');
    expect(at(0).homes.of('human:ops')).toEqual([]);
  });

  it("homes a task on its live execute run's machine, among its assignee's, else on all of them", async () => {
    await team('ada', 'bob', 'bob');
    const id = at(0).store.create({ title: 'homed', assignee: 'human:bob' })
      .meta.id;
    await at(1).settleWith(at(0));
    await at(2).settleWith(at(0));
    expect(at(0).homes.of(`task:${id}`)).toEqual(
      [at(1).fed.replica, at(2).fed.replica].sort()
    );
    at(2).startRun({ id: 'r-0000000000aa', taskId: id, kind: 'execute' });
    await at(0).settleWith(at(2));
    expect(at(0).homes.of(`task:${id}`)).toEqual([at(2).fed.replica]);
  });
});

describe('placement', () => {
  it('places a DM to a teammate remote and one to myself local', async () => {
    await team('ada', 'bob');
    expect(at(0).hooks.placement(direct('human:bob'), msg(), null)).toEqual({
      kind: 'remote',
      homes: [at(1).fed.replica],
      alsoLocal: false,
    });
    expect(
      at(0).hooks.placement(
        direct('human:ada'),
        msg({ to: ['human:ada'] }),
        null
      )
    ).toEqual({ kind: 'local' });
  });

  it('refuses local-only messages that have no local home', async () => {
    await team('ada', 'bob');
    const overseer = msg({ to: ['human:bob', 'agent:ada/overseer'] });
    expect(
      at(0).hooks.placement(direct('human:bob'), overseer, null).kind
    ).toBe('refuse');
    expect(at(0).hooks.placement(direct('human:ada'), overseer, null)).toEqual({
      kind: 'local',
    });
  });

  it('names one wakeAt: the live run, else the latest replica presence', async () => {
    // Cy is bob's second machine.
    await team('ada', 'bob', 'bob');
    const id = at(0).store.create({ title: 'shared', assignee: 'human:bob' })
      .meta.id;
    const wake = msg({ to: [`task:${id}`], wake: 'request' });
    const first = at(0).hooks.placement(direct(`task:${id}`), wake, null);
    expect(first).toMatchObject({ kind: 'remote' });
    expect([at(1).fed.replica, at(2).fed.replica]).toContain(
      (first as { wakeAt: string }).wakeAt
    );
    at(2).startRun({
      id: 'r-0000000000cc',
      taskId: id,
      kind: 'execute',
    });
    await at(0).settleWith(at(2));
    expect(
      at(0).hooks.placement(direct(`task:${id}`), wake, null)
    ).toMatchObject({ homes: [at(2).fed.replica], wakeAt: at(2).fed.replica });
  });

  it("routes a reply to a remote run's message to its origin, and a system notice to a run's presence replica", async () => {
    await team('ada', 'bob');
    const fromRun = msg({
      from: 'run:r-0000000000bb',
      origin: at(1).fed.replica,
      hlc: '1758880000000.0001.x',
    });
    expect(
      at(0).hooks.placement(
        direct('run:r-0000000000bb'),
        msg({ replyTo: 'm-01' }),
        fromRun
      )
    ).toEqual({ kind: 'remote', homes: [at(1).fed.replica], alsoLocal: false });
    at(1).startRun({
      id: 'r-0000000000bc',
      taskId: null,
      kind: 'review',
    });
    await at(0).settleWith(at(1));
    const notice = msg({
      from: 'agent:dispatch',
      kind: 'notice',
      to: ['run:r-0000000000bc'],
    });
    expect(
      at(0).hooks.placement(direct('run:r-0000000000bc'), notice, null)
    ).toEqual({ kind: 'remote', homes: [at(1).fed.replica], alsoLocal: false });
  });

  it('places everything local before a team is founded', () => {
    const solo = messagingReplica('solo');
    open.push(solo);
    expect(solo.hooks.placement(direct('human:bob'), msg(), null)).toEqual({
      kind: 'local',
    });
  });

  // FW-R31(4): a provisional founding pin is not a team to send mail into.
  it('keeps mail local on a machine not yet admitted under a firm pin', async () => {
    const remote = new MemoryRemote();
    const v1 = new MemoryV1();
    const ada = messagingReplica('ada', remote, v1);
    const bob = messagingReplica('bob', remote, v1);
    open.push(ada, bob);
    ada.roster.found('acme');
    await bob.settleWith(ada);
    expect(bob.roster.founded()).toBe(true);
    expect(
      bob.hooks.placement(direct('human:ada'), msg({ from: 'human:bob' }), null)
    ).toEqual({ kind: 'local' });
  });
});
