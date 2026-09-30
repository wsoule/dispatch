import type { OpenInput, StatusVocabulary } from '@dispatch/a2a';
import {
  decideState,
  handoffStatuses,
  namedStatusVocabulary,
  wrapExternalData,
} from '@dispatch/a2a';
import {
  DEFAULT_A2A,
  effectiveRung,
  loadConfig,
  POLICY_GATES,
  projectPolicy,
} from '@dispatch/core';
import { gateOf, SYSTEM_ADDRESS } from '@dispatch/protocol';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

import type { GuardDeps } from '../../src/a2a/guards.js';
import {
  dispatchRefusal,
  guardTaskPatch,
  ProposalGuard,
} from '../../src/a2a/guards.js';
import { handleProposal } from '../../src/a2a/handoff.js';
import { reconcileA2A } from '../../src/a2a/reconcile.js';
import { consultProjectPolicy } from '../../src/policyEngine.js';
import { HUMAN, useTempProject } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
beforeEach(async () => {
  f = await bridgeFixture(project.root());
});
afterEach(() => f.close());

const handoff = (over: Partial<OpenInput> = {}): OpenInput => ({
  clientMessageId: 'c-h1',
  contextId: null,
  kind: 'handoff',
  to: null,
  replyTo: null,
  body: 'Please add limits.',
  refs: [],
  work: {
    skill: 'handoff',
    title: 'Rate-limit uploads',
    priority: 'urgent',
    labels: ['api'],
  },
  ...over,
});
async function open(over: Partial<OpenInput> = {}) {
  const r = await f.port.open(f.caller, handoff(over));
  if (r.kind !== 'task') throw new Error('expected a task');
  const row = f.store.getTask(r.taskId)!;
  return { id: r.taskId, row, draft: f.tasks.get(row.dispatchTask!)! };
}
const state = async (id: string) =>
  decideState((await f.port.facts(f.caller, id))!).state;
const gateQuestion = (row: { gate: string | null }) =>
  f.messaging.engine.getMessage(row.gate!)!;
const statusInput = (task?: string): OpenInput => ({
  clientMessageId: 'c-s',
  contextId: null,
  kind: 'status',
  to: null,
  replyTo: null,
  body: 'status',
  refs: [],
  work: task === undefined ? { skill: 'status' } : { skill: 'status', task },
});

describe('a handoff', () => {
  it('records a root to the system, a critical draft on the board, and a proposal gate to the owner', async () => {
    const { id, row, draft } = await open();
    expect(f.messaging.engine.getMessage(id)).toMatchObject({
      kind: 'handoff',
      to: ['agent:dispatch'],
      choices: ['accept', 'decline'],
    });
    expect(draft.meta).toMatchObject({
      status: 'draft',
      risk: 'critical',
      priority: 'medium',
      labels: ['a2a', 'a2a/api'],
    });
    expect(gateOf(gateQuestion(row))).toEqual({
      type: 'task-proposal',
      task: draft.meta.id,
      proposedBy: f.caller.address,
      message: id,
    });
    expect(gateQuestion(row).to).toEqual(['human:wyat']);
    expect(await state(id)).toBe('AUTH_REQUIRED');
  });

  // Every surface shows a gate body as plain text, so escaping would only add backslashes.
  it('quotes the client’s title verbatim in the gate body', async () => {
    const { row } = await open({
      work: { skill: 'handoff', title: '![x](https://host/beacon) *bold*' },
    });
    const body = gateQuestion(row).body;
    expect(body).toContain('"![x](https://host/beacon) *bold*"');
    expect(body).not.toContain('\\');
  });

  // The effective rung each gate uses for an A2A task is 1, in a project that
  // would otherwise auto-decide everything.
  it('runs every gate of an A2A draft at rung 1, even in a rung-4 project with approval pinned auto', async () => {
    mkdirSync(join(project.root(), '.dispatch'), { recursive: true });
    appendFileSync(
      join(project.root(), '.dispatch', 'config.yml'),
      '\npolicy:\n  rung: 4\n  gates:\n    approval: auto\n'
    );
    const policy = projectPolicy(loadConfig(project.root()));
    // The setup took: a bad file would fail closed and prove nothing.
    expect(policy).toEqual({ rung: 4, gates: { approval: 'auto' } });
    expect(
      consultProjectPolicy(project.root(), 'approval', 'routine').mode
    ).toBe('auto');
    const { row, draft } = await open();
    expect(draft.meta.risk).toBe('critical');
    expect(effectiveRung(policy, draft.meta.risk)).toBe(1);
    for (const gate of POLICY_GATES) {
      expect(
        consultProjectPolicy(project.root(), gate, draft.meta.risk).mode
      ).toBe('block');
    }
    // No rung auto-approves the proposal, not even on replay.
    await f.messaging.recover();
    expect(f.messaging.engine.answerOf(row.gate!)).toBeNull();
    expect(f.tasks.get(draft.meta.id)?.meta.status).toBe('draft');
  });

  it('is refused when the project’s statuses cannot carry it', async () => {
    const base = f.deps.statuses();
    f.deps.statuses = () =>
      handoffStatuses(namedStatusVocabulary(['todo', 'doing', 'done']));
    await expect(open()).rejects.toMatchObject({
      code: 'invalid',
      field: 'work.skill',
    });
    f.deps.statuses = () => base;
  });

  it('counts handoffs per day', async () => {
    const base = f.deps.policy();
    f.deps.policy = () => ({ ...base, handoffsPerDay: 1 });
    await open();
    await expect(open({ clientMessageId: 'c-h2' })).rejects.toMatchObject({
      code: 'limited',
    });
  });

  // A handoff is checked against every opener limit, not only handoffsPerDay.
  it('counts open tasks per client, asks and handoffs together', async () => {
    const base = f.deps.policy();
    f.deps.policy = () => ({ ...base, openTasksPerClient: 1 });
    await open();
    await expect(open({ clientMessageId: 'c-h2' })).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringContaining('open tasks'),
    });
    const ask: OpenInput = {
      clientMessageId: 'c-a1',
      contextId: null,
      kind: 'ask',
      to: null,
      replyTo: null,
      body: 'q',
      refs: [],
    };
    await expect(f.port.open(f.caller, ask)).rejects.toMatchObject({
      code: 'limited',
    });
  });

  it('counts a handoff against the durable sendsPerHour', async () => {
    const base = f.deps.policy();
    f.deps.policy = () => ({ ...base, sendsPerHour: 1 });
    await open();
    await expect(open({ clientMessageId: 'c-h2' })).rejects.toMatchObject({
      code: 'limited',
      message: expect.stringContaining('sends per hour'),
    });
  });

  it('refuses a ref to an id the client cannot see (400 on refs[0]) and stores nothing', async () => {
    const { message: other } = await f.messaging.engine.send(
      { to: ['human:alice'], kind: 'message', body: 'private' },
      HUMAN
    );
    await expect(
      open({ refs: [{ type: 'message', id: other.id }] })
    ).rejects.toMatchObject({ code: 'not-found', field: 'refs[0]' });
    expect(f.store.tasksOf(f.caller.address)).toHaveLength(0);
    expect(f.messaging.store.byIdemKey(f.caller.address, 'c-h1')).toBeNull();
  });

  // Only an approved handoff's Dispatch task id is visible to refs.
  it('accepts a ref to the draft’s task id only after approval', async () => {
    const { row, draft } = await open();
    const note = (id: string): OpenInput => ({
      clientMessageId: id,
      contextId: null,
      kind: 'message',
      to: null,
      replyTo: null,
      body: 'see the task',
      refs: [{ type: 'task', id: draft.meta.id }],
    });
    await expect(f.port.open(f.caller, note('c-r1'))).rejects.toMatchObject({
      code: 'not-found',
      field: 'refs[0]',
    });
    await f.messaging.engine.reply(
      row.gate!,
      { body: '', choice: 'approve' },
      HUMAN
    );
    expect((await f.port.open(f.caller, note('c-r2'))).kind).toBe('reply');
  });

  // Invalid client writes are refused before anything is stored.
  it.each([
    [['/etc/passwd']],
    [['src/../../outside.ts']],
    [Array.from({ length: 51 }, (_, i) => `src/f${i}.ts`)],
  ])(
    'refuses writes %j with a 400 and leaves no root, row or draft',
    async (writes) => {
      await expect(
        open({ work: { skill: 'handoff', title: 'Bad writes', writes } })
      ).rejects.toMatchObject({
        code: 'invalid',
        field: expect.stringMatching(/^work\.writes/),
      });
      expect(f.store.tasksOf(f.caller.address)).toHaveLength(0);
      expect(f.messaging.store.byIdemKey(f.caller.address, 'c-h1')).toBeNull();
      expect(
        f.tasks.list().filter((t) => t.meta.labels.includes('a2a'))
      ).toHaveLength(0);
    }
  );

  it('puts the draft in the task cache and broadcasts task.changed', async () => {
    const seen: string[] = [];
    const off = f.events.subscribe((e) => seen.push(e.type));
    const { draft } = await open();
    off();
    expect(seen).toContain('task.changed');
    expect(f.cache.get(draft.meta.id)?.meta.status).toBe('draft');
  });

  it('approval moves the draft to ready, answers the root accept, and reads SUBMITTED', async () => {
    const { id, row, draft } = await open();
    await f.messaging.engine.reply(
      row.gate!,
      { body: '', choice: 'approve' },
      HUMAN
    );
    expect(f.tasks.get(draft.meta.id)?.meta.status).toBe('ready');
    expect(f.messaging.engine.answerOf(id)).toMatchObject({
      choice: 'accept',
      refs: [{ type: 'task', id: draft.meta.id }],
    });
    expect(await state(id)).toBe('SUBMITTED');
  });

  it('decline drops the draft and reads REJECTED', async () => {
    const { id, row, draft } = await open();
    await f.messaging.engine.reply(
      row.gate!,
      { body: 'not now', choice: 'decline' },
      HUMAN
    );
    expect(f.tasks.get(draft.meta.id)?.meta.status).toBe('dropped');
    expect(await state(id)).toBe('REJECTED');
  });

  it('applies a replayed approval once', async () => {
    const { id, row } = await open();
    await f.messaging.engine.reply(
      row.gate!,
      { body: '', choice: 'approve' },
      HUMAN
    );
    const gate = gateQuestion(row);
    const answer = f.messaging.engine.answerOf(gate.id)!;
    await handleProposal(f.deps, f.watch, gate, answer);
    expect(
      f.messaging.engine
        .thread(id)
        .messages.filter((m) => m.kind === 'answer' && m.replyTo === id)
    ).toHaveLength(1);
  });

  it('ignores a task-proposal gate the bridge did not link to the root', async () => {
    const { row, draft } = await open();
    const stray = await f.messaging.engine.send(
      {
        to: ['human:wyat'],
        kind: 'question',
        blocking: true,
        choices: ['approve', 'decline'],
        body: 'x',
        data: {
          type: 'task-proposal',
          task: draft.meta.id,
          proposedBy: f.caller.address,
          message: row.id,
        },
      },
      { address: SYSTEM_ADDRESS, canDecide: true }
    );
    await f.messaging.engine.reply(
      stray.message.id,
      { body: '', choice: 'approve' },
      HUMAN
    );
    expect(f.tasks.get(draft.meta.id)?.meta.status).toBe('draft');
    expect(f.messaging.engine.answerOf(row.id)).toBeNull();
  });

  it('lets the client address the task only after approval, and routes continuations accordingly', async () => {
    const { id, row, draft } = await open();
    const ask = {
      clientMessageId: 'c-q',
      contextId: null,
      kind: 'ask' as const,
      to: [`task:${draft.meta.id}`],
      replyTo: null,
      body: 'status?',
      refs: [],
    };
    await expect(f.port.open(f.caller, ask)).rejects.toMatchObject({
      code: 'forbidden',
      field: 'to[0]',
    });
    await f.port.continue(f.caller, {
      clientMessageId: 'c-c1',
      taskId: id,
      contextId: null,
      body: 'One more detail',
      refs: [],
    });
    expect(f.messaging.engine.thread(id).messages.at(-1)?.to).toEqual([
      'human:wyat',
    ]);
    await f.messaging.engine.reply(
      row.gate!,
      { body: '', choice: 'approve' },
      HUMAN
    );
    await f.port.continue(f.caller, {
      clientMessageId: 'c-c2',
      taskId: id,
      contextId: null,
      body: 'And another',
      refs: [],
    });
    expect(f.messaging.engine.thread(id).messages.at(-1)?.to).toEqual([
      `task:${draft.meta.id}`,
    ]);
    expect((await f.port.open(f.caller, ask)).kind).toBe('task');
  });

  it('records a handoff cancel before closing its gate', async () => {
    const one = await open();
    const engine = f.messaging.engine;
    const close = engine.close.bind(engine);
    let atClose: string | null | undefined;
    const spy = spyOn(engine, 'close').mockImplementation((qid, reason) => {
      atClose = f.store.getTask(one.id)?.canceledAt;
      return close(qid, reason);
    });
    try {
      await f.port.cancel(f.caller, one.id);
    } finally {
      spy.mockRestore();
    }
    expect(atClose).toEqual(expect.any(String));
    expect(await state(one.id)).toBe('CANCELED');
  });

  it('cancels with the gate open (CANCELED, draft dropped) but not after approval', async () => {
    const one = await open();
    await f.port.cancel(f.caller, one.id);
    expect(f.tasks.get(one.draft.meta.id)?.meta.status).toBe('dropped');
    expect(await state(one.id)).toBe('CANCELED');
    expect(f.messaging.engine.answerOf(one.row.gate!)).not.toBeNull();
    const two = await open({ clientMessageId: 'c-h2' });
    await f.messaging.engine.reply(
      two.row.gate!,
      { body: '', choice: 'approve' },
      HUMAN
    );
    // Asking twice notifies the owner once.
    for (let i = 0; i < 2; i++) {
      await expect(f.port.cancel(f.caller, two.id)).rejects.toMatchObject({
        reason: 'TASK_NOT_CANCELABLE',
        message: expect.stringContaining('owner was notified'),
      });
    }
    expect(
      f.messaging.engine
        .inbox('human:wyat')
        .filter(
          ({ message }) =>
            message.kind === 'notice' &&
            message.body.includes('asked to cancel')
        )
    ).toHaveLength(1);
    expect(f.tasks.get(two.draft.meta.id)?.meta.status).toBe('ready');
  });

  it('answers the status skill with the caller’s handoffs only', async () => {
    const { id, draft } = await open();
    const reply = await f.port.open(f.caller, statusInput());
    expect(reply).toMatchObject({
      kind: 'reply',
      text: expect.stringContaining(draft.meta.id),
    });
    const second = await open({ clientMessageId: 'c-h2' });
    const one = await f.port.open(f.caller, statusInput(id));
    if (one.kind !== 'reply') throw new Error('expected a reply');
    expect(one.text).toContain(draft.meta.id);
    expect(one.text).not.toContain(second.draft.meta.id);
    const other = f.addClient('other');
    const none = await f.port.open(other, statusInput());
    expect(none).toMatchObject({ kind: 'reply', text: 'No handoffs yet.' });
    expect(await f.port.open(other, statusInput(id))).toMatchObject({
      text: 'No handoffs yet.',
    });
  });
});

describe('reconciliation', () => {
  it('finds a draft by its provenance line and sends a missing gate', async () => {
    const { id, draft } = await open();
    f.store.updateTask(id, { dispatchTask: null, gate: null });
    reconcileA2A(f.deps, f.watch);
    const row = f.store.getTask(id)!;
    expect(row.dispatchTask).toBe(draft.meta.id);
    expect(row.gate).not.toBeNull();
    expect(
      f.tasks.list().filter((t) => t.meta.labels.includes('a2a'))
    ).toHaveLength(1);
  });

  it('rebuilds a lost draft from the root’s data and sends its gate', async () => {
    const data = wrapExternalData([
      { work: { skill: 'handoff', title: 'Rate-limit uploads' } },
    ]);
    const { message } = await f.messaging.engine.send(
      {
        to: [SYSTEM_ADDRESS],
        kind: 'handoff',
        body: 'Please add limits.',
        idempotencyKey: 'c-h9',
        ...(data === undefined ? {} : { data }),
      },
      { address: f.caller.address, canDecide: false }
    );
    await reconcileA2A(f.deps, f.watch).settled;
    const row = f.store.getTask(message.id)!;
    expect(f.tasks.get(row.dispatchTask!)?.meta).toMatchObject({
      title: 'Rate-limit uploads',
      status: 'draft',
      risk: 'critical',
    });
    expect(gateOf(gateQuestion(row))).toMatchObject({
      type: 'task-proposal',
      task: row.dispatchTask,
      message: message.id,
    });
    expect(await state(message.id)).toBe('AUTH_REQUIRED');
  });

  // Boot replays gate answers before the bridge registers its handler.
  it('applies an owner’s answer the bridge missed', async () => {
    const { id, row, draft } = await open();
    f.messaging.gates.register('task-proposal', async () => {});
    await f.messaging.engine.reply(
      row.gate!,
      { body: '', choice: 'approve' },
      HUMAN
    );
    expect(f.tasks.get(draft.meta.id)?.meta.status).toBe('draft');
    await reconcileA2A(f.deps, f.watch).settled;
    expect(f.tasks.get(draft.meta.id)?.meta.status).toBe('ready');
    expect(f.messaging.engine.answerOf(id)).toMatchObject({ choice: 'accept' });
  });
});

describe('skills the owner does not offer', () => {
  const refused = async (input: OpenInput, message: string) => {
    const err = await f.port.open(f.caller, input).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid', message });
  };

  it('refuses a handoff and a status call when the card offers only ask', async () => {
    f.deps.policy = () => ({ ...DEFAULT_A2A, skills: ['ask'] });
    await refused(handoff(), 'this project does not take handoffs');
    await refused(
      statusInput(),
      'this project does not offer the status skill'
    );
    expect(f.tasks.list()).toHaveLength(0);
    const asked = await f.port.open(f.caller, {
      ...handoff({ clientMessageId: 'c-a1', kind: 'ask', work: undefined }),
    });
    expect(asked.kind).toBe('task');
  });

  it('refuses an ask and a plain message when the card offers only handoff', async () => {
    f.deps.policy = () => ({ ...DEFAULT_A2A, skills: ['handoff'] });
    for (const kind of ['ask', 'message'] as const)
      await refused(
        handoff({ clientMessageId: `c-${kind}`, kind, work: undefined }),
        'this project does not take questions or messages'
      );
    expect((await f.port.open(f.caller, handoff())).kind).toBe('task');
  });
});

describe('a proposal gate send that fails', () => {
  // Opens a handoff whose gate send throws once, as a crash after createTask would.
  async function openWithoutGate() {
    const engine = f.messaging.engine;
    const send = engine.send.bind(engine);
    engine.send = (input, sender) =>
      gateOf(input)?.type === 'task-proposal'
        ? Promise.reject(new Error('disk full'))
        : send(input, sender);
    await expect(f.port.open(f.caller, handoff())).rejects.toThrow('disk full');
    engine.send = send;
    const [row] = f.store.tasksOf(f.caller.address);
    return row;
  }
  const deps = (): GuardDeps => ({
    engine: f.messaging.engine,
    tasks: f.tasks,
    ownerRef: f.deps.ownerRef,
    updateTask: f.deps.updateTask,
    statuses: f.deps.statuses,
    store: f.store,
  });

  it('holds the gateless draft: no request-tier move and no dispatch', async () => {
    const row = await openWithoutGate();
    expect(row.dispatchTask).not.toBeNull();
    expect(row.gate).toBeNull();
    const guard = await guardTaskPatch(
      deps(),
      row.dispatchTask!,
      { status: 'ready' },
      { tier: 'request', ref: 'agent:wyat/codex' }
    );
    expect(guard.ok).toBe(false);
    expect(
      dispatchRefusal(deps(), f.tasks.get(row.dispatchTask!)!)
    ).not.toBeNull();
    expect(f.tasks.get(row.dispatchTask!)?.meta.status).toBe('draft');
  });

  it('sends the missing gate when the client retries the same message', async () => {
    const row = await openWithoutGate();
    const again = await f.port.open(f.caller, handoff());
    expect(again).toEqual({ kind: 'task', taskId: row.id });
    const after = f.store.getTask(row.id)!;
    expect(after.dispatchTask).toBe(row.dispatchTask);
    expect(gateOf(gateQuestion(after))).toMatchObject({
      type: 'task-proposal',
      task: row.dispatchTask,
    });
    expect(
      f.tasks.list().filter((t) => t.meta.labels.includes('a2a'))
    ).toHaveLength(1);
  });

  it('still holds a declined handoff’s task once its gate is answered', async () => {
    const { row, draft } = await open();
    await f.messaging.engine.reply(
      row.gate!,
      { body: '', choice: 'decline' },
      HUMAN
    );
    f.tasks.update(draft.meta.id, { status: 'ready' });
    expect(dispatchRefusal(deps(), f.tasks.get(draft.meta.id)!)).not.toBeNull();
  });
});

// A project whose statuses mirror Linear's workflow: no built-in names, so
// every read and write goes through the status model's types and roles.
const LINEAR: StatusVocabulary = {
  definitions: [
    { name: 'Triage', type: 'triage' },
    { name: 'Backlog', type: 'backlog' },
    { name: 'Todo', type: 'unstarted' },
    { name: 'In Progress', type: 'started' },
    { name: 'In Review', type: 'started' },
    { name: 'Done', type: 'completed' },
    { name: 'Canceled', type: 'canceled' },
    { name: 'Duplicate', type: 'canceled' },
  ],
  roles: {
    ready: 'Todo',
    review: 'In Review',
    landing: null,
    landed: 'Done',
    dropped: 'Canceled',
  },
};

describe('a handoff in a Linear-style project', () => {
  beforeEach(() => {
    const path = join(project.root(), '.dispatch', 'config.yml');
    const config = existsSync(path)
      ? (parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {};
    config.statuses = LINEAR.definitions.map((d) => d.name);
    writeFileSync(path, stringify(config));
    f.deps.statuses = () => handoffStatuses(LINEAR);
  });

  it('drafts in the backlog status and approves into the ready role', async () => {
    const { id, row, draft } = await open();
    expect(draft.meta.status).toBe('Backlog');
    await f.messaging.engine.reply(
      row.gate!,
      { body: '', choice: 'approve' },
      HUMAN
    );
    expect(f.tasks.get(draft.meta.id)?.meta.status).toBe('Todo');
    expect(await state(id)).toBe('SUBMITTED');
  });

  it('reads started, review and completed statuses by type and role', async () => {
    const { id, row, draft } = await open();
    await f.messaging.engine.reply(
      row.gate!,
      { body: '', choice: 'approve' },
      HUMAN
    );
    f.deps.updateTask(draft.meta.id, { status: 'In Progress' });
    expect(decideState((await f.port.facts(f.caller, id))!)).toMatchObject({
      state: 'WORKING',
    });
    f.deps.updateTask(draft.meta.id, { status: 'In Review' });
    expect(decideState((await f.port.facts(f.caller, id))!)).toMatchObject({
      state: 'WORKING',
      stage: 'review',
    });
    f.deps.updateTask(draft.meta.id, { status: 'Done' });
    expect(await state(id)).toBe('COMPLETED');
  });

  it('declines into the dropped role and reads REJECTED', async () => {
    const { id, row, draft } = await open();
    await f.messaging.engine.reply(
      row.gate!,
      { body: 'not now', choice: 'decline' },
      HUMAN
    );
    expect(f.tasks.get(draft.meta.id)?.meta.status).toBe('Canceled');
    expect(await state(id)).toBe('REJECTED');
  });

  it('reads a task canceled on the board as dropped by the owner', async () => {
    const { id, row, draft } = await open();
    await f.messaging.engine.reply(
      row.gate!,
      { body: '', choice: 'approve' },
      HUMAN
    );
    f.deps.updateTask(draft.meta.id, { status: 'Canceled' });
    expect(await state(id)).toBe('REJECTED');
  });

  // The guards: a status patch at decide is the owner's answer, and a draft
  // moved by anything else goes back to the backlog status.
  const guardDeps = (): GuardDeps => ({
    engine: f.messaging.engine,
    tasks: f.tasks,
    ownerRef: f.deps.ownerRef,
    updateTask: f.deps.updateTask,
    statuses: f.deps.statuses,
    store: f.store,
  });

  it('answers the gate from a decide-tier move to the ready role or the canceled type', async () => {
    const one = await open();
    const two = await open({ clientMessageId: 'c-h2' });
    const owner = { tier: 'decide' as const, ref: 'human:wyat' };
    await guardTaskPatch(
      guardDeps(),
      one.draft.meta.id,
      { status: 'Todo' },
      owner
    );
    await guardTaskPatch(
      guardDeps(),
      two.draft.meta.id,
      { status: 'Duplicate' },
      owner
    );
    expect(f.messaging.engine.answerOf(one.row.gate!)?.choice).toBe('approve');
    expect(f.messaging.engine.answerOf(two.row.gate!)?.choice).toBe('decline');
  });

  it('puts a gated draft moved to a started status back in the backlog status', async () => {
    const { draft } = await open();
    f.deps.updateTask(draft.meta.id, { status: 'In Progress' });
    const guard = new ProposalGuard(guardDeps(), f.events);
    expect(guard.revertIfMoved(draft.meta.id)).toBe(true);
    expect(f.tasks.get(draft.meta.id)?.meta.status).toBe('Backlog');
    expect(guard.revertIfMoved(draft.meta.id)).toBe(false);
  });
});
