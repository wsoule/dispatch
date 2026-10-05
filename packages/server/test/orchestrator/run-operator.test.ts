import { ActorContext } from '@dispatch-foo/core';
import { beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import type { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import {
  OrchestratorConflictError,
  runLineage,
  runOperator,
} from '../../src/orchestrator/types.js';
import type { RunMeta } from '../../src/orchestrator/types.js';
import {
  LINEAR_STATUSES,
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

  it('a follow-up acts for whoever asked for it, in the same lineage', async () => {
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
      operator: 'human:ada',
    });
    expect(runOperator(next)).toBe('human:ada');
    expect(runLineage(next)).toBe(first.id);
    const after = orch.sendMessage((await finished(next)).id, 'and the tests', {
      resume: true,
      actor: 'human:ada',
      operator: 'human:ada',
    });
    expect(runOperator(after)).toBe('human:ada');
    expect(runLineage(after)).toBe(first.id);
    await finished(after);
  });

  it('a follow-up by its own operator keeps them; one naming no operator acts for no one', async () => {
    const task = store.create({ title: 'd2' });
    const first = await finished(
      await orch.dispatch(task.meta.id, 'claude', {
        actor: 'human:wyat',
        operator: 'human:wyat',
      })
    );
    const same = orch.sendMessage(first.id, 'more', {
      resume: true,
      actor: 'human:wyat',
      operator: 'human:wyat',
    });
    expect(runOperator(same)).toBe('human:wyat');
    const unnamed = orch.sendMessage((await finished(same)).id, 'more', {
      resume: true,
      actor: 'none',
    });
    expect(runOperator(unnamed)).toBeNull();
    await finished(unnamed);
  });

  it('a wake acts for the operator it names, never the task’s last one', async () => {
    const task = store.create({ title: 'e' });
    await finished(
      await orch.dispatch(task.meta.id, 'claude', {
        actor: 'human:wyat',
        operator: 'human:wyat',
      })
    );
    const byAgent = await orch.wakeTask(task.meta.id, {
      actor: 'agent:dispatch',
      continueFinished: false,
      operator: null,
    });
    expect(runOperator(byAgent)).toBeNull();
    const byAda = await orch.wakeTask(task.meta.id, {
      actor: 'human:ada',
      continueFinished: true,
      operator: 'human:ada',
    });
    expect(byAda.resumedFrom).toBe((await finished(byAgent)).id);
    expect(runOperator(byAda)).toBe('human:ada');
    const named = orch.wakeRun((await finished(byAda)).id, {
      actor: 'human:bea',
      operator: 'human:bea',
    });
    expect(runOperator(named)).toBe('human:bea');
    await finished(named);
  });

  it('dispatchOrResume resumes a failed run for the operator it was asked for', async () => {
    orch.registerExecutor(
      'claude',
      new FakeExecutor({
        session: 'sess-3',
        finish: { state: 'failed', sessionId: 'sess-3', error: 'limit' },
      })
    );
    const task = store.create({ title: 'e2' });
    const failed = await settled(
      orch,
      await orch.dispatch(task.meta.id, 'claude', {
        actor: 'human:wyat',
        operator: 'human:wyat',
      }),
      'failed'
    );
    const resumed = await orch.dispatchOrResume(task.meta.id, {
      actor: 'human:ada',
      operator: 'human:ada',
    });
    expect(resumed.resumedFrom).toBe(failed.id);
    expect(runOperator(resumed)).toBe('human:ada');
    await settled(orch, resumed, 'failed');
  });

  it.each(['review', 'verify', 'execute'] as const)(
    'a %s aux run acts for the operator its starter names, not the task’s last run',
    async (kind) => {
      // `execute` is the fix loop's fresh implementer.
      const task = store.create({ title: `f-${kind}` });
      const exec = await finished(
        await orch.dispatch(task.meta.id, 'claude', {
          actor: 'human:wyat',
          operator: 'human:wyat',
        })
      );
      const aux = await orch.dispatchAuxRun({
        taskId: task.meta.id,
        kind,
        head: exec.branch,
        operator: 'human:ada',
        buildPrompt: () => kind,
      });
      expect(runOperator(aux)).toBe('human:ada');
      expect(runLineage(aux)).toBe(aux.id);
      await finished(aux);
    }
  );

  it('an aux run started for no one acts for no one, whoever ran the task', async () => {
    const task = store.create({ title: 'f-none' });
    const exec = await finished(
      await orch.dispatch(task.meta.id, 'claude', {
        actor: 'human:wyat',
        operator: 'human:wyat',
      })
    );
    const verify = await orch.dispatchAuxRun({
      taskId: task.meta.id,
      kind: 'verify',
      head: exec.branch,
      operator: null,
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
      operator: 'human:wyat',
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
    const resumed = orch.resumeRun(failed.id, { operator: 'human:wyat' });
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
    const resumed = orch.resumeRun(failed.id, {
      actor: 'human:ada',
      operator: 'human:ada',
    });
    expect(runOperator(resumed)).toBe('human:ada');
    expect(runLineage(resumed)).toBe(failed.id);
    const unnamed = orch.resumeRun((await settled(orch, resumed, 'failed')).id);
    expect(runOperator(unnamed)).toBeNull();
    await settled(orch, unnamed, 'failed');
  });

  it('the boot recovery sweep keeps the run’s own operator', async () => {
    orch.registerExecutor(
      'claude',
      new FakeExecutor({
        session: 'sess-4',
        finish: { state: 'failed', sessionId: 'sess-4', error: 'limit' },
      })
    );
    const task = store.create({ title: 'j' });
    const failed = await settled(
      orch,
      await orch.dispatch(task.meta.id, 'claude', {
        actor: 'human:wyat',
        operator: 'human:wyat',
      }),
      'failed'
    );
    const recovered = orch.resumeRun(failed.id, { auto: true });
    expect(runOperator(recovered)).toBe('human:wyat');
    await settled(orch, recovered, 'failed');
  });
});

describe('wakeTask', () => {
  // A human's wake would otherwise continue the finished session and reopen it.
  it.each(['Done', 'Canceled'])(
    'refuses a task in a %s status of a Linear-style model',
    async (status) => {
      writeFileSync(
        join(project.root(), '.dispatch', 'config.yml'),
        LINEAR_STATUSES
      );
      const task = store.create({ title: `closed-${status}` });
      await finished(
        await orch.dispatch(task.meta.id, 'claude', { actor: 'human:wyat' })
      );
      store.update(task.meta.id, { status });
      const runs = orch.list().length;
      await expect(
        orch.wakeTask(task.meta.id, {
          actor: 'human:wyat',
          continueFinished: true,
          operator: 'human:wyat',
        })
      ).rejects.toBeInstanceOf(OrchestratorConflictError);
      expect(orch.list().length).toBe(runs);
      expect(store.get(task.meta.id)?.meta.status).toBe(status);
    }
  );
});
