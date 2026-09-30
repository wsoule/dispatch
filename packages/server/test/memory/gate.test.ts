import { newMemoryEntry } from '@dispatch/memory';
import type { MemoryProposal } from '@dispatch/memory';
import { gateOf } from '@dispatch/protocol';
import type { DeliveryEngine, Message } from '@dispatch/protocol';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { EventBus } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import {
  closeStrayMemoryGates,
  raiseMemoryGate,
  registerMemoryGate,
} from '../../src/memory/gate.js';
import { liveDigest, notifyLiveRuns } from '../../src/memory/liveNotify.js';
import { SYSTEM_SENDER } from '../../src/messaging/gates.js';
import { openMessaging } from '../../src/messaging/service.js';
import type { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import {
  HUMAN,
  makeOrchestrator,
  useTempProject,
  waitFor,
} from '../messaging/harness.js';
import { AGENT, storedProposal, teamHazard, testEngine } from './fixtures.js';

const project = useTempProject();

// Messaging over the project's messages.db, not yet recovered, so a test can
// register the memory handler before recover() the way index.ts does.
function openBus() {
  const { orchestrator, store } = makeOrchestrator(project.root());
  return openMessaging({
    rootDir: project.root(),
    orchestrator,
    store,
    events: new EventBus(),
    ownerRef: 'human:wyat',
    dbPath: join(project.root(), 'messages.db'),
    ledgerStore: new LedgerStore(project.root()),
    appendPolicyActivity: () => {},
  });
}

const memoryGates = (engine: DeliveryEngine): Message[] =>
  engine.openBlocking().filter((m) => gateOf(m)?.type === 'memory');

// The same content-free gate raiseMemoryGate sends, sent a second time by hand.
async function sendDuplicate(
  engine: DeliveryEngine,
  p: MemoryProposal
): Promise<string> {
  const sent = await engine.send(
    {
      to: ['human:wyat'],
      kind: 'question',
      blocking: true,
      choices: ['approve', 'reject'],
      body: `${p.author} proposes a team memory (hazard). Review it in Needs you.`,
      data: {
        type: 'memory',
        proposalId: p.id,
        action: p.action,
        scope: p.scope,
        kind: 'hazard',
      },
    },
    SYSTEM_SENDER
  );
  return sent.message.id;
}

describe('memory gates on the bus', () => {
  it('raiseMemoryGate returns the open gate for a proposal instead of sending a second, and carries no title', async () => {
    const messaging = openBus();
    await messaging.recover();
    const { shared } = testEngine();
    const p = storedProposal(shared, 'SECRET-GATE-title');
    const first = await raiseMemoryGate(
      messaging.engine,
      'human:wyat',
      p,
      'hazard'
    );
    expect(
      await raiseMemoryGate(messaging.engine, 'human:wyat', p, 'hazard')
    ).toBe(first);
    expect(memoryGates(messaging.engine).map((m) => m.id)).toEqual([first]);
    expect(JSON.stringify(memoryGates(messaging.engine))).not.toContain(
      'SECRET-GATE-title'
    );
    messaging.close();
  });

  // A recover that overlaps a live propose raises the same proposal's gate twice at once.
  it('two overlapping raises for one proposal send one gate', async () => {
    const messaging = openBus();
    await messaging.recover();
    const { shared } = testEngine();
    const p = storedProposal(shared, 'raced');
    const [a, b] = await Promise.all([
      raiseMemoryGate(messaging.engine, 'human:wyat', p, 'hazard'),
      raiseMemoryGate(messaging.engine, 'human:wyat', p, 'hazard'),
    ]);
    expect(b).toBe(a);
    expect(memoryGates(messaging.engine).map((m) => m.id)).toEqual([a]);
    messaging.close();
  });

  it('closeStrayMemoryGates closes a duplicate and the gate of a decided proposal, keeping the recorded one', async () => {
    const messaging = openBus();
    await messaging.recover();
    const { shared } = testEngine();
    const open = storedProposal(shared, 'still open');
    const recorded = await raiseMemoryGate(
      messaging.engine,
      'human:wyat',
      open,
      'hazard'
    );
    shared.updateProposal({ ...shared.getProposal(open.id)!, gate: recorded });
    await sendDuplicate(messaging.engine, open);
    const decided = storedProposal(shared, 'decided already');
    const stale = await raiseMemoryGate(
      messaging.engine,
      'human:wyat',
      decided,
      'hazard'
    );
    shared.updateProposal({
      ...shared.getProposal(decided.id)!,
      gate: stale,
      state: 'rejected',
      decidedBy: 'human:wyat',
      decidedAt: new Date().toISOString(),
    });
    expect(closeStrayMemoryGates(messaging.engine, shared)).toBe(2);
    expect(memoryGates(messaging.engine).map((m) => m.id)).toEqual([recorded]);
    messaging.close();
  });

  it('applies an answer once when messaging hands it over again', async () => {
    const messaging = openBus();
    await messaging.recover();
    const t = testEngine();
    t.host.raise = (p) =>
      raiseMemoryGate(messaging.engine, 'human:wyat', p, 'hazard');
    registerMemoryGate(messaging, t.engine);
    const out = (await t.engine.submitProposal(AGENT, {
      action: 'add',
      scope: 'team',
      content: teamHazard('applied once'),
    })) as { gate: string };
    await messaging.engine.reply(
      out.gate,
      { body: '', choice: 'approve' },
      HUMAN
    );
    await waitFor(() => t.shared.countEntries() === 1);
    await messaging.gates.handle(
      messaging.engine.getMessage(out.gate)!,
      messaging.engine.answerOf(out.gate)!
    );
    expect(t.shared.countEntries()).toBe(1);
    messaging.close();
  });

  // A crash between an answer and its effect. The protocol marks a gate
  // applied even when no handler is registered for its type, so only a
  // handler registered before messaging.recover() ever sees the replay.
  it('a handler registered before recover() applies an answer a crash left unapplied', async () => {
    const dbPath = join(project.root(), 'memory.db');
    const first = openBus();
    await first.recover();
    const before = testEngine({ dbPath });
    before.host.raise = (p) =>
      raiseMemoryGate(first.engine, 'human:wyat', p, 'hazard');
    first.gates.register('memory', () =>
      Promise.reject(new Error('crash before the effect'))
    );
    const out = (await before.engine.submitProposal(AGENT, {
      action: 'add',
      scope: 'team',
      content: teamHazard('replayed at boot'),
    })) as { proposal: string; gate: string };
    await first.engine.reply(out.gate, { body: '', choice: 'approve' }, HUMAN);
    expect(before.shared.getProposal(out.proposal)?.state).toBe('open');
    first.close();
    before.shared.close();

    const second = openBus();
    const after = testEngine({ dbPath });
    registerMemoryGate(second, after.engine);
    await second.recover();
    expect(after.shared.getProposal(out.proposal)?.state).toBe('approved');
    expect(after.shared.countEntries()).toBe(1);
    second.close();
  });

  it('a handler registered after recover() never sees that answer, which is why the order matters', async () => {
    const dbPath = join(project.root(), 'memory.db');
    const first = openBus();
    await first.recover();
    const before = testEngine({ dbPath });
    before.host.raise = (p) =>
      raiseMemoryGate(first.engine, 'human:wyat', p, 'hazard');
    first.gates.register('memory', () =>
      Promise.reject(new Error('crash before the effect'))
    );
    const out = (await before.engine.submitProposal(AGENT, {
      action: 'add',
      scope: 'team',
      content: teamHazard('lost to the order'),
    })) as { proposal: string; gate: string };
    await first.engine.reply(out.gate, { body: '', choice: 'approve' }, HUMAN);
    first.close();
    before.shared.close();

    const second = openBus();
    await second.recover();
    const after = testEngine({ dbPath });
    registerMemoryGate(second, after.engine);
    expect(second.store.unappliedAnsweredGates()).toEqual([]);
    expect(after.shared.getProposal(out.proposal)?.state).toBe('open');
    second.close();
  });
});

describe('live notify', () => {
  it('liveDigest cuts the title to 80 characters and folds line breaks', () => {
    const e = newMemoryEntry(
      {
        scope: 'team',
        kind: 'hazard',
        title: `${'x'.repeat(40)}\n${'y'.repeat(60)}`,
        body: '',
        author: 'run:r-9f2c01',
        trust: 'agent',
      },
      `mem-${'A'.repeat(26)}`,
      new Date().toISOString()
    );
    expect(liveDigest(e)).toBe(
      `🧠 memory · hazard from run:r-9f2c01: ${'x'.repeat(40)} ${'y'.repeat(39)} (${e.handle})`
    );
  });

  it('notifyLiveRuns reaches live execute runs the entry reaches, never the author’s own run', () => {
    const t = testEngine();
    for (const [run, task] of [
      ['r-000001', 't-000001'],
      ['r-000002', 't-000002'],
      ['r-000003', 't-000003'],
    ] as const) {
      t.host.runTasks.set(run, task);
      t.host.tasks.set(task, {
        taskId: task,
        title: 'x',
        body: '',
        writes: [],
        epic: null,
        risk: 'routine',
        a2a: false,
      });
    }
    const entry = newMemoryEntry(
      {
        scope: 'team',
        kind: 'hazard',
        title: 'watch out',
        body: 'b',
        author: 'run:r-000001',
        trust: 'agent',
        appliesTo: ['t-000001', 't-000002'],
      },
      `mem-${'B'.repeat(26)}`,
      new Date().toISOString()
    );
    const sent: [string, string][] = [];
    const orchestrator = {
      list: () =>
        [...t.host.runTasks].map(([id, taskId]) => ({
          id,
          taskId,
          state: 'running',
        })),
      notifyRun: (id: string, text: string) => void sent.push([id, text]),
    } as unknown as Pick<Orchestrator, 'list' | 'notifyRun'>;
    // r-000001 wrote it; r-000003's task is outside appliesTo.
    expect(
      notifyLiveRuns(
        { orchestrator, engine: t.engine, host: t.host },
        entry,
        'r-000001'
      )
    ).toBe(1);
    expect(sent).toEqual([['r-000002', liveDigest(entry)]]);
  });

  // Project scope never reaches an A2A run; review and finished runs hear nothing.
  it('notifyLiveRuns skips A2A runs for project scope, and non-execute or finished runs', () => {
    const t = testEngine();
    const runs = [
      { id: 'r-000001', taskId: 't-000001', state: 'running', a2a: true },
      { id: 'r-000002', taskId: 't-000002', state: 'running', kind: 'review' },
      { id: 'r-000003', taskId: 't-000003', state: 'finished' },
      { id: 'r-000004', taskId: 't-000004', state: 'running' },
    ];
    for (const run of runs) {
      t.host.runTasks.set(run.id, run.taskId);
      t.host.tasks.set(run.taskId, {
        taskId: run.taskId,
        title: 'x',
        body: '',
        writes: [],
        epic: null,
        risk: 'routine',
        a2a: run.a2a === true,
      });
    }
    const sent: string[] = [];
    const orchestrator = {
      list: () => runs,
      notifyRun: (id: string) => void sent.push(id),
    } as unknown as Pick<Orchestrator, 'list' | 'notifyRun'>;
    const heard = (scope: 'project' | 'team') => {
      sent.length = 0;
      const entry = newMemoryEntry(
        {
          scope,
          kind: 'hazard',
          title: 'watch out',
          body: 'b',
          author: 'human:wyat',
          trust: 'human',
        },
        `mem-${'C'.repeat(26)}`,
        new Date().toISOString()
      );
      notifyLiveRuns(
        { orchestrator, engine: t.engine, host: t.host },
        entry,
        null
      );
      return [...sent];
    };
    expect(heard('project')).toEqual(['r-000004']);
    expect(heard('team')).toEqual(['r-000001', 'r-000004']);
  });
});
