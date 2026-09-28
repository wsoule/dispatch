import { openA2ADb, SqliteA2AStore } from '@dispatch/a2a';
import type { A2AConfig } from '@dispatch/core';
import { CANONICAL_STATUSES, DEFAULT_A2A } from '@dispatch/core';

import { RunResultsMemo } from '../../src/a2a/artifacts.js';
import { tokenHash } from '../../src/a2a/auth.js';
import { bridgeExternalPolicy } from '../../src/a2a/external.js';
import { handleProposal } from '../../src/a2a/handoff.js';
import type { BridgeDeps } from '../../src/a2a/port.js';
import { DaemonBridgePort } from '../../src/a2a/port.js';
import { BridgeWatch } from '../../src/a2a/watch.js';
import { validateTaskInput } from '../../src/api.js';
import { TaskCache } from '../../src/cache.js';
import type { RunMeta } from '../../src/orchestrator/types.js';
import { makeOrchestrator, openRecovered } from '../messaging/harness.js';

// A bridge over a real engine and task store, with one approved client.
export async function bridgeFixture(
  root: string,
  policy: Partial<A2AConfig> = {}
) {
  const { orchestrator, store: tasks, events } = makeOrchestrator(root);
  const messaging = await openRecovered(root, orchestrator, tasks, events);
  const store = new SqliteA2AStore(openA2ADb(':memory:'));
  const cache = new TaskCache();
  cache.rebuild(tasks);
  // A task write as the daemon makes it: the store, then the cache and bus.
  const write = <T>(fn: () => T): T => {
    const out = fn();
    cache.rebuild(tasks);
    events.broadcast({ type: 'task.changed' });
    return out;
  };
  const deps: BridgeDeps = {
    rootDir: root,
    engine: messaging.engine,
    messages: messaging.store,
    store,
    tasks,
    runs: orchestrator,
    ownerRef: 'human:wyat',
    policy: () => ({ ...DEFAULT_A2A, ...policy }),
    statuses: () => [...CANONICAL_STATUSES],
    cardBase: () => ({ publicUrl: 'http://127.0.0.1:7450', version: 'test' }),
    validateTask: (input) => validateTaskInput(root, { ...input }),
    createTask: (input) => write(() => tasks.create(input)),
    updateTask: (id, patch) => write(() => tasks.update(id, patch)),
    runEvidence: () => [],
    runPatch: () => null,
    prOpen: () => false,
    runResults: new RunResultsMemo(),
  };
  const changed: string[] = [];
  const watch = new BridgeWatch({
    ...deps,
    events,
    coalesceMs: 5,
    onChanged: (row) => changed.push(row.id),
  });
  const stopWatch = watch.start();
  messaging.setExternalPolicy(bridgeExternalPolicy(deps));
  messaging.gates.register('task-proposal', (q, a) =>
    handleProposal(deps, watch, q, a)
  );
  const port = new DaemonBridgePort(deps, watch);
  const addClient = (name: string, recipients: string[] = []) => {
    const address = `agent:wyat/a2a.${name}`;
    const now = new Date().toISOString();
    messaging.store.putAgent({
      address,
      displayName: name,
      client: 'a2a',
      tokenHash: tokenHash(`tok-${name}`),
      status: 'approved',
      muted: false,
      approvedBy: 'human:wyat',
      createdAt: now,
    });
    store.putClient({
      address,
      name: `a2a.${name}`,
      recipients,
      createdBy: 'human:wyat',
      createdAt: now,
    });
    return { address, name: `a2a.${name}` };
  };
  const caller = addClient('acme');
  return {
    deps,
    messaging,
    store,
    tasks,
    cache,
    orchestrator,
    events,
    watch,
    port,
    caller,
    addClient,
    changed,
    close() {
      stopWatch();
      messaging.close();
      store.close();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof bridgeFixture>>;

// A handoff the owner has approved; returns the A2A task id, its row and the draft.
export async function approvedHandoff(f: Fixture, clientMessageId = 'c-h1') {
  const opened = await f.port.open(f.caller, {
    clientMessageId,
    contextId: null,
    kind: 'handoff',
    to: null,
    replyTo: null,
    body: 'Please add limits.',
    refs: [],
    work: { skill: 'handoff', title: 'Rate-limit uploads' },
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  const row = f.store.getTask(opened.taskId)!;
  await f.messaging.engine.reply(
    row.gate!,
    { body: '', choice: 'approve' },
    { address: 'human:wyat', canDecide: true }
  );
  return {
    id: opened.taskId,
    row: f.store.getTask(opened.taskId)!,
    draft: f.tasks.get(row.dispatchTask!)!,
  };
}

// Makes deps.runs.list() report one extra RunMeta, as a landed run would leave
// it (finished unless `state` says otherwise); returns that meta to mutate.
export function stubRun(
  f: Fixture,
  meta: Pick<RunMeta, 'id' | 'taskId' | 'kind' | 'createdAt'> &
    Partial<Pick<RunMeta, 'state' | 'updatedAt' | 'prUrl'>>
): RunMeta {
  const run = {
    state: 'finished',
    updatedAt: meta.createdAt,
    ...meta,
  } as RunMeta;
  const real = f.deps.runs;
  f.deps.runs = {
    list: () => [...real.list(), run],
    taskIdOfRun: (id) => (id === run.id ? run.taskId : real.taskIdOfRun(id)),
  };
  return run;
}
