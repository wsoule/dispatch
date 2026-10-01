import type { A2AStore } from '@dispatch/a2a';
import { shapeDraft, wrapExternalData } from '@dispatch/a2a';
import type { TaskDoc, TaskStorePort } from '@dispatch/core';
import { newTaskDoc } from '@dispatch/core';
import type { DeliveryEngine, Message } from '@dispatch/protocol';
import { SYSTEM_ADDRESS } from '@dispatch/protocol';
import { expect, it } from 'bun:test';

import type { GuardDeps } from '../../src/a2a/guards.js';
import { dispatchRefusal, guardTaskPatch } from '../../src/a2a/guards.js';
import { proposalKey } from '../../src/a2a/handoff.js';

const CLIENT = 'agent:wyat/a2a.acme';
const NOW = '2026-09-30T00:00:00.000Z';
const agent = { tier: 'request' as const, ref: 'agent:wyat/bot' };

function message(m: Partial<Message> & { id: string }): Message {
  return {
    thread: m.id,
    replyTo: null,
    from: CLIENT,
    to: [SYSTEM_ADDRESS],
    kind: 'handoff',
    body: 'Please add limits.',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: NOW,
    ...m,
  };
}

// A client's handoff root and the draft shaped from it, as openHandoff builds them.
function handoff(rootId: string, taskId: string, title = 'Rate limits') {
  const work = { skill: 'handoff' as const, title };
  const root = message({
    id: rootId,
    data: wrapExternalData([{ work }]),
  });
  const draft = newTaskDoc(
    taskId,
    'task',
    shapeDraft(work, root.body, CLIENT, rootId, 'draft'),
    NOW
  );
  return { root, draft };
}

// The system's proposal gate on `rootId` for `taskId`.
function gate(rootId: string, taskId: string, extra: Partial<Message> = {}) {
  return message({
    id: `g-${rootId}`,
    thread: rootId,
    replyTo: rootId,
    from: SYSTEM_ADDRESS,
    to: ['human:wyat'],
    kind: 'question',
    blocking: true,
    data: {
      type: 'task-proposal',
      task: taskId,
      proposedBy: CLIENT,
      message: rootId,
    },
    ...extra,
  });
}

// Guard deps over in-memory messages, gates keyed by idempotency key, answers and tasks.
function fakeDeps(opts: {
  tasks: TaskDoc[];
  messages?: Message[];
  gates?: Message[];
  accepted?: string[];
  store?: A2AStore | null;
}): GuardDeps {
  const byId = new Map(
    [...(opts.messages ?? []), ...(opts.gates ?? [])].map((m) => [m.id, m])
  );
  const byKey = new Map(
    (opts.gates ?? []).map((g) => [proposalKey(g.replyTo ?? ''), g])
  );
  const accepted = new Set(opts.accepted ?? []);
  const engine = {
    openBlocking: () => [],
    getMessage: (id: string) => byId.get(id) ?? null,
    answerOf: (id: string) =>
      accepted.has(id) ? message({ id: `a-${id}`, choice: 'accept' }) : null,
  } as unknown as DeliveryEngine;
  const tasks = {
    get: (id: string) => opts.tasks.find((t) => t.meta.id === id) ?? null,
  } as unknown as TaskStorePort;
  return {
    engine,
    messages: {
      byIdemKey: (from, key) =>
        from === SYSTEM_ADDRESS ? (byKey.get(key) ?? null) : null,
    },
    tasks,
    ownerRef: 'human:wyat',
    updateTask: () => {
      throw new Error('unexpected update');
    },
    statuses: () => {
      throw new Error('unexpected statuses');
    },
    store: opts.store ?? null,
  };
}

// Two roots whose gates both name one draft: both must be accepted.
it('refuses a task two gates name when only one root was accepted', () => {
  const a = handoff('m-a', 't-1');
  const b = handoff('m-b', 't-2');
  const both: TaskDoc = {
    ...a.draft,
    body: `${a.draft.body}\n${b.draft.body}`,
  };
  const deps = fakeDeps({
    tasks: [both],
    messages: [a.root, b.root],
    gates: [gate('m-a', 't-1'), gate('m-b', 't-1')],
    accepted: ['m-a'],
  });
  expect(dispatchRefusal(deps, both)).toContain('has not approved');
  const all = fakeDeps({
    tasks: [both],
    messages: [a.root, b.root],
    gates: [gate('m-a', 't-1'), gate('m-b', 't-1')],
    accepted: ['m-a', 'm-b'],
  });
  expect(dispatchRefusal(all, both)).toBeNull();
});

it('does not count a gate received from another replica', () => {
  const { root, draft } = handoff('m-r', 't-1');
  const deps = fakeDeps({
    tasks: [draft],
    messages: [root],
    gates: [gate('m-r', 't-1', { origin: 'replica-2' })],
  });
  // The root has a gate, so it is not an orphan draft either.
  expect(dispatchRefusal(deps, draft)).toBeNull();
});

it('does not count a gate that names another task', () => {
  const { root, draft } = handoff('m-r', 't-1');
  const deps = fakeDeps({
    tasks: [draft],
    messages: [root],
    gates: [gate('m-r', 't-9')],
  });
  expect(dispatchRefusal(deps, draft)).toBeNull();
});

it('reads a draft with no gate as held only when its root drafted it', () => {
  const { root, draft } = handoff('m-o', 't-1');
  expect(
    dispatchRefusal(fakeDeps({ tasks: [draft], messages: [root] }), draft)
  ).toContain('has not approved');
  const renamed = { ...draft, meta: { ...draft.meta, title: 'Other' } };
  expect(
    dispatchRefusal(fakeDeps({ tasks: [renamed], messages: [root] }), renamed)
  ).toBeNull();
  // Its line must name the root's own client, and a2a.db must not link the root elsewhere.
  const otherClient = {
    ...draft,
    body: draft.body.replace(CLIENT, 'agent:wyat/a2a.other'),
  };
  expect(
    dispatchRefusal(
      fakeDeps({ tasks: [otherClient], messages: [root] }),
      otherClient
    )
  ).toBeNull();
  const linkedElsewhere = {
    getTask: () => ({ dispatchTask: 't-9' }),
    taskForDispatchTask: () => null,
  } as unknown as A2AStore;
  expect(
    dispatchRefusal(
      fakeDeps({ tasks: [draft], messages: [root], store: linkedElsewhere }),
      draft
    )
  ).toBeNull();
  for (const fake of [
    { ...root, from: 'agent:wyat/bot' },
    { ...root, kind: 'notice' as const },
    { ...root, to: ['human:wyat'] },
    { ...root, origin: 'replica-2' },
  ]) {
    expect(
      dispatchRefusal(fakeDeps({ tasks: [draft], messages: [fake] }), draft)
    ).toBeNull();
  }
});

it('refuses lowering the risk of an approved handoff with no a2a.db row', async () => {
  const { root, draft } = handoff('m-r', 't-1');
  const deps = fakeDeps({
    tasks: [draft],
    messages: [root],
    gates: [gate('m-r', 't-1')],
    accepted: ['m-r'],
  });
  expect(dispatchRefusal(deps, draft)).toBeNull();
  expect(
    await guardTaskPatch(deps, 't-1', { risk: 'routine' }, agent)
  ).toMatchObject({ ok: false, status: 403 });
  const local = newTaskDoc(
    't-2',
    'task',
    {
      title: 'Local',
      labels: ['a2a'],
      risk: 'critical',
      description: 'Requested over A2A by agent:wyat/a2a.acme (message m-r).',
    },
    NOW
  );
  const withLocal = fakeDeps({
    tasks: [draft, local],
    messages: [root],
    gates: [gate('m-r', 't-1')],
    accepted: ['m-r'],
  });
  expect(
    await guardTaskPatch(withLocal, 't-2', { risk: 'routine' }, agent)
  ).toEqual({ ok: true });
});
