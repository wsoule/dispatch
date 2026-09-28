import { DEFAULT_MEMORY } from '@dispatch/core';
import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryEngine } from '../src/engine.js';
import { MemoryError } from '../src/errors.js';
import { ADA, FakeMemoryHost, fakeStores, OWNER, RUN } from './fakeHost.js';

const AUTO = {
  mode: 'auto',
  gate: 'memory',
  rung: 4,
  authorizedBy: 'rung',
} as const;
const team = {
  scope: 'team',
  kind: 'hazard',
  title: 'pnpm 11 ignores onlyBuiltDependencies',
  body: 'use allowBuilds',
} as const;
// `team` as a validated write, the shape submitProposal takes.
const valid = (title: string = team.title) => ({
  ...team,
  title,
  refs: [],
  epic: null,
  appliesTo: [],
  projectKey: null,
});

function setup(overrides: Partial<typeof DEFAULT_MEMORY> = {}) {
  const host = new FakeMemoryHost();
  host.runTasks.set('r-9f2c01', 't-1a2b3c');
  host.tasks.set('t-1a2b3c', {
    taskId: 't-1a2b3c',
    title: 'x',
    body: '',
    writes: [],
    epic: null,
    risk: 'routine',
    a2a: false,
  });
  host.operators.set('run:r-9f2c01', { human: 'human:wyat', identity: 'self' });
  host.operators.set('human:wyat', { human: 'human:wyat', identity: 'self' });
  const s = fakeStores();
  const engine = new MemoryEngine({
    stores: s.stores,
    host,
    config: () => ({ ...DEFAULT_MEMORY, ...overrides }),
  });
  return { engine, host, ...s };
}

// The daemon itself, which authors every ledger cutover row.
const DISPATCH = {
  address: 'agent:dispatch',
  canDecide: false,
  kind: 'agent',
} as const;

// A ledger cutover row: the daemon's proposal, exempt from the limits.
const ledgerRow = (
  t: ReturnType<typeof setup>,
  origin: string,
  title: string = team.title
) =>
  t.engine.submitProposal(DISPATCH, {
    action: 'add',
    scope: 'team',
    content: valid(title),
    origin,
  });

type Gated = { proposal: string; gate: string };

// The owner approving a proposal from its gate.
const approve = (t: ReturnType<typeof setup>, p: Gated) =>
  t.engine.applyGateAnswer({
    proposalId: p.proposal,
    gateId: p.gate,
    choice: 'approve',
    by: 'human:wyat',
    reason: '',
    expired: false,
  });

async function conflictOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof MemoryError) return `${err.code}: ${err.message}`;
    throw err;
  }
  return 'ok';
}

describe('proposals', () => {
  it('blocks at rungs 1–3: an open proposal, a gate, and no entry', async () => {
    const t = setup();
    const out = await t.engine.save(RUN, team);
    expect(out).toEqual({
      status: 'proposed',
      proposal: expect.stringMatching(/^mp-/),
      gate: 'm-gate-1',
    });
    expect(t.shared.countEntries()).toBe(0);
    expect(t.engine.proposals(RUN).map((p) => p.state)).toEqual(['open']);
  });

  it('auto-approves at rung 4 with no gate, agent trust and a receipt', async () => {
    const t = setup();
    t.host.ruling = AUTO;
    const out = (await t.engine.save(RUN, team)) as { id: string };
    expect(t.host.gates).toEqual([]);
    expect(t.shared.getEntry(out.id)).toMatchObject({
      trust: 'agent',
      decidedByPolicy: { rung: 4, authorizedBy: 'rung' },
      decidedBy: null,
    });
    expect(t.host.approvals.map((a) => a.rung)).toEqual([4]);
    expect(t.host.activated.map((a) => a.authorRun)).toEqual(['r-9f2c01']);
  });

  it('reports an auto-approved retire as retired', async () => {
    const t = setup();
    const target = (await t.engine.save(OWNER, team)) as {
      id: string;
      handle: string;
    };
    t.host.ruling = AUTO;
    expect(await t.engine.forget(RUN, target.id, 'stale')).toEqual({
      status: 'retired',
      id: target.id,
      handle: target.handle,
    });
  });

  it('reports and announces an auto-approval whose receipt could not be written', async () => {
    const t = setup();
    t.host.ruling = AUTO;
    t.host.failing.add('recordPolicyApproval');
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await t.engine.save(RUN, team);
      const [entry] = t.shared.listEntries();
      expect(out).toEqual({
        status: 'active',
        id: entry.id,
        handle: entry.handle,
      });
      expect(t.host.changes).toEqual([{ scope: 'team', id: entry.id }]);
      expect(t.host.activated.map((a) => a.entry.id)).toEqual([entry.id]);
      expect(String(errors.mock.calls[0]?.[0])).toContain('receipt');
    } finally {
      errors.mockRestore();
    }
  });

  it('never auto-approves content matching a personal entry of the operator', async () => {
    const t = setup();
    t.host.ruling = AUTO;
    await t.engine.save(OWNER, {
      ...team,
      scope: 'personal',
      kind: 'fact',
      title: '  PNPM 11 ignores   onlyBuiltDependencies ',
    });
    const out = await t.engine.save(RUN, team);
    expect(out.status).toBe('proposed');
    expect(
      t.engine.proposal(OWNER, (out as { proposal: string }).proposal).proposal
        .matchedPersonal
    ).toBe(true);
  });

  it('never auto-approves while the operator’s personal store is down', async () => {
    const t = setup();
    t.host.ruling = AUTO;
    t.down.add('self');
    const out = (await t.engine.save(RUN, team)) as Gated;
    expect(out.gate).toBe('m-gate-1');
    expect(
      t.engine.proposal(OWNER, out.proposal).proposal.matchedPersonal
    ).toBe(true);
    expect(t.shared.countEntries()).toBe(0);
  });

  it('sends a proposal to a human when the policy ruling throws', async () => {
    const t = setup();
    t.host.failing.add('rule');
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await t.engine.save(RUN, team)).toMatchObject({
        status: 'proposed',
        gate: 'm-gate-1',
      });
      expect(String(errors.mock.calls[0]?.[0])).toContain('policy ruling');
    } finally {
      errors.mockRestore();
    }
  });

  it('de-duplicates against active entries, open proposals and recent rejections', async () => {
    const t = setup();
    const first = (await t.engine.save(RUN, team)) as {
      proposal: string;
      gate: string;
    };
    expect(await conflictOf(t.engine.save(RUN, team))).toContain(
      first.proposal
    );
    t.engine.applyGateAnswer({
      proposalId: first.proposal,
      gateId: first.gate,
      choice: 'reject',
      by: 'human:wyat',
      reason: 'wrong',
      expired: false,
    });
    expect(await conflictOf(t.engine.save(RUN, team))).toContain(
      'rejected by human:wyat'
    );
    const direct = (await t.engine.save(OWNER, {
      ...team,
      title: 'already here',
    })) as { handle: string };
    expect(
      await conflictOf(t.engine.save(RUN, { ...team, title: 'already here' }))
    ).toContain(direct.handle);
  });

  it('de-duplicates within one scope only', async () => {
    const t = setup();
    await t.engine.save(RUN, team);
    await t.engine.save(OWNER, { ...team, title: 'already here' });
    const asProject = (title: string) =>
      t.engine.save(RUN, { ...team, scope: 'project', title });
    expect((await asProject(team.title)).status).toBe('proposed');
    expect((await asProject('already here')).status).toBe('proposed');
  });

  it('holds a rejection for 30 days, then lets the lesson be asked again', async () => {
    const t = setup();
    const first = (await t.engine.save(RUN, team)) as Gated;
    t.engine.applyGateAnswer({
      proposalId: first.proposal,
      gateId: first.gate,
      choice: 'reject',
      by: 'human:wyat',
      reason: 'wrong',
      expired: false,
    });
    t.host.clock = new Date('2026-10-24T10:00:00.000Z');
    expect(await conflictOf(t.engine.save(RUN, team))).toBe(
      'conflict: the same lesson was rejected by human:wyat on 2026-09-25: wrong'
    );
    t.host.clock = new Date('2026-10-25T10:00:01.000Z');
    expect((await t.engine.save(RUN, team)).status).toBe('proposed');
  });

  it('refuses a second retire of a target while the first is open', async () => {
    const t = setup();
    const target = (await t.engine.save(OWNER, team)) as {
      id: string;
      handle: string;
    };
    const first = (await t.engine.forget(RUN, target.id, 'stale')) as Gated;
    expect(
      await conflictOf(t.engine.forget(RUN, target.id, 'still stale'))
    ).toBe(
      `conflict: retiring ${target.handle} is already proposed as ${first.proposal}`
    );
  });

  it('refuses a proposal whose origin another proposal holds', async () => {
    const t = setup();
    const first = (await ledgerRow(t, 'ledger:l-6@t')) as Gated;
    expect(
      await conflictOf(ledgerRow(t, 'ledger:l-6@t', 'a different lesson'))
    ).toBe(`conflict: origin: ${first.proposal} already holds ledger:l-6@t`);
  });

  it('refuses a direct write claiming an origin an open proposal holds, so approval still applies', async () => {
    const t = setup();
    const origin = 'amendment:t-1a2b3c@2026-09-25T10:00:00.000Z';
    const p = (await t.engine.submitProposal(RUN, {
      action: 'add',
      scope: 'team',
      content: valid('amended by the run'),
      origin,
    })) as Gated;
    expect(
      await conflictOf(
        t.engine.save(OWNER, { ...team, title: 'amended by the owner', origin })
      )
    ).toBe(`conflict: origin: ${p.proposal} already holds ${origin}`);
    expect(approve(t, p).outcome).toBe('applied');
    expect(t.shared.entryByOrigin(origin)?.title).toBe('amended by the run');
  });

  it('limits proposals per hour and open proposals per project, but not ledger imports', async () => {
    const t = setup({ proposalsPerHour: 1, maxOpenProposals: 2 });
    await t.engine.save(RUN, { ...team, title: 'a' });
    expect(
      await conflictOf(t.engine.save(RUN, { ...team, title: 'b' }))
    ).toStartWith('limited');
    await ledgerRow(t, 'ledger:l-1@t', 'import');
    expect(t.engine.proposals(OWNER, 'open')).toHaveLength(2);
    // A human has no hourly limit, so only the project's open count refuses her.
    const low = { ...ADA, canDecide: false };
    t.host.operators.set('human:ada', {
      human: 'human:ada',
      identity: 'pid-A',
    });
    expect(await conflictOf(t.engine.save(low, { ...team, title: 'c' }))).toBe(
      'limited: this project already has 2 open memory proposals; wait for decisions'
    );
    expect(
      await conflictOf(
        t.engine.submitProposal(OWNER, {
          action: 'add',
          scope: 'team',
          content: valid('sync'),
          origin: 'sync:B',
        })
      )
    ).toBe('ok');
  });

  // Only ledger: and sync: origins are exempt; any other origin counts.
  it('counts an amendment against its author’s hourly limit', async () => {
    const t = setup({ proposalsPerHour: 1 });
    // The shared agentToken's principal: attributed to the owner, never a human.
    const agent = {
      address: 'human:wyat',
      canDecide: false,
      kind: 'agent',
    } as const;
    const content = (title: string) => ({
      ...valid(title),
      kind: 'constraint' as const,
    });
    await t.engine.submitProposal(agent, {
      action: 'add',
      scope: 'team',
      content: content('first amendment'),
      origin: 'amendment:t-1a2b3c@2026-09-25T10:00:00.000Z',
    });
    expect(
      await conflictOf(
        t.engine.submitProposal(agent, {
          action: 'add',
          scope: 'team',
          content: content('second amendment'),
          origin: 'amendment:t-1a2b3c@2026-09-25T10:00:01.000Z',
        })
      )
    ).toStartWith('limited');
  });

  // Live notify fires whenever a shared hazard or constraint becomes active.
  it('announces a decide-tier human’s direct team hazard, and an undo that brings one back', async () => {
    const t = setup();
    const direct = (await t.engine.save(OWNER, {
      ...team,
      title: 'written directly',
    })) as { id: string };
    expect(t.host.activated.map((a) => [a.entry.id, a.authorRun])).toEqual([
      [direct.id, null],
    ]);
    await t.engine.forget(OWNER, direct.id, 'wrong');
    t.engine.undo(OWNER, direct.id);
    expect(t.host.activated.map((a) => a.entry.id)).toEqual([
      direct.id,
      direct.id,
    ]);
    await t.engine.save(OWNER, {
      ...team,
      kind: 'fact',
      title: 'facts are not announced',
    });
    expect(t.host.activated).toHaveLength(2);
  });

  it('approval by a human gives confirmed trust; by the author human, human trust', async () => {
    const t = setup();
    const p = (await t.engine.save(RUN, team)) as {
      proposal: string;
      gate: string;
    };
    expect(
      t.engine.applyGateAnswer({
        proposalId: p.proposal,
        gateId: p.gate,
        choice: 'approve',
        by: 'human:wyat',
        reason: '',
        expired: false,
      }).outcome
    ).toBe('applied');
    expect(t.shared.listEntries()[0]).toMatchObject({
      trust: 'confirmed',
      decidedBy: 'human:wyat',
      author: 'run:r-9f2c01',
    });
    const low = { ...ADA, canDecide: false };
    t.host.operators.set('human:ada', {
      human: 'human:ada',
      identity: 'pid-A',
    });
    const q = (await t.engine.save(low, { ...team, title: 'from ada' })) as {
      proposal: string;
      gate: string;
    };
    t.engine.applyGateAnswer({
      proposalId: q.proposal,
      gateId: q.gate,
      choice: 'approve',
      by: 'human:wyat',
      reason: '',
      expired: false,
    });
    expect(
      t.shared.listEntries().find((e) => e.title === 'from ada')?.trust
    ).toBe('human');
  });

  it('supersede retires a still-active target; a target retired meanwhile leaves the new entry standing', async () => {
    const t = setup();
    const live = (await t.engine.save(OWNER, team)) as { id: string };
    const edit = (await t.engine.edit(RUN, live.id, {
      body: 'still true, and more',
    })) as Gated;
    t.host.changes.length = 0;
    approve(t, edit);
    const successor = t.shared
      .listEntries()
      .find((e) => e.body === 'still true, and more');
    expect(successor).toMatchObject({
      status: 'active',
      supersedes: live.id,
      proposal: edit.proposal,
    });
    expect(t.shared.getEntry(live.id)).toMatchObject({
      status: 'retired',
      statusReason: 'superseded',
      supersededBy: successor?.id,
    });
    expect(t.host.changes).toEqual([
      { scope: 'team', id: successor?.id },
      { scope: 'team', id: live.id },
    ]);

    const target = (await t.engine.save(OWNER, {
      ...team,
      title: 'retired meanwhile',
    })) as { id: string };
    const p = (await t.engine.edit(RUN, target.id, {
      body: 'better detail',
    })) as Gated;
    await t.engine.forget(OWNER, target.id, 'obsolete');
    approve(t, p);
    const entries = t.shared.listEntries();
    expect(entries.find((e) => e.body === 'better detail')).toMatchObject({
      status: 'active',
      supersedes: target.id,
    });
    expect(entries.find((e) => e.id === target.id)?.statusReason).toBe(
      'forgotten'
    );
  });

  it('an approved retire forgets its target and names it as the result', async () => {
    const t = setup();
    const target = (await t.engine.save(OWNER, team)) as { id: string };
    const r = (await t.engine.forget(RUN, target.id, 'stale')) as Gated;
    expect(approve(t, r).proposal).toMatchObject({
      state: 'approved',
      result: target.id,
      decidedBy: 'human:wyat',
    });
    expect(t.shared.getEntry(target.id)).toMatchObject({
      status: 'retired',
      statusReason: 'forgotten',
    });
    expect(t.shared.countEntries()).toBe(1);
  });

  it('rejecting or expiring a retire leaves its target active', async () => {
    const t = setup();
    const target = (await t.engine.save(OWNER, team)) as { id: string };
    const r1 = (await t.engine.forget(RUN, target.id, 'stale')) as {
      proposal: string;
      gate: string;
    };
    t.engine.applyGateAnswer({
      proposalId: r1.proposal,
      gateId: r1.gate,
      choice: 'reject',
      by: 'human:wyat',
      reason: 'still true',
      expired: false,
    });
    expect(t.host.rejected.map((p) => p.id)).toEqual([r1.proposal]);
    const r2 = (await t.engine.forget(RUN, target.id, 'stale again')) as {
      proposal: string;
      gate: string;
    };
    t.engine.applyGateAnswer({
      proposalId: r2.proposal,
      gateId: r2.gate,
      choice: 'reject',
      by: 'agent:dispatch',
      reason: 'Expired',
      expired: true,
    });
    expect(t.engine.proposal(OWNER, r2.proposal).proposal.state).toBe(
      'expired'
    );
    expect(t.shared.getEntry(target.id)?.status).toBe('active');
  });

  it('applies an answer once: a replay or another gate is skipped', async () => {
    const t = setup();
    const p = (await t.engine.save(RUN, team)) as {
      proposal: string;
      gate: string;
    };
    const answer = {
      proposalId: p.proposal,
      gateId: p.gate,
      choice: 'approve' as const,
      by: 'human:wyat',
      reason: '',
      expired: false,
    };
    expect(t.engine.applyGateAnswer(answer).outcome).toBe('applied');
    expect(t.engine.applyGateAnswer(answer).outcome).toBe('skipped');
    expect(
      t.engine.applyGateAnswer({ ...answer, gateId: 'm-other' }).outcome
    ).toBe('skipped');
    expect(t.shared.countEntries()).toBe(1);
  });

  it('recovers a proposal whose gate was never recorded', async () => {
    const t = setup();
    await ledgerRow(t, 'ledger:l-9@t');
    // submitProposal raised a gate; simulate the crash between store and raise:
    const [p] = t.engine.proposals(OWNER, 'open');
    t.shared.updateProposal({ ...p, gate: null });
    expect(await t.engine.recover()).toEqual({ raised: 1 });
    expect(t.engine.proposals(OWNER, 'open')[0].gate).toMatch(/^m-gate-/);
  });

  it('returns an ungated proposal when its gate cannot be raised, and recover raises it', async () => {
    const t = setup();
    t.host.failing.add('raiseGate');
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await t.engine.save(RUN, team)).toEqual({
        status: 'proposed',
        proposal: expect.stringMatching(/^mp-/),
        gate: null,
      });
      expect(String(errors.mock.calls[0]?.[0])).toContain('gate');
    } finally {
      errors.mockRestore();
    }
    t.host.failing.delete('raiseGate');
    expect(await t.engine.recover()).toEqual({ raised: 1 });
    expect(t.engine.proposals(OWNER, 'open')[0].gate).toBe('m-gate-1');
  });

  it('accepts an answer that arrives before the gate id is recorded', async () => {
    const t = setup();
    await ledgerRow(t, 'ledger:l-8@t');
    const [p] = t.engine.proposals(OWNER, 'open');
    t.shared.updateProposal({ ...p, gate: null });
    expect(
      t.engine.applyGateAnswer({
        proposalId: p.id,
        gateId: 'm-early',
        choice: 'approve',
        by: 'human:wyat',
        reason: '',
        expired: false,
      }).outcome
    ).toBe('applied');
  });

  it('shows a supersede’s base and current versions; other runs cannot see it', async () => {
    const t = setup();
    const target = (await t.engine.save(OWNER, team)) as { id: string };
    await t.engine.edit(OWNER, target.id, { body: 'second' });
    const p = (await t.engine.edit(RUN, target.id, {
      body: 'third',
      baseRev: 1,
    })) as { proposal: string };
    const shown = t.engine.proposal(OWNER, p.proposal);
    expect([shown.base?.body, shown.current?.body]).toEqual([
      'use allowBuilds',
      'second',
    ]);
    expect(shown.proposal).toMatchObject({ action: 'supersede', baseRev: 1 });
    const other = { ...RUN, address: 'run:r-000002' };
    expect(
      await conflictOf(
        Promise.resolve().then(() => t.engine.proposal(other, p.proposal))
      )
    ).toStartWith('not-found');
  });

  it('expires an ungated proposal and leaves a gated one to its gate', async () => {
    const t = setup();
    await ledgerRow(t, 'ledger:l-7@t');
    const [p] = t.engine.proposals(OWNER, 'open');
    t.engine.expireUngated(p.id);
    expect(t.engine.proposals(OWNER, 'open')).toHaveLength(1);
    t.shared.updateProposal({ ...p, gate: null });
    t.engine.expireUngated(p.id);
    expect(t.engine.proposal(OWNER, p.id).proposal).toMatchObject({
      state: 'expired',
      decidedBy: 'agent:dispatch',
    });
  });

  it('never auto-approves a promotion, and announces a decider’s promoted hazard', async () => {
    const t = setup();
    t.host.ruling = AUTO;
    const low = { ...ADA, canDecide: false };
    t.host.operators.set('human:ada', {
      human: 'human:ada',
      identity: 'pid-A',
    });
    const hers = (await t.engine.save(low, {
      ...team,
      scope: 'personal',
    })) as { id: string };
    const proposed = (await t.engine.promote(low, hers.id, 'team')) as {
      proposal: string;
    };
    expect(
      t.engine.proposal(OWNER, proposed.proposal).proposal.matchedPersonal
    ).toBe(true);
    const mine = (await t.engine.save(OWNER, {
      ...team,
      scope: 'personal',
      title: 'mine',
    })) as { id: string };
    const direct = (await t.engine.promote(OWNER, mine.id, 'project')) as {
      id: string;
    };
    expect(t.host.activated.map((a) => a.entry.id)).toEqual([direct.id]);
  });

  it('lists open proposals older than a cutoff for expiry', async () => {
    const t = setup();
    await t.engine.save(RUN, team);
    expect(
      t.engine.openProposalsOlderThan('2026-09-25T10:00:01.000Z')
    ).toHaveLength(1);
    expect(
      t.engine.openProposalsOlderThan('2026-09-25T09:59:59.000Z')
    ).toHaveLength(0);
  });
});
