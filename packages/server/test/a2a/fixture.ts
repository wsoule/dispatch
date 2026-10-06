import type { LookupAll } from '@dispatch-foo/a2a';
import {
  DEFAULT_HANDOFF_STATUSES,
  openA2ADb,
  SqliteA2AStore,
} from '@dispatch-foo/a2a';
import type { A2AConfig } from '@dispatch-foo/core';
import { DEFAULT_A2A } from '@dispatch-foo/core';

import { RunResultsMemo } from '../../src/a2a/artifacts.js';
import { tokenHash } from '../../src/a2a/auth.js';
import { bridgeExternalPolicy } from '../../src/a2a/external.js';
import { handleProposal } from '../../src/a2a/handoff.js';
import { startOutbound } from '../../src/a2a/outbound.js';
import type { PeerDeps } from '../../src/a2a/peers.js';
import { createPeerService } from '../../src/a2a/peers.js';
import type { BridgeDeps } from '../../src/a2a/port.js';
import { DaemonBridgePort } from '../../src/a2a/port.js';
import { PushWorker } from '../../src/a2a/push.js';
import { BridgeWatch } from '../../src/a2a/watch.js';
import { validateTaskInput } from '../../src/api.js';
import { TaskCache } from '../../src/cache.js';
import type { RunMeta } from '../../src/orchestrator/types.js';
import { makeOrchestrator, openRecovered } from '../messaging/harness.js';

// A bridge over a real engine and task store, with one approved client.
// `outbound` starts the outbound worker (polling every 20 ms); peers then get
// real fetches, so a test that opts in must point them at a local fixture.
export async function bridgeFixture(
  root: string,
  policy: Partial<A2AConfig> = {},
  opts: {
    outbound?: boolean;
    // Push seams: the webhook fetch and the resolver behind the push guard.
    pushFetch?: typeof fetch;
    lookup?: LookupAll;
  } = {}
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
  const deps: BridgeDeps & Pick<PeerDeps, 'fetchImpl' | 'lookup'> = {
    rootDir: root,
    engine: messaging.engine,
    messages: messaging.store,
    store,
    tasks,
    runs: orchestrator,
    ownerRef: 'human:wyat',
    policy: () => ({ ...DEFAULT_A2A, ...policy }),
    statuses: () => DEFAULT_HANDOFF_STATUSES,
    cardBase: () => ({ publicUrl: 'http://127.0.0.1:7450', version: 'test' }),
    validateTask: (input) => validateTaskInput(root, { ...input }),
    createTask: (input) => write(() => tasks.create(input)),
    updateTask: (id, patch) => write(() => tasks.update(id, patch)),
    runEvidence: () => [],
    runPatch: () => null,
    prOpen: () => false,
    runResults: new RunResultsMemo(),
    ...(opts.lookup === undefined ? {} : { lookup: opts.lookup }),
  };
  const push = new PushWorker({
    store,
    clientActive: (client) =>
      messaging.store.getAgent(client)?.status === 'approved',
    lookup: (host) =>
      (deps.lookup ?? (() => Promise.resolve([] as string[])))(host),
    delaysMs: [5, 5, 5],
    ...(opts.pushFetch === undefined ? {} : { fetchImpl: opts.pushFetch }),
  });
  const changed: string[] = [];
  const watch = new BridgeWatch({
    ...deps,
    events,
    coalesceMs: 5,
    onChanged: (row, facts) => {
      changed.push(row.id);
      push.onChanged(row, facts);
    },
  });
  const stopWatch = watch.start();
  const peers = createPeerService(deps);
  const notices = peers.notices;
  const peerDeps = (over: Partial<PeerDeps> = {}): PeerDeps => ({
    ...deps,
    ...over,
  });
  messaging.setExternalPolicy(bridgeExternalPolicy(deps, notices));
  const startWorker = () =>
    startOutbound(peers, {
      pollMs: () => 20,
      changed: () => events.broadcast({ type: 'a2a.changed' }),
    });
  let outbound = opts.outbound === true ? startWorker() : null;
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
    peers,
    notices,
    peerDeps,
    push,
    get outbound() {
      if (outbound === null)
        throw new Error('started without the outbound worker');
      return outbound.worker;
    },
    outboundStop() {
      outbound?.stop();
      outbound = null;
    },
    restartOutbound() {
      outbound?.stop();
      outbound = startWorker();
    },
    // Async: owner notices in flight finish before the database closes.
    async close() {
      outbound?.stop();
      stopWatch();
      await notices.drain();
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
