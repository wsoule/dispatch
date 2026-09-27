import type { Message, Sender } from '@dispatch/protocol';
import { describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LedgerStore } from '../../src/ledger.js';
import { closeOrphanedGates } from '../../src/messaging/gates.js';
import {
  expireScopeGates,
  SCOPE_GATE_TTL_MS,
} from '../../src/messaging/scopePolicy.js';
import { StallingExecutor } from '../orchestrator/helpers.js';
import {
  activity,
  HUMAN,
  makeOrchestrator,
  openRecovered,
  useTempProject,
  waitFor,
} from './harness.js';

const project = useTempProject();

function setPolicy(yaml: string): void {
  mkdirSync(join(project.root(), '.dispatch'), { recursive: true });
  writeFileSync(join(project.root(), '.dispatch', 'config.yml'), yaml);
}

async function liveRun(
  risk?: 'critical',
  extra: Parameters<typeof openRecovered>[4] = {}
) {
  const { orchestrator, store, events } = makeOrchestrator(project.root());
  const stalling = new StallingExecutor();
  orchestrator.registerExecutor('stalling', stalling);
  const broadcast: string[] = [];
  events.subscribe((e) => broadcast.push(e.type));
  const messaging = await openRecovered(
    project.root(),
    orchestrator,
    store,
    events,
    extra
  );
  const task = store.create({
    title: 'Touches routes',
    ...(risk === undefined ? {} : { risk }),
  });
  const meta = await orchestrator.dispatch(task.meta.id, 'stalling', {});
  const run: Sender = { address: `run:${meta.id}`, canDecide: false };
  return { orchestrator, messaging, meta, run, task, stalling, broadcast };
}

function askScope(
  messaging: Awaited<ReturnType<typeof liveRun>>['messaging'],
  run: Sender,
  paths = ['src/server/routes.ts']
) {
  return messaging.engine.send(
    {
      to: ['human:wyat'],
      kind: 'question',
      blocking: true,
      choices: ['grant', 'deny'],
      body: 'I need routes.ts',
      data: { type: 'scope', paths, reason: 'the handler lives there' },
    },
    run
  );
}

const ledger = () => new LedgerStore(project.root()).list();

describe('scope gates', () => {
  it('a human grant writes one ledger decision naming the gate', async () => {
    const { orchestrator, messaging, meta, run } = await liveRun();
    const { message: gate } = await askScope(messaging, run);
    await messaging.engine.reply(
      gate.id,
      { body: 'fine', choice: 'grant' },
      HUMAN
    );
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({
      kind: 'decision',
      title: `Scope extended for run ${meta.id}`,
      authoredBy: 'human:wyat',
    });
    expect(ledger()[0].detail).toEndWith(`[gate ${gate.id}]`);
    expect(activity).toEqual([]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('policy auto-grants at rung 2 as the system, once, even when replayed', async () => {
    setPolicy('policy:\n  rung: 2\n');
    const { orchestrator, messaging, meta, run, broadcast } = await liveRun();
    const { message: gate } = await askScope(messaging, run);
    await waitFor(() => messaging.engine.answerOf(gate.id) !== null);
    const answer = messaging.engine.answerOf(gate.id);
    expect(answer).toMatchObject({
      from: 'agent:dispatch',
      choice: 'grant',
      data: { type: 'x-policy', gate: 'scope', rung: 2 },
    });
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]?.authoredBy).toBe('human:wyat');
    expect(broadcast).toContain('ledger.changed');
    expect(activity).toHaveLength(1);
    expect(activity[0].text).toStartWith(
      `[policy] Scope extended for run ${meta.id}`
    );
    if (answer !== null) await messaging.gates.handle(gate, answer);
    expect(ledger()).toHaveLength(1);
    expect(activity).toHaveLength(1);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  // The live grant can fail, or a crash can land between the question and
  // it; the sweep grants what policy covers instead of leaving it to expire.
  it("the daemon's sweep grants a scope gate whose policy grant did not land", async () => {
    setPolicy('policy:\n  rung: 2\n');
    const { orchestrator, messaging, meta, run } = await liveRun(undefined, {
      scopeExpiry: { sweepMs: 10 },
    });
    const reply = messaging.engine.reply.bind(messaging.engine);
    let failures = 0;
    const replies = spyOn(messaging.engine, 'reply').mockImplementation(
      (id, input, sender) => {
        if (failures > 0) return reply(id, input, sender);
        failures++;
        return Promise.reject(new Error('disk full'));
      }
    );
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { message: gate } = await askScope(messaging, run);
      await waitFor(() => messaging.engine.answerOf(gate.id) !== null);
      expect(failures).toBe(1);
      expect(messaging.engine.answerOf(gate.id)).toMatchObject({
        from: 'agent:dispatch',
        choice: 'grant',
        data: { type: 'x-policy', gate: 'scope', rung: 2 },
      });
      expect(ledger()).toHaveLength(1);
    } finally {
      replies.mockRestore();
      logged.mockRestore();
    }
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('never auto-grants a path outside the repo or into .git', async () => {
    setPolicy('policy:\n  rung: 4\n');
    const { orchestrator, messaging, meta, run } = await liveRun();
    for (const paths of [
      ['../elsewhere/secret.ts'],
      ['.git/config'],
      ['src/ok.ts', '/etc/hosts'],
    ]) {
      const { message: gate } = await askScope(messaging, run, paths);
      await new Promise((r) => setTimeout(r, 20));
      expect([paths, messaging.engine.answerOf(gate.id)]).toEqual([
        paths,
        null,
      ]);
    }
    expect(ledger()).toEqual([]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('a block pin on the scope gate keeps it for a human over the rung', async () => {
    setPolicy('policy:\n  rung: 2\n  gates:\n    scope: block\n');
    const { orchestrator, messaging, meta, run } = await liveRun();
    const { message: gate } = await askScope(messaging, run);
    await new Promise((r) => setTimeout(r, 20));
    expect(messaging.engine.answerOf(gate.id)).toBeNull();
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it("a critical-risk task's scope gate waits for a human at any rung", async () => {
    setPolicy('policy:\n  rung: 4\n');
    const { orchestrator, messaging, meta, run } = await liveRun('critical');
    const { message: gate } = await askScope(messaging, run);
    await new Promise((r) => setTimeout(r, 20));
    expect(messaging.engine.answerOf(gate.id)).toBeNull();
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it("an execute run's scope gate outlives the run, and its answer reaches the task's next run", async () => {
    const { orchestrator, messaging, meta, run, task, stalling } =
      await liveRun();
    const { message: gate } = await askScope(messaging, run);
    await orchestrator.cancel(meta.id);
    expect(messaging.engine.answerOf(gate.id)).toBeNull();
    expect(closeOrphanedGates(messaging.engine, orchestrator)).toBe(0);
    await messaging.engine.reply(
      gate.id,
      { body: 'fine', choice: 'grant' },
      HUMAN
    );
    expect(ledger()).toHaveLength(1);
    const next = await orchestrator.dispatch(task.meta.id, 'stalling', {});
    await waitFor(() => stalling.sent.some((s) => s.includes('choice: grant')));
    await orchestrator.cancel(next.id);
    messaging.close();
  });

  it('a grant whose run is gone is marked applied, and the answerer is told', async () => {
    const { orchestrator, messaging, meta } = await liveRun();
    const question: Message = {
      id: 'm-scope0000000000000000000001',
      thread: 'm-scope0000000000000000000001',
      replyTo: null,
      from: 'run:r-0000ff',
      to: ['human:wyat'],
      kind: 'question',
      body: 'I need routes.ts',
      refs: [],
      urgent: false,
      blocking: true,
      choices: ['grant', 'deny'],
      wake: 'none',
      createdAt: '2026-09-25T10:00:00.000Z',
      data: {
        type: 'scope',
        paths: ['src/server/routes.ts'],
        reason: 'the handler lives there',
      },
    };
    const answer: Message = {
      ...question,
      id: 'm-grant',
      replyTo: question.id,
      kind: 'answer',
      from: 'human:wyat',
      to: ['run:r-0000ff'],
      blocking: false,
      choice: 'grant',
      data: undefined,
    };
    await expect(
      messaging.gates.handle(question, answer)
    ).resolves.toBeUndefined();
    expect(ledger()).toEqual([]);
    const notices = messaging.engine
      .inbox('human:wyat')
      .filter((i) => i.message.kind === 'notice');
    expect(notices.map((i) => i.message.body)).toEqual([
      'Not recorded: run r-0000ff or its task no longer exists, so this grant has no ledger entry.',
    ]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('an undecided scope gate expires as denied after 29 minutes', async () => {
    const { orchestrator, messaging, meta, run } = await liveRun();
    const { message: gate } = await askScope(messaging, run);
    expect(
      await expireScopeGates(
        messaging.engine,
        Date.parse(gate.createdAt) + SCOPE_GATE_TTL_MS - 1
      )
    ).toBe(0);
    expect(
      await expireScopeGates(
        messaging.engine,
        Date.parse(gate.createdAt) + SCOPE_GATE_TTL_MS + 1
      )
    ).toBe(1);
    expect(messaging.engine.answerOf(gate.id)).toMatchObject({
      from: 'agent:dispatch',
      choice: 'deny',
      data: { type: 'x-expired' },
    });
    expect(messaging.engine.answerOf(gate.id)?.body).toStartWith(
      `Expired: no one decided within ${SCOPE_GATE_TTL_MS / 60_000} minutes.`
    );
    expect(ledger()).toEqual([]);
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it("the daemon's own sweep denies a scope gate once its clock passes the TTL", async () => {
    const { orchestrator, messaging, meta, run } = await liveRun(undefined, {
      scopeExpiry: {
        sweepMs: 10,
        now: () => Date.now() + SCOPE_GATE_TTL_MS + 1000,
      },
    });
    const { message: gate } = await askScope(messaging, run);
    await waitFor(() => messaging.engine.answerOf(gate.id) !== null);
    expect(messaging.engine.answerOf(gate.id)?.data).toEqual({
      type: 'x-expired',
    });
    await orchestrator.cancel(meta.id);
    messaging.close();
  });

  it('a scope gate that cannot be denied does not stop the rest expiring', async () => {
    const { orchestrator, messaging, meta, run } = await liveRun();
    const { message: first } = await askScope(messaging, run, ['a.ts']);
    const { message: second } = await askScope(messaging, run, ['b.ts']);
    const reply = messaging.engine.reply.bind(messaging.engine);
    const replies = spyOn(messaging.engine, 'reply').mockImplementation(
      (id, input, sender) =>
        id === first.id
          ? Promise.reject(new Error('disk full'))
          : reply(id, input, sender)
    );
    const expired = await expireScopeGates(
      messaging.engine,
      Date.parse(second.createdAt) + SCOPE_GATE_TTL_MS + 1
    );
    replies.mockRestore();
    expect(expired).toBe(1);
    expect(messaging.engine.answerOf(first.id)).toBeNull();
    expect(messaging.engine.answerOf(second.id)?.data).toEqual({
      type: 'x-expired',
    });
    await orchestrator.cancel(meta.id);
    messaging.close();
  });
});
