import { ActorContext } from '@dispatch/core';
import { beforeEach, describe, expect, it } from 'bun:test';

import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import type { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { runLineage, runOperator } from '../../src/orchestrator/types.js';
import type { RunMeta } from '../../src/orchestrator/types.js';
import {
  makeOrchestrator,
  useTempProject,
  waitFor,
} from '../messaging/harness.js';

const project = useTempProject();
let orch: Orchestrator;
let store: ReturnType<typeof makeOrchestrator>['store'];

beforeEach(() => {
  ({ orchestrator: orch, store } = makeOrchestrator(project.root()));
  orch.registerExecutor(
    'claude',
    new FakeExecutor({
      session: 'sess-1',
      finish: { state: 'finished', sessionId: 'sess-1' },
    })
  );
});

async function settled(
  o: Orchestrator,
  meta: RunMeta,
  state: RunMeta['state'] = 'finished'
): Promise<RunMeta> {
  await waitFor(() => o.list().find((r) => r.id === meta.id)?.state === state);
  return o.list().find((r) => r.id === meta.id)!;
}

function finished(meta: RunMeta): Promise<RunMeta> {
  return settled(orch, meta);
}

// The daemon's owner stamp, as index.ts resolves it from git config.
function ownerContext(): ActorContext {
  return ActorContext.resolve(project.root(), (args) =>
    args.includes('user.email') ? 'test@example.com' : 'Test'
  );
}

describe('who a run acts for', () => {
  it('a dispatch acts for the human its caller names', async () => {
    const task = store.create({ title: 'a' });
    const meta = await orch.dispatch(task.meta.id, 'claude', {
      actor: 'human:wyat',
      operator: 'human:wyat',
    });
    expect(runOperator(meta)).toBe('human:wyat');
    expect(runLineage(meta)).toBe(meta.id);
    await finished(meta);
  });

  // The orchestrator stamps dispatchedBy with the owner when no actor is
  // passed; that must not make the run act for the owner.
  it('a dispatch with no operator acts for no one, whatever dispatchedBy says', async () => {
    const owned = makeOrchestrator(project.root(), {
      actorContext: ownerContext(),
    });
    owned.orchestrator.registerExecutor(
      'claude',
      new FakeExecutor({ finish: { state: 'finished' } })
    );
    const task = owned.store.create({ title: 'a2' });
    const meta = await owned.orchestrator.dispatch(task.meta.id, 'claude');
    expect(meta.dispatchedBy).toBe('human:test');
    expect(meta.operator).toBeNull();
    expect(runOperator(meta)).toBeNull();
    await settled(owned.orchestrator, meta);
  });

  it('the auto-fill acts for the epic’s starter, or for no one', async () => {
    const task = store.create({ title: 'b' });
    const started = await orch.dispatchOrResume(task.meta.id, {
      actor: 'none',
      operator: 'human:ada',
    });
    expect(runOperator(started)).toBe('human:ada');
    const other = store.create({ title: 'c' });
    const unowned = await orch.dispatchOrResume(other.meta.id, {
      actor: 'none',
      operator: null,
    });
    expect(runOperator(unowned)).toBeNull();
    await finished(started);
    await finished(unowned);
  });

  it('a follow-up keeps the predecessor’s operator and lineage, whoever typed it', async () => {
    const task = store.create({ title: 'd' });
    const first = await finished(
      await orch.dispatch(task.meta.id, 'claude', {
        actor: 'human:wyat',
        operator: 'human:wyat',
      })
    );
    const next = orch.sendMessage(first.id, 'please also fix the docs', {
      resume: true,
      actor: 'human:ada',
    });
    expect(runOperator(next)).toBe('human:wyat');
    expect(runLineage(next)).toBe(first.id);
    const after = orch.sendMessage((await finished(next)).id, 'and the tests', {
      resume: true,
      actor: 'human:ada',
    });
    expect(runLineage(after)).toBe(first.id);
    await finished(after);
  });

  it('a wake by an agent acts for the task’s latest run’s operator', async () => {
    const task = store.create({ title: 'e' });
    await finished(
      await orch.dispatch(task.meta.id, 'claude', {
        actor: 'human:wyat',
        operator: 'human:wyat',
      })
    );
    const woken = await orch.wakeTask(task.meta.id, {
      actor: 'agent:dispatch',
      continueFinished: false,
    });
    expect(runOperator(woken)).toBe('human:wyat');
    await finished(woken);
  });

  it.each(['review', 'verify', 'execute'] as const)(
    'a %s aux run acts for the run it reviews, verifies or replaces',
    async (kind) => {
      // `execute` is the fix loop's fresh implementer.
      const task = store.create({ title: `f-${kind}` });
      const exec = await finished(
        await orch.dispatch(task.meta.id, 'claude', {
          actor: 'human:ada',
          operator: 'human:ada',
        })
      );
      const aux = await orch.dispatchAuxRun({
        taskId: task.meta.id,
        kind,
        head: exec.branch,
        buildPrompt: () => kind,
      });
      expect(runOperator(aux)).toBe('human:ada');
      expect(runLineage(aux)).toBe(aux.id);
      await finished(aux);
    }
  );

  it('an aux run of a task whose last run acted for no one acts for no one', async () => {
    const task = store.create({ title: 'f-none' });
    const exec = await finished(await orch.dispatch(task.meta.id, 'claude'));
    const verify = await orch.dispatchAuxRun({
      taskId: task.meta.id,
      kind: 'verify',
      head: exec.branch,
      buildPrompt: () => 'verify',
    });
    expect(runOperator(verify)).toBeNull();
    await finished(verify);
  });

  it('a run recorded before the field falls back to dispatchedBy, then to no one', () => {
    expect(runOperator({ dispatchedBy: 'human:wyat' })).toBe('human:wyat');
    expect(runOperator({})).toBeNull();
    expect(
      runOperator({ operator: null, dispatchedBy: 'human:wyat' })
    ).toBeNull();
    expect(runLineage({ id: 'r-old' })).toBe('r-old');
  });

  it('an A2A-provenance task’s runs act for no one, whoever dispatched them', async () => {
    const a2a = makeOrchestrator(project.root(), { isA2ATask: () => true });
    a2a.orchestrator.registerExecutor(
      'claude',
      new FakeExecutor({
        session: 'sess-a2a',
        finish: { state: 'finished', sessionId: 'sess-a2a' },
      })
    );
    const task = a2a.store.create({ title: 'g' });
    const first = await settled(
      a2a.orchestrator,
      await a2a.orchestrator.dispatch(task.meta.id, 'claude', {
        actor: 'human:wyat',
        operator: 'human:wyat',
      })
    );
    expect(runOperator(first)).toBeNull();
    const next = a2a.orchestrator.sendMessage(first.id, 'more', {
      resume: true,
      actor: 'human:wyat',
    });
    expect(runOperator(next)).toBeNull();
    await settled(a2a.orchestrator, next);
  });

  it('a non-continuing resume starts a new lineage', async () => {
    orch.registerExecutor(
      'claude',
      new FakeExecutor({ finish: { state: 'failed', error: 'boom' } })
    );
    const task = store.create({ title: 'h' });
    const failed = await settled(
      orch,
      await orch.dispatch(task.meta.id, 'claude', {
        actor: 'human:wyat',
        operator: 'human:wyat',
      }),
      'failed'
    );
    const resumed = orch.resumeRun(failed.id);
    expect(runOperator(resumed)).toBe('human:wyat');
    expect(runLineage(resumed)).toBe(resumed.id);
    await settled(orch, resumed, 'failed');
  });

  it('a continuing resume keeps the predecessor’s lineage', async () => {
    orch.registerExecutor(
      'claude',
      new FakeExecutor({
        session: 'sess-2',
        finish: { state: 'failed', sessionId: 'sess-2', error: 'limit' },
      })
    );
    const task = store.create({ title: 'i' });
    const failed = await settled(
      orch,
      await orch.dispatch(task.meta.id, 'claude', {
        actor: 'human:wyat',
        operator: 'human:wyat',
      }),
      'failed'
    );
    const resumed = orch.resumeRun(failed.id, { actor: 'human:ada' });
    expect(runOperator(resumed)).toBe('human:wyat');
    expect(runLineage(resumed)).toBe(failed.id);
    await settled(orch, resumed, 'failed');
  });
});
