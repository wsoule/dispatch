import type { Delivery } from '@dispatch/protocol';
import { describe, expect, it } from 'bun:test';

import {
  checkInboundRecipients,
  checkReachClient,
  clientNameFor,
  gateInScope,
  isClientAddress,
  isReservedName,
  normalizeName,
  replyChain,
  scopeOf,
} from '../src/policy.js';
import { CLIENT, msg, ROOT } from './facts.js';

const allowed = {
  allowedHumans: ['human:wyat', 'human:alice'],
  approvedTasks: new Set(['t-a1b2c3']),
};

describe('names', () => {
  it.each(['A2A.x', ' a2a.x', '-a2a.x'])(
    'reserves %j after normalization',
    (raw) => {
      expect(isReservedName(normalizeName(raw))).toBe(true);
    }
  );
  it('builds a client name within 40 characters', () => {
    expect(clientNameFor('Acme Planner')).toBe('a2a.acme-planner');
    expect(clientNameFor('x'.repeat(60))).toHaveLength(40);
  });
  it('recognizes client addresses', () => {
    expect(isClientAddress(CLIENT)).toBe(true);
    expect(isClientAddress('agent:wyat/claude')).toBe(false);
  });
});

describe('checkInboundRecipients', () => {
  it('accepts listed humans and approved handoff tasks', () => {
    expect(() =>
      checkInboundRecipients(['human:alice', 'task:t-a1b2c3'], allowed)
    ).not.toThrow();
  });
  it.each([
    'channel:ops',
    'run:r-000001',
    'agent:wyat/claude',
    'task:t-ffffff',
    'agent:dispatch',
    'a2a:acme',
  ])('refuses %s as FORBIDDEN_ADDRESS', (address) => {
    expect(() =>
      checkInboundRecipients(['human:wyat', address], allowed)
    ).toThrow(expect.objectContaining({ code: 'forbidden', field: 'to[1]' }));
  });
  it('gives the same error for an unlisted teammate and a stranger', () => {
    const error = (address: string) => {
      try {
        checkInboundRecipients([address], allowed);
      } catch (err) {
        return (err as Error).message.replace(address, '<addr>');
      }
      return null;
    };
    expect(error('human:bob')).toBe(error('human:nobody'));
  });
  it('refuses a task before its handoff was approved', () => {
    expect(() =>
      checkInboundRecipients(['task:t-0000aa'], {
        ...allowed,
        approvedTasks: new Set(),
      })
    ).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });
});

describe('checkReachClient', () => {
  it('refuses a message outside the client’s tasks', () => {
    expect(() =>
      checkReachClient(
        {},
        { inClientScope: false, fromApprovedLinkedTask: false },
        'to[0]'
      )
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        field: 'to[0]',
        message: 'A2A clients are reachable only inside their own tasks',
      })
    );
  });
  it('refuses gate data even in scope', () => {
    expect(() =>
      checkReachClient(
        { data: { type: 'scope', paths: ['a'], reason: 'r' } },
        { inClientScope: true, fromApprovedLinkedTask: false },
        'to[0]'
      )
    ).toThrow(expect.objectContaining({ code: 'forbidden', field: 'data' }));
  });
});

describe('scope', () => {
  const d = (messageId: string, recipient: string): Delivery => ({
    id: `d-${messageId}-${recipient}`,
    messageId,
    recipient,
    runId: null,
    via: 'direct',
    state: 'held',
    updatedAt: ROOT.createdAt,
  });

  it('keeps the root and replies to the client, drops a teammate’s reply to the owner and the gate answer', () => {
    const toClient = msg({
      id: 'm-a',
      replyTo: 'm-root',
      to: [CLIENT],
      kind: 'question',
      blocking: true,
    });
    const teammate = msg({
      id: 'm-b',
      replyTo: 'm-root',
      from: 'human:alice',
      to: ['human:wyat'],
    });
    const gate = msg({
      id: 'm-g',
      replyTo: 'm-root',
      from: 'agent:dispatch',
      to: ['human:wyat'],
      kind: 'question',
      data: { type: 'wake', target: 'task:t-1', message: 'm' },
    });
    const gateAnswer = msg({
      id: 'm-h',
      replyTo: 'm-g',
      from: 'human:wyat',
      to: ['agent:dispatch'],
      kind: 'answer',
      choice: 'approve',
    });
    const deliveries = new Map([
      ['m-a', [d('m-a', CLIENT)]],
      ['m-b', [d('m-b', 'human:wyat')]],
    ]);
    const scope = scopeOf({
      root: ROOT,
      client: CLIENT,
      candidates: [toClient, teammate, gate, gateAnswer],
      deliveries,
      link: null,
    });
    expect(scope.map((m) => m.id)).toEqual(['m-a', 'm-root'].sort());
  });

  it('adds an approved handoff’s traffic between the client and the linked task', () => {
    const link = {
      taskId: 't-a1b2c3',
      approved: true,
      runIds: new Set(['r-00000a']),
    };
    const fromRun = msg({
      id: 'm-r',
      thread: 'm-other',
      from: 'run:r-00000a',
      to: [CLIENT],
      kind: 'question',
      blocking: true,
    });
    const deliveries = new Map([['m-r', [d('m-r', CLIENT)]]]);
    expect(
      scopeOf({
        root: ROOT,
        client: CLIENT,
        candidates: [fromRun],
        deliveries,
        link,
      }).map((m) => m.id)
    ).toContain('m-r');
    expect(
      scopeOf({
        root: ROOT,
        client: CLIENT,
        candidates: [fromRun],
        deliveries,
        link: { ...link, approved: false },
      }).map((m) => m.id)
    ).not.toContain('m-r');
  });

  it('follows reply chains and stops on a cycle', () => {
    const a = msg({ id: 'm-x1', replyTo: 'm-x2' });
    const b = msg({ id: 'm-x2', replyTo: 'm-x1' });
    const all = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    expect(replyChain(a, (id) => all.get(id) ?? null)).toEqual([
      'm-x1',
      'm-x2',
    ]);
  });

  it('matches only the gates that belong to the task', () => {
    const link = {
      taskId: 't-a1b2c3',
      approved: true,
      runIds: new Set(['r-00000a']),
    };
    const tool = msg({
      from: 'agent:dispatch',
      kind: 'question',
      data: {
        type: 'tool-approval',
        requestId: 'q',
        runId: 'r-00000a',
        tool: 'Bash',
        input: {},
      },
    });
    const otherTool = msg({
      from: 'agent:dispatch',
      kind: 'question',
      data: {
        type: 'tool-approval',
        requestId: 'q',
        runId: 'r-0000ff',
        tool: 'Bash',
        input: {},
      },
    });
    const scope = msg({
      from: 'run:r-00000a',
      kind: 'question',
      data: { type: 'scope', paths: ['x'], reason: 'r' },
    });
    const wake = msg({
      from: 'agent:dispatch',
      kind: 'question',
      data: { type: 'wake', target: 'task:t-a1b2c3', message: 'm' },
    });
    expect(
      [tool, otherTool, scope, wake].map((q) => gateInScope(q, null, link))
    ).toEqual([true, false, true, true]);
    expect(gateInScope(tool, tool.id, null)).toBe(true);
  });
});
