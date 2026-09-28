import { DEFAULT_MEMORY } from '@dispatch/core';
import { createMemoryIds, insertFresh, newMemoryEntry } from '@dispatch/memory';
import type { MemoryScope, MemoryStore, Principal } from '@dispatch/memory';
import { gateOf, SYSTEM_ADDRESS } from '@dispatch/protocol';
import type { DeliveryEngine, Message } from '@dispatch/protocol';
import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { startDecayScheduler } from '../../src/memory/decay.js';
import {
  memoryGateKind,
  raiseMemoryGate,
  registerMemoryGate,
} from '../../src/memory/gate.js';
import { PersonalStores } from '../../src/memory/personalStores.js';
import {
  HUMAN,
  makeOrchestrator,
  openRecovered,
  useTempProject,
  waitFor,
} from '../messaging/harness.js';
import { AGENT, storedProposal, teamHazard, testEngine } from './fixtures.js';

const project = useTempProject();

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OWNER: Principal = {
  address: 'human:wyat',
  canDecide: true,
  kind: 'human',
};

// A clock `days` ahead of the real one, so proposals made now read as old.
const later = (days: number) => () => new Date(Date.now() + days * DAY);

const memoryGates = (engine: DeliveryEngine): Message[] =>
  engine.openBlocking().filter((m) => gateOf(m)?.type === 'memory');

// An entry last changed `daysAgo` days ago, never recalled.
function idle(store: MemoryStore, scope: MemoryScope, daysAgo: number): void {
  const at = new Date(Date.now() - daysAgo * DAY).toISOString();
  insertFresh(
    store,
    createMemoryIds(),
    Date.now(),
    (id) =>
      newMemoryEntry(
        {
          scope,
          kind: 'hazard',
          title: `idle ${id}`,
          body: 'b',
          author: 'run:r-9f2c01',
          trust: 'agent',
        },
        id,
        at
      ),
    'run:r-9f2c01',
    'save'
  );
}

type Deps = Parameters<typeof startDecayScheduler>[0];

// Starts a scheduler, runs `passes` passes one after another, then stops it.
async function sweep(deps: Deps, passes = 1) {
  const scheduler = startDecayScheduler(deps);
  const summaries = [];
  for (let i = 0; i < passes; i++) summaries.push(await scheduler.runNow());
  scheduler.stop();
  return summaries;
}

// Recovered messaging over the project, memory.db beside it with the memory
// gate raised through messaging, and personal stores under personal/.
async function setup() {
  const root = project.root();
  const { orchestrator, store } = makeOrchestrator(root);
  const messaging = await openRecovered(root, orchestrator, store);
  const dbPath = join(root, 'memory.db');
  const t = testEngine({ dbPath });
  t.host.raise = (p) =>
    raiseMemoryGate(
      messaging.engine,
      'human:wyat',
      p,
      memoryGateKind(p, t.shared)
    );
  registerMemoryGate(messaging, t.engine);
  const personal = new PersonalStores({ dir: join(root, 'personal') });
  const deps: Deps = {
    shared: () => t.shared,
    personal,
    engine: () => t.engine,
    messaging,
    config: () => DEFAULT_MEMORY,
    host: t.host,
    sharedPath: dbPath,
  };
  return {
    ...t,
    root,
    messaging,
    personal,
    deps,
    // A team hazard proposed by an agent, waiting at its gate.
    propose: async (title: string) =>
      (await t.engine.submitProposal(AGENT, {
        action: 'add',
        scope: 'team',
        content: teamHazard(title),
      })) as { proposal: string; gate: string },
    close: () => {
      personal.close();
      t.shared.close();
      messaging.close();
    },
  };
}

describe('startDecayScheduler', () => {
  it('backs up twice in a row, leaving one .bak at 0600', async () => {
    const s = await setup();
    const [first, second] = await sweep(s.deps, 2);
    expect([first.backups, second.backups]).toEqual([1, 1]);
    const files = readdirSync(s.root).filter((f) =>
      f.startsWith('memory.db.bak')
    );
    expect(files).toEqual(['memory.db.bak']);
    expect(statSync(join(s.root, 'memory.db.bak')).mode & 0o777).toBe(0o600);
    s.close();
  });

  it('expires an old gated proposal through the gate, and an ungated one directly', async () => {
    const s = await setup();
    const gated = await s.propose('gated, never decided');
    storedProposal(s.shared, 'ungated, never raised');
    s.host.changes.length = 0;
    const [summary] = await sweep({ ...s.deps, now: later(15) });
    expect(summary.proposalsExpired).toBe(2);
    expect(memoryGates(s.messaging.engine)).toEqual([]);
    expect(s.engine.proposals(OWNER).map((p) => p.state)).toEqual([
      'expired',
      'expired',
    ]);
    expect(s.messaging.engine.answerOf(gated.gate)).toMatchObject({
      from: SYSTEM_ADDRESS,
      choice: 'reject',
      body: 'Expired: no one decided within 14 days.',
      data: { type: 'x-expired' },
    });
    expect(s.host.changes).toEqual([{ scope: 'team' }]);
    s.close();
  });

  it('leaves proposals younger than proposalTtlDays open', async () => {
    const s = await setup();
    await s.propose('still young');
    const [summary] = await sweep({ ...s.deps, now: later(13) });
    expect(summary.proposalsExpired).toBe(0);
    expect(memoryGates(s.messaging.engine)).toHaveLength(1);
    expect(s.engine.proposals(OWNER).map((p) => p.state)).toEqual(['open']);
    s.close();
  });

  // An answer that beat the expiry reply but never took effect must still decide
  // the proposal, or it stays open and counts against maxOpenProposals for good.
  it('applies the stored answer when the expiry reply meets one', async () => {
    const s = await setup();
    const p = await s.propose('answered, never applied');
    s.messaging.gates.register('memory', () =>
      Promise.reject(new Error('crash before the effect'))
    );
    await s.messaging.engine.reply(
      p.gate,
      { body: '', choice: 'approve' },
      HUMAN
    );
    registerMemoryGate(s.messaging, s.engine);
    const [summary] = await sweep({ ...s.deps, now: later(15) });
    expect(summary.proposalsExpired).toBe(0);
    expect(s.engine.proposal(OWNER, p.proposal).proposal).toMatchObject({
      state: 'approved',
      decidedBy: 'human:wyat',
    });
    s.close();
  });

  // Messaging voids such an answer and reopens the gate when it recovers; the
  // sweep must never let it decide, or an agent would approve its own lesson.
  it('never applies a stored answer from anyone but a deciding human or the system', async () => {
    const s = await setup();
    const p = await s.propose('answered by an agent');
    const question = s.messaging.engine.getMessage(p.gate)!;
    s.messaging.store.insertMessage({
      id: 'm-agent-answer',
      thread: question.thread,
      replyTo: question.id,
      from: AGENT.address,
      to: [question.from],
      kind: 'answer',
      body: '',
      choice: 'approve',
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none',
      createdAt: new Date().toISOString(),
    });
    const [summary] = await sweep({ ...s.deps, now: later(15) });
    expect(summary.proposalsExpired).toBe(0);
    expect(s.shared.getProposal(p.proposal)?.state).toBe('open');
    expect(s.shared.countEntries()).toBe(0);
    s.close();
  });

  it('expires, never rejects, a proposal whose gate the system closed undecided', async () => {
    const s = await setup();
    const p = await s.propose('closed without a decision');
    s.messaging.engine.close(p.gate, 'nobody can decide it here');
    const [summary] = await sweep({ ...s.deps, now: later(15) });
    expect(summary.proposalsExpired).toBe(1);
    expect(s.shared.getProposal(p.proposal)?.state).toBe('expired');
    expect(s.host.rejected).toEqual([]);
    s.close();
  });

  it('expires a proposal whose gate message is gone', async () => {
    const s = await setup();
    const p = storedProposal(s.shared, 'its gate was lost');
    s.shared.updateProposal({ ...p, gate: 'm-01J0000000000000000000GONE' });
    const [summary] = await sweep({ ...s.deps, now: later(15) });
    expect(summary.proposalsExpired).toBe(1);
    expect(s.shared.getProposal(p.id)).toMatchObject({
      state: 'expired',
      decidedBy: SYSTEM_ADDRESS,
    });
    s.close();
  });

  it('ages memory.db and every opened personal store, announcing one change per store', async () => {
    const s = await setup();
    idle(s.shared, 'team', 61);
    idle(s.shared, 'project', 61);
    idle(s.personal.personal('self'), 'personal', 200);
    const [summary] = await sweep(s.deps);
    expect(summary).toMatchObject({
      stores: 2,
      staled: 3,
      expired: 1,
      skipped: [],
    });
    expect(s.host.changes).toEqual([{ scope: 'team' }, { scope: 'personal' }]);
    s.close();
  });

  it('skips a personal database another daemon swept within 24 hours', async () => {
    const s = await setup();
    s.personal
      .personal('self')
      .setMeta('last_decay_at', new Date().toISOString());
    const [summary] = await sweep(s.deps);
    expect(summary).toMatchObject({ stores: 1, skipped: ['self'] });
    expect(existsSync(join(s.root, 'personal', 'self.db.bak'))).toBe(false);
    s.close();
  });

  it('sweeps a personal database it swept itself again, backing it up beside the file', async () => {
    const s = await setup();
    s.personal.personal('self');
    const [first, second] = await sweep(s.deps, 2);
    expect([first.skipped, second.skipped]).toEqual([[], []]);
    expect([first.backups, second.backups]).toEqual([2, 2]);
    expect(statSync(join(s.root, 'personal', 'self.db.bak')).mode & 0o777).toBe(
      0o600
    );
    s.close();
  });

  it('sweeps at start only when memory.db was last swept over 24 hours ago', async () => {
    const s = await setup();
    const recent = new Date(Date.now() - 23 * HOUR).toISOString();
    s.shared.setMeta('last_decay_at', recent);
    startDecayScheduler(s.deps).stop();
    expect(s.shared.meta('last_decay_at')).toBe(recent);
    const old = new Date(Date.now() - 25 * HOUR).toISOString();
    s.shared.setMeta('last_decay_at', old);
    const scheduler = startDecayScheduler(s.deps);
    await waitFor(() => existsSync(join(s.root, 'memory.db.bak')));
    scheduler.stop();
    expect(s.shared.meta('last_decay_at')).not.toBe(old);
    s.close();
  });

  it('sweeps again every intervalMs until stopped', async () => {
    const s = await setup();
    s.shared.setMeta('last_decay_at', new Date().toISOString());
    const bak = join(s.root, 'memory.db.bak');
    const scheduler = startDecayScheduler({ ...s.deps, intervalMs: 10 });
    await waitFor(() => existsSync(bak));
    scheduler.stop();
    rmSync(bak);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(existsSync(bak)).toBe(false);
    s.close();
  });
});
