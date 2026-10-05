import { decayStore } from '@dispatch/memory';
import type { MemoryEntry, Principal } from '@dispatch/memory';
import { isStub } from '@dispatch/protocol/federation';
import type { FederatedOp } from '@dispatch/protocol/federation';
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
  trust: 'human' | 'confirmed' | 'agent'
): void {
  from.fed.append({
    type: 'memory',
    body: { memory, kind: 'put', fields, trust } as never,
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
