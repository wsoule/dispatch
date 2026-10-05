import { afterEach, describe, expect, it } from 'bun:test';

import type { ApiContext } from '../../../src/api.js';
import { handleFederationRoute } from '../../../src/team/federation/routes.js';
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
// The live execute run fed_runs binds for a task, whatever its assignment.
const liveRun = (r: MessagingReplica, task: string) =>
  r.fed.db
    .query<{ run: string; replica: string }, [string]>(
      "SELECT run, replica FROM fed_runs WHERE task = ? AND run_kind = 'execute' AND live = 1 ORDER BY hlc LIMIT 1"
    )
    .get(task);
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

  // FW-R31(4) for every publish: nothing goes to a team this machine is
  // not firmly in.
  it('publishes no presence while the founding pin is not firm', async () => {
    open = await foundedTeam('ada', 'bob');
    at(1).fed.setMeta('founder_pin', 'auto');
    const before = at(1).fed.head()?.seq;
    at(1).startRun({ id: 'r-0000000000b1', taskId: null, kind: 'review' });
    at(1).presence.collect(
      new Date(at(1).clock.now.getTime() + 2 * 60 * 60 * 1000)
    );
    expect(at(1).fed.head()?.seq).toBe(before);
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
    expect(liveRun(at(0), 't-00000a01')?.replica).toBe(at(1).fed.replica);
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

  // A conflict is not a race to post next: a later update from one claimant
  // alone binds nothing until the conflict settles.
  it('keeps a conflicted run unbound until all but one claimant is revoked', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const run = 'r-0000000000ac';
    at(1).startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    at(2).startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    await at(1).service.syncNow();
    await at(2).service.syncNow();
    await at(0).service.syncNow();
    expect(at(0).hooks.remoteRunTask(run)).toBeNull();
    // Bob alone posts again: still conflicted.
    at(1).presence.waitingOn(run, 'ada');
    await at(0).settleWith(at(1));
    expect(at(0).hooks.remoteRunTask(run)).toBeNull();
    expect(liveRun(at(0), 't-00000a01')).toBeNull();
    // Cy is revoked: bob's next update binds it.
    at(0).roster.revoke(at(2).fed.replica, 'claimed a run it does not run');
    await at(0).service.syncNow();
    at(1).presence.waitingOn(run, null);
    await at(0).settleWith(at(1));
    expect(at(0).hooks.remoteRunTask(run)).toBe('t-00000a01');
  });

  // An admin settles a conflict by naming the claimant, with no revocation;
  // every replica binds the run to it, and a non-admin cannot.
  it('lets an admin resolve a run conflict to one claimant, on every machine', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const run = 'r-0000000000ad';
    at(1).startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    at(2).startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    for (const r of [at(1), at(2), at(0), at(1), at(2)])
      await r.service.syncNow();
    expect(at(0).hooks.remoteRunTask(run)).toBeNull();
    // Bob holds its own claim; cy's was refused there and kept.
    expect(liveRun(at(1), 't-00000a01')?.replica).toBe(at(1).fed.replica);
    // Cy is no admin: its resolution is refused at once.
    expect(() => at(2).presence.resolve(run, at(2).fed.replica)).toThrow(
      /admin/
    );
    at(0).presence.resolve(run, at(2).fed.replica);
    expect(at(0).hooks.remoteRunTask(run)).toBe('t-00000a01');
    await at(1).settleWith(at(0));
    expect(liveRun(at(1), 't-00000a01')?.replica).toBe(at(2).fed.replica);
    expect(
      at(1)
        .fed.problems()
        .some((p) => p.subject === `run-conflict:${run}`)
    ).toBe(false);
  });

  it('ignores a resolution published by a machine that is not an admin', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const run = 'r-0000000000ae';
    at(1).startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    at(2).startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    await at(1).service.syncNow();
    await at(2).service.syncNow();
    await at(0).service.syncNow();
    at(2).fed.append({
      type: 'presence',
      body: { kind: 'resolve', run, replica: at(2).fed.replica },
    });
    await at(0).settleWith(at(2));
    expect(at(0).hooks.remoteRunTask(run)).toBeNull();
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

  it('says whom a run waits on while its blocking question is open', async () => {
    open = await foundedTeam('ada', 'bob');
    at(0).startRun({
      id: 'r-0000000000a1',
      taskId: 't-00000a01',
      kind: 'execute',
    });
    const { message: q } = await at(0).engine.send(
      { to: ['human:bob'], kind: 'question', blocking: true, body: 'which?' },
      { address: 'run:r-0000000000a1', canDecide: false }
    );
    await at(1).settleWith(at(0));
    const waiting = () =>
      at(1)
        .fed.db.query<{ waiting_on: string | null }, [string]>(
          'SELECT waiting_on FROM fed_runs WHERE run = ?'
        )
        .get('r-0000000000a1')?.waiting_on;
    expect(waiting()).toBe('bob');
    await at(1).engine.reply(
      q.id,
      { body: 'that one' },
      { address: 'human:bob', canDecide: true }
    );
    await at(0).settleWith(at(1));
    await at(1).settleWith(at(0));
    expect(waiting()).toBeNull();
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
    expect(liveRun(at(1), 't-00000a03')?.run).toBe('r-0000000000af');
    // A restart: r-…af is no longer live on ada's host, so a collect ends it.
    at(0).host.endRun('t-00000a03');
    at(0).presence.collect(at(0).clock.now);
    at(0).presence.runEnded({
      id: 'r-0000000000ae',
      taskId: 't-00000a02',
      kind: 'execute',
    });
    await at(1).settleWith(at(0));
    expect(liveRun(at(1), 't-00000a02')).toBeNull();
    expect(liveRun(at(1), 't-00000a03')).toBeNull();
  });
});

describe('POST /api/team/runs/:run/resolve', () => {
  it('resolves a run conflict for an admin, and refuses a run with none', async () => {
    open = await foundedTeam('ada', 'bob', 'cy');
    const run = 'r-0000000000af';
    at(1).startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    at(2).startRun({ id: run, taskId: 't-00000a01', kind: 'execute' });
    for (const r of [at(1), at(2), at(0)]) await r.service.syncNow();
    const ada = at(0);
    const ctx = {
      caller: { tier: 'decide' },
      boardSync: ada.service,
      federation: {
        roster: ada.roster,
        fed: ada.fed,
        now: () => ada.clock.now,
        label: (r: string) => ada.roster.label(r),
        passWaitMs: 5000,
        resolveRun: (id: string, replica: string) => {
          ada.presence.resolve(id, replica);
        },
      },
    } as unknown as ApiContext;
    const post = (path: string, body: unknown) =>
      handleFederationRoute(
        new Request(`http://127.0.0.1${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        ctx,
        path.split('/').slice(2),
        'POST'
      );
    const res = await post(`/api/team/runs/${run}/resolve`, {
      replica: at(1).fed.replica,
    });
    expect(res.status).toBe(200);
    expect(ada.hooks.remoteRunTask(run)).toBe('t-00000a01');
    const none = await post('/api/team/runs/r-0000000000b0/resolve', {
      replica: at(1).fed.replica,
    });
    expect(none.status).toBe(400);
  });
});

describe('GET /api/team/presence?task=', () => {
  it("names the machine a task's live run is on and whom it waits on", async () => {
    open = await foundedTeam('ada', 'bob');
    const ada = at(0);
    const task = ada.store.create({ title: 'run on bob', assignee: 'human' })
      .meta.id;
    await at(1).settleWith(ada);
    at(1).startRun({ id: 'r-0000000000b9', taskId: task, kind: 'execute' });
    at(1).presence.waitingOn('r-0000000000b9', 'ada');
    await ada.settleWith(at(1));
    const ctx = {
      caller: { tier: 'decide' },
      boardSync: ada.service,
      federation: {
        roster: ada.roster,
        fed: ada.fed,
        label: (r: string) => ada.roster.label(r),
        presenceOf: (task: string) => ada.presence.presenceOf(task, ada.homes),
      },
    } as unknown as ApiContext;
    const get = async (task: string): Promise<unknown> =>
      (
        await handleFederationRoute(
          new Request(`http://127.0.0.1/api/team/presence?task=${task}`),
          ctx,
          ['team', 'presence'],
          'GET'
        )
      ).json();
    expect(await get(task)).toEqual({
      presence: {
        replica: at(1).fed.replica,
        handle: 'bob',
        device: 'bob-laptop',
      },
      waitingOn: 'ada',
    });
    expect(await get('t-00000aff')).toEqual({
      presence: null,
      waitingOn: null,
    });
  });
});
