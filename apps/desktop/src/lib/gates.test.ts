import type { Message } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import {
  approvalReply,
  findOverseerActionGate,
  findOverseerApprovalGate,
  findToolApprovalGate,
  foldsIntoOpenApproval,
  gateNotification,
  gateOf,
  isSystemMarker,
  openGatesAfter,
  questionsByRun,
  runIdOf,
  scopeRequestsByRun,
  toRunQuestion,
  toScopeRequest,
} from './gates';
import { isKindEnabled } from './notificationEdges';
import { pendingApprovalsFromGates } from './pendingApprovals';

function msg(id: string, over: Partial<Message>): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'agent:dispatch',
    to: ['human:wyat'],
    kind: 'question',
    body: 'q',
    refs: [],
    urgent: false,
    blocking: true,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}
const approval = msg('m-a', {
  choices: ['approve', 'approve-session', 'deny'],
  data: {
    type: 'tool-approval',
    requestId: 'req-1',
    runId: 'r-1',
    tool: 'Bash',
    input: { command: 'ls' },
  },
});
const scope = msg('m-s', {
  from: 'run:r-1',
  choices: ['grant', 'deny'],
  data: { type: 'scope', paths: ['a.ts'], reason: 'needed' },
});
const question = msg('m-q', {
  from: 'run:r-1',
  body: 'Which cart?',
  choices: ['old', 'new'],
});
const wake = msg('m-w', {
  choices: ['approve', 'deny'],
  body: 'run:r-2 wants to wake task:t-2',
  data: { type: 'wake', target: 'task:t-2', message: 'm-x' },
});
const overseer = msg('m-o', {
  choices: ['confirm', 'cancel'],
  data: {
    type: 'overseer-action',
    conversation: 'wc-1',
    actionId: 'a-1',
    summary: 'Dispatch t-1',
  },
});
const ALL_ON = {
  approval: true,
  'scope-request': true,
  memory: true,
  question: true,
  'fix-loop-capped': true,
  'run-stalled': true,
};

describe('gate adapters', () => {
  it('turns each gate into the shape its card takes, and nothing else', () => {
    expect(toRunQuestion(question)).toEqual({
      id: 'm-q',
      runId: 'r-1',
      question: 'Which cart?',
      options: ['old', 'new'],
      askedAt: question.createdAt,
      answer: null,
      answeredAt: null,
    });
    expect(toRunQuestion(scope)).toBeNull();
    expect(toScopeRequest(scope)).toMatchObject({
      id: 'm-s',
      runId: 'r-1',
      paths: ['a.ts'],
      reason: 'needed',
      granted: null,
    });
    expect(toScopeRequest(question)).toBeNull();
    expect(
      questionsByRun([approval, scope, question])
        .get('r-1')
        ?.map((q) => q.id)
    ).toEqual(['m-q']);
    expect(scopeRequestsByRun([scope]).get('r-1')).toMatchObject({
      id: 'm-s',
      runId: 'r-1',
      paths: ['a.ts'],
    });
    expect(findToolApprovalGate([approval], 'r-1', 'req-1')?.id).toBe('m-a');
    expect(findToolApprovalGate([approval], 'r-1', 'req-2')).toBeNull();
  });

  it('keeps only awaiting-approval runs once runs have loaded', () => {
    expect(pendingApprovalsFromGates([approval], undefined).get('r-1')).toEqual(
      [
        {
          requestId: 'req-1',
          toolName: 'Bash',
          input: { command: 'ls' },
          truncated: false,
        },
      ]
    );
    expect(
      pendingApprovalsFromGates(
        [approval],
        [{ id: 'r-1', state: 'running' } as never]
      ).size
    ).toBe(0);
  });

  it('maps card decisions onto gate choices', () => {
    expect(approvalReply(true)).toEqual({ body: '', choice: 'approve' });
    expect(approvalReply(true, { scope: 'session' })).toEqual({
      body: '',
      choice: 'approve-session',
    });
    expect(approvalReply(false, { reason: 'no' })).toEqual({
      body: 'no',
      choice: 'deny',
    });
  });

  it('names the run a message came from or is about', () => {
    expect(runIdOf(question)).toBe('r-1');
    expect(runIdOf(approval)).toBe('r-1');
    expect(runIdOf(wake)).toBeNull();
    expect(runIdOf(msg('m-t', { from: 'task:t-1' }))).toBeNull();
  });

  it('a question from an agent that is not a run has no run card', () => {
    expect(toRunQuestion(msg('m-g', { from: 'agent:wyat/codex' }))).toBeNull();
    expect(toScopeRequest({ ...scope, from: 'agent:wyat/codex' })).toBeNull();
  });

  it('keeps the newest scope request per run', () => {
    const later = {
      ...scope,
      id: 'm-s2',
      createdAt: '2026-09-25T10:05:00.000Z',
    };
    expect(scopeRequestsByRun([later, scope]).get('r-1')?.id).toBe('m-s2');
  });

  it('finds overseer gates by conversation and action or request', () => {
    const tool = msg('m-t', {
      data: {
        type: 'tool-approval',
        requestId: 'rq-1',
        conversation: 'wc-1',
        tool: 'Bash',
        input: {},
      },
    });
    expect(findOverseerActionGate([overseer], 'wc-1', 'a-1')?.id).toBe('m-o');
    expect(findOverseerActionGate([overseer], 'wc-2', 'a-1')).toBeNull();
    expect(findOverseerApprovalGate([tool, approval], 'wc-1', 'rq-1')?.id).toBe(
      'm-t'
    );
    expect(findOverseerApprovalGate([approval], 'wc-1', 'req-1')).toBeNull();
  });
});

describe('gateNotification', () => {
  it('notifies a tool approval as today, under the approval toggle', () => {
    expect(gateNotification(approval, () => 'Checkout')).toEqual({
      title: 'Approval needed',
      body: 'Bash · Checkout',
      kind: 'approval',
    });
  });
  it('a wake gate notifies under approval, so switching approval off silences it', () => {
    const note = gateNotification(wake, () => undefined);
    expect(note?.kind).toBe('approval');
    expect(isKindEnabled({ ...ALL_ON, approval: false }, note?.kind)).toBe(
      false
    );
  });
  it('leaves run questions to the edge detector and overseer gates to the chat', () => {
    expect(gateNotification(question, () => 'Checkout')).toBeNull();
    expect(gateNotification(overseer, () => undefined)).toBeNull();
    expect(
      gateNotification(
        { ...question, kind: 'answer', blocking: false },
        () => undefined
      )
    ).toBeNull();
  });
  it('titles a scope gate with its task and an agent question with its first line', () => {
    expect(gateNotification(scope, () => 'Checkout')).toEqual({
      title: 'An agent needs scope approval',
      body: 'Checkout',
      kind: 'scope-request',
    });
    expect(
      gateNotification(
        msg('m-g', { from: 'agent:wyat/codex', body: 'Ship it?\nDetails' }),
        () => undefined
      )
    ).toEqual({
      title: 'An agent has a question',
      body: 'Ship it?',
      kind: 'question',
    });
  });
  it('stays quiet for a gate no human is asked, and for an overseer tool approval', () => {
    expect(
      gateNotification({ ...approval, to: ['agent:wyat/codex'] }, () => 'x')
    ).toBeNull();
    const chatApproval = msg('m-c', {
      choices: ['approve', 'approve-session', 'deny'],
      data: {
        type: 'tool-approval',
        requestId: 'req-9',
        conversation: 'wc-1',
        tool: 'Bash',
        input: {},
      },
    });
    expect(gateNotification(chatApproval, () => undefined)).toBeNull();
  });
});

describe('foldsIntoOpenApproval', () => {
  it("folds a run's next tool approval into the one it is already waiting on", () => {
    const second = msg('m-a2', {
      choices: ['approve', 'approve-session', 'deny'],
      data: {
        type: 'tool-approval',
        requestId: 'req-2',
        runId: 'r-1',
        tool: 'Edit',
        input: {},
      },
    });
    expect(foldsIntoOpenApproval(second, [approval])).toBe(true);
    // The gate itself, already in the cache, is not a second one.
    expect(foldsIntoOpenApproval(approval, [approval])).toBe(false);
    expect(
      foldsIntoOpenApproval(
        { ...second, data: { ...(second.data as object), runId: 'r-2' } },
        [approval]
      )
    ).toBe(false);
    expect(foldsIntoOpenApproval(wake, [approval])).toBe(false);
  });
});

describe('openGatesAfter', () => {
  const answer = (replyTo: string) =>
    msg('m-ans', {
      from: 'human:ada',
      to: ['agent:dispatch'],
      kind: 'answer',
      blocking: false,
      replyTo,
      choice: 'approve',
    });

  // Answered in another window, the gate leaves the list before any refetch.
  it('drops the gate an answer replies to', () => {
    expect(openGatesAfter([approval, wake], answer('m-a'))).toEqual([wake]);
  });

  it('adds a new blocking message a human is asked, once', () => {
    const open = openGatesAfter([approval], wake);
    expect(open).toEqual([approval, wake]);
    expect(openGatesAfter(open, wake)).toBe(open);
  });

  it('keeps the list for what opens or closes no human gate', () => {
    const open = [approval];
    expect(openGatesAfter(open, answer('m-unknown'))).toBe(open);
    expect(
      openGatesAfter(open, msg('m-agents', { to: ['agent:reviewer'] }))
    ).toBe(open);
    expect(
      openGatesAfter(open, msg('m-plain', { kind: 'message', blocking: false }))
    ).toBe(open);
  });
});

describe('gateOf', () => {
  it('narrows gate data and ignores plain, x- and malformed data', () => {
    expect(gateOf(approval)?.type).toBe('tool-approval');
    expect(gateOf(question)).toBeNull();
    expect(gateOf({ ...question, data: { type: 'x-closed' } })).toBeNull();
    expect(gateOf({ ...question, data: ['scope'] })).toBeNull();
  });

  it('reads a task proposal as a gate, never a plain run question', () => {
    const proposal = {
      ...question,
      choices: ['approve', 'decline'],
      data: {
        type: 'task-proposal',
        task: 't-a1b2c3',
        proposedBy: 'agent:wyat/a2a.acme',
        message: 'm-root',
      },
    };
    expect(gateOf(proposal)?.type).toBe('task-proposal');
    expect(toRunQuestion(proposal)).toBeNull();
  });
});

describe('isSystemMarker', () => {
  it('reads x-closed and x-breaker only from agent:dispatch', () => {
    expect(
      isSystemMarker(
        { from: 'agent:dispatch', data: { type: 'x-closed' } },
        'x-closed'
      )
    ).toBe(true);
    expect(
      isSystemMarker(
        { from: 'agent:dispatch', data: { type: 'x-breaker' } },
        'x-breaker'
      )
    ).toBe(true);
    expect(
      isSystemMarker(
        { from: 'agent:dispatch', data: { type: 'x-closed' } },
        'x-breaker'
      )
    ).toBe(false);
    expect(
      isSystemMarker(
        { from: 'agent:wyat/a2a.acme', data: { type: 'x-closed' } },
        'x-closed'
      )
    ).toBe(false);
    expect(
      isSystemMarker(
        { from: 'a2a:acme', data: { type: 'x-breaker' } },
        'x-breaker'
      )
    ).toBe(false);
    expect(
      isSystemMarker({ from: 'agent:dispatch', data: 'x-closed' }, 'x-closed')
    ).toBe(false);
  });
});
