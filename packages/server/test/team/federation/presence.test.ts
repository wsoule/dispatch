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
const runCount = (r: MessagingReplica, kind: string) =>
  r.fed.db
    .query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM fed_audit WHERE kind = ?'
    )
    .get(kind)?.n;

describe('presence', () => {
  it('queues the live op when the run starts, before the run can send anything', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).presence.runStarted({
      id: 'r-0000000000aa',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    const last = at(0).fed.outbox().at(-1);
    expect(last?.type).toBe('presence');
    expect(last?.body).toMatchObject({
      kind: 'run',
      run: 'r-0000000000aa',
      live: true,
    });
  });

  // A pending replica's chain stays its key op then its first roster op
  // (a recover, say), all a reader reads of it: no presence in between.
  it('publishes nothing from a machine still pending', async () => {
    const remote = new MemoryRemote();
    const v1 = new MemoryV1();
    const ada = messagingReplica('ada', remote, v1);
    const bob = messagingReplica('bob', remote, v1);
    open.push(ada, bob);
    ada.roster.found('acme');
    await bob.settleWith(ada);
    await ada.settleWith(bob);
    expect(bob.fed.head()).not.toBeNull();
    bob.startRun({ id: 'r-0000000000ba', taskId: null, kind: 'review' });
    await bob.service.syncNow();
    expect(
      (remote.logs.get(bob.fed.replica) ?? []).map((e) => e.type)
    ).not.toContain('presence');
  });

  it('binds a run id to its first claimant and refuses a second claim with a problem', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    at(1).startRun({
      id: 'r-0000000000aa',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    await at(0).settleWith(at(1));
    at(2).startRun({
      id: 'r-0000000000aa',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    await at(0).settleWith(at(2));
    expect(at(0).hooks.remoteRunTask('r-0000000000aa')).toBe('t-00000a01');
    expect(at(0).homes.taskLiveRun('t-00000a01')?.replica).toBe(
      at(1).fed.replica
    );
    expect(
      at(0)
        .fed.problems()
        .some((p) =>
          p.message.includes(
            'claims run r-0000000000aa, already running on bob'
          )
        )
    ).toBe(true);
    expect(runCount(at(0), 'run-conflict')).toBe(1);
  });

  it('binds neither when one pull brings two first claims, and names both', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    at(1).startRun({
      id: 'r-0000000000ab',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    at(2).startRun({
      id: 'r-0000000000ab',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    await at(1).service.syncNow();
    await at(2).service.syncNow();
    await at(0).service.syncNow();
    expect(at(0).hooks.remoteRunTask('r-0000000000ab')).toBeNull();
    const p = at(0)
      .fed.problems()
      .find((x) => x.message.includes('r-0000000000ab'));
    expect(p?.message).toContain('bob');
    expect(p?.message).toContain('cy');
  });

  it('refuses a claim on a run this machine is running', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).host.startRun('t-00000a01', 'r-0000000000ad');
    at(1).startRun({
      id: 'r-0000000000ad',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    await at(0).settleWith(at(1));
    expect(at(0).hooks.remoteRunTask('r-0000000000ad')).toBeNull();
    expect(runCount(at(0), 'run-conflict')).toBe(1);
  });

  it("estimates each replica's clock skew from its replica presence", async () => {
    open = await foundedTeam('ada', 'bob');
    const hour = 60 * 60 * 1000;
    at(0).clock.now = new Date(at(0).clock.now.getTime() + hour);
    at(1).clock.now = new Date(at(1).clock.now.getTime() + hour + 3 * 60_000);
    await at(0).settleWith(at(1));
    const row = at(0)
      .fed.db.query<{ skew_ms: number }, [string]>(
        'SELECT skew_ms FROM fed_replicas WHERE replica = ?'
      )
      .get(at(1).fed.replica);
    expect(Math.round((row?.skew_ms ?? 0) / 60_000)).toBe(3);
  });

  it('marks a run ended, and ends a live run of its own that is no longer live after a restart', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).startRun({
      id: 'r-0000000000ae',
      taskId: 't-00000a02',
      kind: 'execute',
    });
    at(0).startRun({
      id: 'r-0000000000af',
      taskId: 't-00000a03',
      kind: 'execute',
    });
    await at(1).settleWith(at(0));
    expect(at(1).homes.taskLiveRun('t-00000a03')?.run).toBe('r-0000000000af');
    // A restart: r-…af is no longer live on ada's host, so a collect ends it.
    at(0).host.endRun('t-00000a03');
    at(0).presence.collect(at(0).clock.now);
    at(0).presence.runEnded({
      id: 'r-0000000000ae',
      taskId: 't-00000a02',
      kind: 'execute',
    });
    await at(1).settleWith(at(0));
    expect(at(1).homes.taskLiveRun('t-00000a02')).toBeNull();
    expect(at(1).homes.taskLiveRun('t-00000a03')).toBeNull();
  });
});
