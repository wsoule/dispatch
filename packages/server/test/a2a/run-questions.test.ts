import type { ProjectionView } from '@dispatch/a2a';
import { decideState, project, taskEventStream } from '@dispatch/a2a';
import { gateOf } from '@dispatch/protocol';
import { afterEach, beforeEach, expect, it } from 'bun:test';

import {
  HUMAN,
  ParkingExecutor,
  useTempProject,
  waitFor,
} from '../messaging/harness.js';
import { approvedHandoff, bridgeFixture } from './fixture.js';

const projectDir = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
let executor: ParkingExecutor;
let rootId: string;
let draftId: string;
let runId: string;

beforeEach(async () => {
  f = await bridgeFixture(projectDir.root());
  executor = new ParkingExecutor();
  f.orchestrator.registerExecutor('park', executor);
  const handoff = await approvedHandoff(f);
  rootId = handoff.id;
  draftId = handoff.row.dispatchTask!;
  runId = (await f.orchestrator.dispatch(draftId, 'park')).id;
});
afterEach(() => f.close());

const view: ProjectionView = {
  client: '',
  extensions: new Set(),
  textMediaType: 'text/markdown',
  historyLength: null,
  includeArtifacts: true,
};
const asRun = (id: string) => ({ address: `run:${id}`, canDecide: false });
const runAsks = () =>
  f.messaging.engine.send(
    {
      to: [f.caller.address],
      kind: 'question',
      blocking: true,
      body: 'Which endpoint?',
      choices: ['/upload', '/import'],
    },
    asRun(runId)
  );

it('a run of the approved task asks the client, the client answers, the run’s question is answered', async () => {
  const { message: q } = await runAsks();
  expect(decideState((await f.port.facts(f.caller, rootId))!).state).toBe(
    'INPUT_REQUIRED'
  );
  await f.port.continue(f.caller, {
    clientMessageId: 'c-r1',
    taskId: rootId,
    contextId: null,
    body: '/upload',
    refs: [],
  });
  expect(f.messaging.engine.answerOf(q.id)).toMatchObject({
    choice: '/upload',
  });
});

it('lets the task itself message the client', async () => {
  const { message } = await f.messaging.engine.send(
    { to: [f.caller.address], kind: 'message', body: 'Started.' },
    { address: `task:${draftId}`, canDecide: false }
  );
  expect(
    f.messaging.engine.inbox(f.caller.address).map((entry) => entry.message.id)
  ).toContain(message.id);
});

it('refuses the task of a handoff still awaiting its proposal', async () => {
  const opened = await f.port.open(f.caller, {
    clientMessageId: 'c-h2',
    contextId: null,
    kind: 'handoff',
    to: null,
    replyTo: null,
    body: 'Also add quotas.',
    refs: [],
    work: { skill: 'handoff', title: 'Upload quotas' },
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  const pending = f.store.getTask(opened.taskId)!.dispatchTask!;
  // Sent as the draft task, as a human acting as it would.
  await expect(
    f.messaging.engine.send(
      { to: [f.caller.address], kind: 'message', body: 'Starting early.' },
      { address: `task:${pending}`, canDecide: false }
    )
  ).rejects.toMatchObject({ code: 'invalid', field: 'to[0]' });
});

it('refuses a run of an unrelated task reaching the client', async () => {
  const other = f.tasks.create({ title: 'unrelated work', status: 'ready' });
  const otherRun = await f.orchestrator.dispatch(other.meta.id, 'park');
  await expect(
    f.messaging.engine.send(
      { to: [f.caller.address], kind: 'message', body: 'hi' },
      asRun(otherRun.id)
    )
  ).rejects.toMatchObject({ code: 'invalid', field: 'to[0]' });
});

it('refuses a run of the task once its handoff has finished', async () => {
  f.deps.updateTask(draftId, { status: 'landed' });
  await waitFor(() => f.store.getTask(rootId)?.state === 'COMPLETED');
  await expect(
    f.messaging.engine.send(
      { to: [f.caller.address], kind: 'message', body: 'one more thing' },
      asRun(runId)
    )
  ).rejects.toMatchObject({ code: 'invalid', field: 'to[0]' });
});

it('refuses a run of another client’s approved task', async () => {
  const other = f.addClient('other');
  await expect(
    f.messaging.engine.send(
      { to: [other.address], kind: 'message', body: 'hi' },
      asRun(runId)
    )
  ).rejects.toMatchObject({ code: 'invalid', field: 'to[0]' });
});

it('shows the run’s tool-approval gate as AUTH_REQUIRED without its payload', async () => {
  executor.park('req-1', 'Bash', { command: 'SECRET_INPUT' });
  await waitFor(() =>
    f.messaging.engine
      .openBlocking()
      .some((q) => gateOf(q)?.type === 'tool-approval')
  );
  const facts = (await f.port.facts(f.caller, rootId))!;
  expect(decideState(facts).state).toBe('AUTH_REQUIRED');
  expect(facts.openGates.map((g) => g.type)).toEqual(['tool-approval']);
  const wire = JSON.stringify(
    project(facts, { ...view, client: f.caller.address })
  );
  expect(wire).not.toContain('SECRET_INPUT');
  expect(wire).not.toContain('"input"');
});

// The watch reacts to the linked task's traffic, not only the A2A thread's.
it('fires watchers and rewrites the ListTasks state cache when the run asks', async () => {
  // The dispatch's own recompute lands first, so only the question can fire.
  await waitFor(() => f.store.getTask(rootId)?.state === 'WORKING');
  let fired = 0;
  const stop = f.port.watch(f.caller, rootId, () => {
    fired += 1;
  });
  await runAsks();
  await waitFor(() => fired > 0);
  stop();
  expect(f.store.getTask(rootId)?.state).toBe('INPUT_REQUIRED');
  expect(
    (await f.port.list(f.caller, { pageSize: 10, state: 'INPUT_REQUIRED' })).ids
  ).toEqual([rootId]);
});

it('recomputes on the run’s gate and again when the owner answers it', async () => {
  executor.park('req-2', 'Bash', { command: 'ls' });
  await waitFor(() => f.store.getTask(rootId)?.state === 'AUTH_REQUIRED');
  const gate = f.messaging.engine
    .openBlocking()
    .find((q) => gateOf(q)?.type === 'tool-approval')!;
  await f.messaging.engine.reply(
    gate.id,
    { body: '', choice: 'approve' },
    HUMAN
  );
  await waitFor(() => f.store.getTask(rootId)?.state !== 'AUTH_REQUIRED');
});

it('streams the INPUT_REQUIRED a run’s question causes, over the daemon port', async () => {
  const aborter = new AbortController();
  const res = taskEventStream({
    port: f.port,
    caller: f.caller,
    stillAllowed: async () => (await f.port.authenticate('tok-acme')).ok,
    taskId: rootId,
    view: { ...view, client: f.caller.address },
    release: () => {},
    signal: aborter.signal,
    tickMs: 20,
    keepaliveMs: 60_000,
  });
  setTimeout(() => void runAsks(), 50);
  // The stream closes on INPUT_REQUIRED.
  const text = await res.text();
  aborter.abort();
  expect(text).toContain('TASK_STATE_INPUT_REQUIRED');
});
