import { beforeEach, describe, expect, it } from 'bun:test';

import type { ApiContext } from '../../src/api.js';
import {
  getThreadById,
  listAgentRoster,
  waitForAnswer,
} from '../../src/messaging/routes.js';
import type { Messaging } from '../../src/messaging/service.js';
import { makeOrchestrator, openRecovered, useTempProject } from './harness.js';

const project = useTempProject();
const BOB = 'bob-0000000b';

// A deciding human's context with a federation context that labels bob and
// names bob's machine as the one that registered agent:bob/codex.
function ctxFor(
  messaging: Messaging,
  observer: string | null = null
): ApiContext {
  return {
    principal: { address: 'human:wyat', canDecide: true, kind: 'human' },
    messaging,
    federation: {
      label: (r: string) => (r === BOB ? 'bob' : r),
      observer: () => observer,
      fed: {
        db: {
          query: () => ({ get: () => ({ replica: BOB }) }),
        },
      },
    },
  } as unknown as ApiContext;
}

let messaging: Messaging;
let questionId: string;
let thread: string;
beforeEach(async () => {
  const { orchestrator, store } = makeOrchestrator(project.root());
  messaging = await openRecovered(project.root(), orchestrator, store);
  const { message: q } = await messaging.engine.send(
    { to: ['human:wyat'], kind: 'question', blocking: true, body: 'q' },
    { address: 'agent:dispatch', canDecide: true }
  );
  questionId = q.id;
  thread = q.thread;
  messaging.store.insertRemote({
    messageId: q.id,
    recipient: 'human:bob',
    via: 'direct',
    state: 'read',
    homes: [BOB],
    wakeAt: null,
    refusedBy: [],
    updatedAt: '2026-09-26T10:00:00.000Z',
  });
  messaging.store.insertMessage(
    {
      id: 'm-09remote-answer',
      thread: q.thread,
      replyTo: q.id,
      from: 'human:bob',
      to: ['agent:dispatch'],
      kind: 'answer',
      body: 'yes',
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none',
      createdAt: '2026-09-26T10:01:00.000Z',
      origin: BOB,
      hlc: `1758880000000.0003.${BOB}`,
    },
    undefined,
    { receivedAt: '2026-09-26T10:01:01.000Z', settledAs: 'pending' }
  );
});

describe('GET /api/threads/:id with federated rows', () => {
  it("returns origin, remote deliveries and each question's settlement", async () => {
    const res = getThreadById(ctxFor(messaging), thread);
    const body = (await res.json()) as {
      messages: { id: string; origin?: string; remoteLabel?: string }[];
      deliveries: {
        messageId?: string;
        recipient: string;
        via?: string;
        remote?: boolean;
        state: string;
      }[];
      settlements: Record<string, string>;
      observer: string | null;
    };
    expect(
      body.messages.find((m) => m.id === 'm-09remote-answer')
    ).toMatchObject({
      origin: BOB,
      remoteLabel: 'bob',
      settledAs: 'pending',
    });
    expect(body.deliveries).toContainEqual({
      messageId: questionId,
      recipient: 'human:bob',
      via: 'direct',
      state: 'read',
      remote: true,
    });
    expect(body.settlements[questionId]).toBe('pending');
    expect(body.observer).toBeNull();
  });

  it('names an admitted observer only when a participant is remote', async () => {
    const res = getThreadById(ctxFor(messaging, "ops's server"), thread);
    expect(((await res.json()) as { observer: string | null }).observer).toBe(
      "ops's server"
    );
  });

  it('adds nothing without federation', async () => {
    const ctx = {
      ...ctxFor(messaging),
      federation: null,
    } as unknown as ApiContext;
    const body = (await getThreadById(ctx, thread).json()) as Record<
      string,
      unknown
    >;
    expect(body['settlements']).toBeUndefined();
    expect(body['observer']).toBeUndefined();
  });
});

describe('GET /api/messages/:id/answer on a replica that is not the settler', () => {
  it('reports the answer with its settlement', async () => {
    const url = new URL(`http://127.0.0.1/api/messages/${questionId}/answer`);
    const res = await waitForAnswer(
      new Request(url.toString()),
      ctxFor(messaging),
      questionId,
      url
    );
    expect(await res.json()).toMatchObject({
      answer: { id: 'm-09remote-answer' },
      settlement: 'pending',
    });
  });
});

describe('GET /api/agents/roster', () => {
  it("names a remote agent's machine, and never a token hash", async () => {
    messaging.store.putAgent({
      address: 'agent:bob/codex',
      displayName: 'codex',
      client: 'codex',
      tokenHash: 'remote:agent:bob/codex',
      status: 'approved',
      muted: false,
      approvedBy: null,
      createdAt: '2026-09-26T00:00:00.000Z',
    });
    const body = (await listAgentRoster(ctxFor(messaging)).json()) as {
      agents: { address: string; remote: string | null; tokenHash?: string }[];
    };
    const row = body.agents.find((a) => a.address === 'agent:bob/codex');
    expect(row).toMatchObject({ remote: 'bob' });
    expect(row?.tokenHash).toBeUndefined();
  });
});
