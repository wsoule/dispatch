import { isStub } from '@dispatch-foo/protocol/federation';
import type { FederatedOp } from '@dispatch-foo/protocol/federation';
import { decayStore, memoryHandle, newMemoryEntry } from '@dispatch/memory';
import type { MemoryEntry, Principal } from '@dispatch/memory';
import { afterEach, describe, expect, it } from 'bun:test';

import { arrivalTrust } from '../../../src/team/federation/memory.js';
import { foundedTeamWith } from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';

// Team memory between daemons (T20, the F3 exit): signed `memory` ops.
let open: MessagingReplica[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
});
const at = (i: number): MessagingReplica => open[i];
const mem = (r: MessagingReplica) => {
  if (r.memory === undefined) throw new Error('no memory on this replica');
  return r.memory;
};
const human = (h: string): Principal => ({
  address: `human:${h}`,
  canDecide: true,
  kind: 'human',
});
const AGENT: Principal = {
  address: 'agent:ada/codex',
  canDecide: false,
  kind: 'agent',
};
const AUTO = {
  mode: 'auto',
  gate: 'memory',
  rung: 4,
  authorizedBy: 'rung',
} as const;
const memoryOps = (r: MessagingReplica) =>
  (r.remote.logs.get(r.fed.replica) ?? []).filter(
    (o): o is FederatedOp => o.type === 'memory' && !isStub(o)
  );
const entryOf = (r: MessagingReplica, id: string): MemoryEntry | null =>
  mem(r).shared.getEntry(id);

async function save(
  r: MessagingReplica,
  who: Principal,
  title: string,
  kind: 'fact' | 'hazard' = 'fact'
): Promise<string> {
  const out = await mem(r).engine.save(who, {
    scope: 'team',
    kind,
    title,
    body: `${title}, in full.`,
  });
  if (out.status !== 'active') throw new Error(`not saved: ${out.status}`);
  return out.id;
}

// A memory op `from` signs, as a forged or hand-written publisher would.
function forge(
  from: MessagingReplica,
  memory: string,
  fields: Record<string, unknown>,
  trust: 'human' | 'confirmed' | 'agent',
  by?: string
): void {
  from.fed.append({
    type: 'memory',
    body: {
      memory,
      kind: 'put',
      fields,
      trust,
      ...(by === undefined ? {} : { by }),
    } as never,
  });
}

const FULL = (title: string, author: string) => ({
  title,
  body: 'b',
  kind: 'fact',
  refs: [],
  epic: null,
  appliesTo: [],
  pinned: false,
  status: 'active',
  statusReason: null,
  supersedes: null,
  supersededBy: null,
  author,
  createdAt: '2026-09-26T09:00:00.000Z',
  decidedBy: null,
  decidedByPolicy: null,
});
const ID = 'mem-01K6000000000000000000000A';

describe('trust on arrival (Q10)', () => {
  it("keeps a human's trust only from a machine that speaks for them", async () => {
    open = await foundedTeamWith({}, 'ada', 'bob');
    const view = at(0).roster.view();
    if (view === null) throw new Error('no view');
    const [a, b] = [at(0).fed.replica, at(1).fed.replica];
    const base = {
      decidedBy: null,
      seq: 9,
      view,
      held: null,
      contentChanged: true,
    };
    expect(
      arrivalTrust({
        ...base,
        asserted: 'human',
        author: 'human:ada',
        publisher: a,
      })
    ).toBe('human');
    expect(
      arrivalTrust({
        ...base,
        asserted: 'human',
        author: 'human:ada',
        publisher: b,
      })
    ).toBe('agent');
    expect(
      arrivalTrust({
        ...base,
        asserted: 'confirmed',
        author: 'run:r-0000000000aa',
        decidedBy: 'human:bob',
        publisher: b,
      })
    ).toBe('confirmed');
    expect(
      arrivalTrust({
        ...base,
        asserted: 'confirmed',
        author: 'run:r-0000000000aa',
        decidedBy: 'human:bob',
        publisher: a,
      })
    ).toBe('agent');
  });

  it('never lowers held trust on a change that leaves the content alone', async () => {
    open = await foundedTeamWith({}, 'ada', 'bob');
    const view = at(0).roster.view();
    if (view === null) throw new Error('no view');
    const input = {
      asserted: 'agent' as const,
      author: 'human:ada' as const,
      decidedBy: null,
      publisher: at(1).fed.replica,
      seq: 9,
      view,
      held: 'human' as const,
    };
    expect(arrivalTrust({ ...input, contentChanged: false })).toBe('human');
    expect(arrivalTrust({ ...input, contentChanged: true })).toBe('agent');
  });
});

describe('team memory between daemons (the F3 exit)', () => {
  it('replicates a human-trust team entry under its id, keeping its trust', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    const id = await save(at(0), human('ada'), 'deploys freeze on Fridays');
    await at(1).settleWith(at(0));
    expect(entryOf(at(1), id)).toMatchObject({
      title: 'deploys freeze on Fridays',
      trust: 'human',
      author: 'human:ada',
      scope: 'team',
    });
    expect(mem(at(1)).shared.revisions(id).at(-1)?.cause).toBe('sync');
    // A synced revision is never published back.
    await at(1).service.syncNow();
    expect(memoryOps(at(1))).toEqual([]);
  });

  it('carries an edit and a retire, field by field', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    const id = await save(at(0), human('ada'), 'old title');
    await at(1).settleWith(at(0));
    await mem(at(0)).engine.edit(human('ada'), id, { title: 'new title' });
    await at(1).settleWith(at(0));
    expect(entryOf(at(1), id)?.title).toBe('new title');
    expect(memoryOps(at(0)).at(-1)?.body).toMatchObject({
      fields: { title: 'new title' },
    });
    const last = memoryOps(at(0)).at(-1)?.body as
      | { fields: object }
      | undefined;
    expect(Object.keys(last?.fields ?? {})).toEqual(['title']);
    await mem(at(0)).engine.forget(human('ada'), id, 'wrong');
    await at(1).settleWith(at(0));
    expect(entryOf(at(1), id)).toMatchObject({
      status: 'retired',
      statusReason: 'forgotten',
    });
  });

  it('merges concurrent edits per field, the later clock winning each', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    const id = await save(at(0), human('ada'), 'shared title');
    await at(1).settleWith(at(0));
    await mem(at(0)).engine.edit(human('ada'), id, {
      title: 'ada title',
      body: 'ada body',
    });
    await at(0).service.syncNow();
    for (const r of open) r.clock.now = new Date(r.clock.now.getTime() + 1000);
    // Bob edits before he has seen ada's change.
    await mem(at(1)).engine.edit(human('bob'), id, { body: 'bob body' });
    for (let i = 0; i < 2; i++) {
      await at(1).settleWith(at(0));
      await at(0).settleWith(at(1));
    }
    for (const r of open)
      expect(entryOf(r, id)).toMatchObject({
        title: 'ada title',
        body: 'bob body',
      });
  });

  it('lowers a teammate asserting someone else’s human trust to agent', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob', 'cy');
    mem(at(2)).host.ruling = AUTO;
    forge(at(1), ID, FULL('forged as ada', 'human:ada'), 'human');
    await at(2).settleWith(at(1));
    expect(entryOf(at(2), ID)).toMatchObject({
      title: 'forged as ada',
      trust: 'agent',
    });
  });

  it('keeps held trust across a non-content change, and lowers it on a content change', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob', 'cy');
    const id = await save(at(0), human('ada'), 'held at human');
    await at(2).settleWith(at(0));
    expect(entryOf(at(2), id)?.trust).toBe('human');
    // Cy's policy would approve these, so they apply.
    mem(at(2)).host.ruling = AUTO;
    for (const r of open) r.clock.now = new Date(r.clock.now.getTime() + 1000);
    forge(at(1), id, { pinned: true }, 'agent');
    await at(2).settleWith(at(1));
    expect(entryOf(at(2), id)).toMatchObject({ pinned: true, trust: 'human' });
    forge(at(1), id, { body: 'rewritten by bob' }, 'human');
    await at(2).settleWith(at(1));
    expect(entryOf(at(2), id)).toMatchObject({
      body: 'rewritten by bob',
      trust: 'agent',
    });
  });

  it('re-gates a policy-approved entry under a stricter local policy, keeping its id on approval', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    mem(ada).host.ruling = AUTO;
    mem(bob).host.ruling = { mode: 'block' };
    mem(bob).host.raise = () => Promise.resolve('m-0000000gate');
    const id = await save(
      ada,
      AGENT,
      'pnpm 11 ignores onlyBuiltDependencies',
      'hazard'
    );
    await bob.settleWith(ada);
    await Promise.resolve();
    expect(entryOf(bob, id)).toBeNull();
    const [p] = mem(bob).shared.listProposals({ states: ['open'] });
    expect(p).toMatchObject({
      action: 'add',
      scope: 'team',
      origin: `sync:${ada.fed.replica}:${id}`,
      author: 'agent:ada/codex',
      gate: 'm-0000000gate',
    });
    // A later change updates the open proposal.
    await mem(ada).engine.edit(human('ada'), id, { body: 'use allowBuilds' });
    await bob.settleWith(ada);
    expect(mem(bob).shared.getProposal(p.id)?.content?.body).toBe(
      'use allowBuilds'
    );
    mem(bob).engine.applyGateAnswer({
      proposalId: p.id,
      gateId: 'm-0000000gate',
      choice: 'approve',
      by: 'human:bob',
      reason: '',
      expired: false,
    });
    expect(entryOf(bob, id)).toMatchObject({
      body: 'use allowBuilds',
      trust: 'confirmed',
    });
  });

  it('applies a policy-approved entry when local policy would approve it too', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    mem(ada).host.ruling = AUTO;
    mem(bob).host.ruling = AUTO;
    const id = await save(ada, AGENT, 'auto both sides', 'hazard');
    await bob.settleWith(ada);
    expect(entryOf(bob, id)).toMatchObject({ trust: 'agent' });
    expect(mem(bob).shared.listProposals()).toEqual([]);
  });

  it('never publishes personal or project entries, proposals, or decay', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    const ada = at(0);
    mem(ada).host.operators.set('human:ada', {
      human: 'human:ada',
      identity: 'self',
    });
    await mem(ada).engine.save(human('ada'), {
      scope: 'personal',
      kind: 'preference',
      title: 'terse comments',
      body: 'b',
    });
    await mem(ada).engine.save(human('ada'), {
      scope: 'project',
      kind: 'fact',
      title: 'only this project',
      body: 'b',
    });
    mem(ada).host.ruling = { mode: 'block' };
    mem(ada).host.raise = () => Promise.resolve('m-0000000gate');
    await mem(ada).engine.save(AGENT, {
      scope: 'team',
      kind: 'hazard',
      title: 'only a proposal',
      body: 'b',
    });
    await ada.service.syncNow();
    expect(memoryOps(ada)).toEqual([]);
    await save(ada, human('ada'), 'shared');
    await ada.service.syncNow();
    expect(memoryOps(ada)).toHaveLength(1);
    decayStore(mem(ada).shared, {
      now: new Date('2027-09-26T00:00:00.000Z'),
      staleAfterDays: 60,
      retireAfterDays: 180,
    });
    await ada.service.syncNow();
    expect(memoryOps(ada)).toHaveLength(1);
  });

  it('publishes team entries that predate the team once it is in', async () => {
    open = await foundedTeamWith(
      { withMemory: true, memoryFirst: ['ada'] },
      'ada',
      'bob'
    );
    const [ada, bob] = [at(0), at(1)];
    const [early] = mem(ada).shared.listEntries({ scopes: ['team'] });
    expect(early).toBeDefined();
    await bob.settleWith(ada);
    expect(entryOf(bob, early.id)?.title).toBe(early.title);
  });

  it('drops a memory op over the producer limits, with a note', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    forge(at(1), ID, FULL('t'.repeat(201), 'human:bob'), 'human', 'human:bob');
    await at(0).settleWith(at(1));
    expect(entryOf(at(0), ID)).toBeNull();
    expect(
      at(0)
        .fed.problems()
        .some((p) => p.subject === `malformed:${at(1).fed.replica}`)
    ).toBe(true);
  });

  it('drops a memory op that is not a valid entry, with a note', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    forge(at(1), 'not-an-id', FULL('x', 'human:bob'), 'human');
    forge(at(1), ID, { ...FULL('', 'human:bob') }, 'human');
    await at(0).settleWith(at(1));
    expect(entryOf(at(0), ID)).toBeNull();
    expect(
      at(0)
        .fed.problems()
        .some((p) => p.subject === `malformed:${at(1).fed.replica}`)
    ).toBe(true);
  });
});

const POLICY = { rung: 4, authorizedBy: 'rung' } as const;

describe('remote memory never skips local policy (FW-R37(1))', () => {
  it('re-gates a policy-decided rewrite of a held entry, applying it in place on approval', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    mem(bob).host.raise = () => Promise.resolve('m-0000000gate');
    const id = await save(ada, human('ada'), 'held here');
    await bob.settleWith(ada);
    expect(entryOf(bob, id)?.title).toBe('held here');
    for (const r of open) r.clock.now = new Date(r.clock.now.getTime() + 1000);
    forge(
      ada,
      id,
      { body: 'rewritten by policy', decidedByPolicy: POLICY },
      'agent',
      'agent:dispatch'
    );
    await bob.settleWith(ada);
    await Promise.resolve();
    expect(entryOf(bob, id)?.body).toBe('held here, in full.');
    const [p] = mem(bob).shared.listProposals({ states: ['open'] });
    expect(p).toMatchObject({ action: 'supersede', target: id });
    mem(bob).engine.applyGateAnswer({
      proposalId: p.id,
      gateId: 'm-0000000gate',
      choice: 'approve',
      by: 'human:bob',
      reason: '',
      expired: false,
    });
    await bob.service.syncNow();
    expect(entryOf(bob, id)).toMatchObject({
      id,
      body: 'rewritten by policy',
      status: 'active',
      trust: 'confirmed',
    });
    expect(
      mem(bob)
        .shared.listEntries({ scopes: ['team'] })
        .map((e) => e.id)
    ).toEqual([id]);
  });

  it('re-gates a forged entry with no decider, which never activates', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob', 'cy');
    mem(at(2)).host.raise = () => Promise.resolve('m-0000000gate');
    forge(
      at(1),
      ID,
      { ...FULL('rm -rf is safe here', 'human:ada'), kind: 'hazard' },
      'human',
      'human:ada'
    );
    await at(2).settleWith(at(1));
    expect(entryOf(at(2), ID)).toBeNull();
    expect(mem(at(2)).host.activated).toEqual([]);
    expect(mem(at(2)).shared.listProposals({ states: ['open'] })).toHaveLength(
      1
    );
  });

  it('re-gates a pin from a machine that speaks for no human behind it', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob', 'cy');
    mem(at(2)).host.raise = () => Promise.resolve('m-0000000gate');
    const id = await save(at(0), human('ada'), 'not to be pinned');
    await at(2).settleWith(at(0));
    for (const r of open) r.clock.now = new Date(r.clock.now.getTime() + 1000);
    forge(at(1), id, { pinned: true }, 'agent', 'human:ada');
    await at(2).settleWith(at(1));
    expect(entryOf(at(2), id)?.pinned).toBe(false);
    expect(
      mem(at(2)).shared.listProposals({ states: ['open'] })[0]?.reason
    ).toContain('pinned');
  });

  it("never lets a policy-approved change ride a later human edit's by", async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    const [ada, bob] = [at(0), at(1)];
    mem(bob).host.raise = () => Promise.resolve('m-0000000gate');
    const id = await save(ada, human('ada'), 'retired by policy');
    await bob.settleWith(ada);
    // Ada's agent retires it under her auto policy, then she pins it.
    mem(ada).host.ruling = AUTO;
    await mem(ada).engine.forget(AGENT, id, 'stale');
    mem(ada).engine.setPinned(human('ada'), id, true);
    expect(entryOf(ada, id)).toMatchObject({ status: 'retired', pinned: true });
    await bob.settleWith(ada);
    expect(entryOf(bob, id)?.status).toBe('active');
    expect(mem(bob).shared.listProposals({ states: ['open'] })).toHaveLength(1);
  });

  it("gates a teammate's change of author or supersededBy (minor 2)", async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob', 'cy');
    for (const r of open)
      mem(r).host.raise = () => Promise.resolve('m-0000000gate');
    const id = await save(at(0), human('ada'), 'whose is it');
    await at(2).settleWith(at(0));
    for (const r of open) r.clock.now = new Date(r.clock.now.getTime() + 1000);
    forge(at(1), id, { author: 'human:bob' }, 'agent', 'human:ada');
    await at(2).settleWith(at(1));
    expect(entryOf(at(2), id)?.author).toBe('human:ada');
    expect(mem(at(2)).shared.listProposals({ states: ['open'] })).toHaveLength(
      1
    );
    const other = await save(at(0), human('ada'), 'superseded or not');
    await at(2).settleWith(at(0));
    for (const r of open) r.clock.now = new Date(r.clock.now.getTime() + 1000);
    forge(at(1), other, { supersededBy: ID }, 'agent', 'human:ada');
    await at(2).settleWith(at(1));
    expect(entryOf(at(2), other)?.supersededBy).toBeNull();
  });

  it("applies a teammate's own human edit without a gate", async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    const id = await save(at(0), human('ada'), 'edited by bob');
    await at(1).settleWith(at(0));
    await mem(at(1)).engine.edit(human('bob'), id, { body: 'bob says so' });
    await at(0).settleWith(at(1));
    expect(entryOf(at(0), id)?.body).toBe('bob says so');
    expect(mem(at(0)).shared.listProposals()).toEqual([]);
  });
});

describe('per-publisher memory caps (FW-R37(3))', () => {
  it('holds sync proposals past the open cap, with a note', async () => {
    open = await foundedTeamWith(
      { withMemory: true, memoryOpenProposals: 2 },
      'ada',
      'bob'
    );
    mem(at(0)).host.raise = () => Promise.resolve('m-0000000gate');
    for (let i = 0; i < 3; i++)
      forge(
        at(1),
        `mem-01K60000000000000000000${String(i).padStart(3, '0')}`,
        {
          ...FULL(`policy entry ${i}`, 'run:r-0000000000bb'),
          decidedByPolicy: POLICY,
        },
        'agent'
      );
    await at(0).settleWith(at(1));
    expect(mem(at(0)).shared.listProposals({ states: ['open'] })).toHaveLength(
      2
    );
    expect(
      at(0)
        .fed.problems()
        .some((p) => p.subject === `memory-cap:${at(1).fed.replica}`)
    ).toBe(true);
  });

  it('holds new team entries past the hourly cap until the next hour', async () => {
    open = await foundedTeamWith(
      { withMemory: true, memoryNewPerHour: 2 },
      'ada',
      'bob'
    );
    for (let i = 0; i < 3; i++)
      await save(at(1), human('bob'), `bob's entry ${i}`);
    await at(0).settleWith(at(1));
    expect(mem(at(0)).shared.listEntries({ scopes: ['team'] })).toHaveLength(2);
    expect(
      at(0)
        .fed.problems()
        .some((p) => p.subject === `memory-quota:${at(1).fed.replica}`)
    ).toBe(true);
    for (const r of open)
      r.clock.now = new Date(r.clock.now.getTime() + 61 * 60_000);
    await at(0).service.syncNow();
    expect(mem(at(0)).shared.listEntries({ scopes: ['team'] })).toHaveLength(3);
  });

  it('names a handle collision instead of leaving it silent', async () => {
    open = await foundedTeamWith({ withMemory: true }, 'ada', 'bob');
    const local = newMemoryEntry(
      {
        scope: 'team',
        kind: 'fact',
        title: 'mine',
        body: 'b',
        author: 'human:ada',
        trust: 'human',
      },
      'mem-01K6000000000000000000000Z',
      '2026-09-26T09:00:00.000Z'
    );
    mem(at(0)).shared.insertEntry(
      { ...local, handle: memoryHandle(ID) },
      'human:ada',
      'save'
    );
    forge(at(1), ID, FULL('collides', 'human:bob'), 'human', 'human:bob');
    await at(0).settleWith(at(1));
    expect(entryOf(at(0), ID)).toBeNull();
    expect(
      at(0)
        .fed.problems()
        .some((p) => p.subject === `memory:${ID}`)
    ).toBe(true);
  });
});
