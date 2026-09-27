import type { AgentSummary, MailboxItem, Message } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import type { MessageAccess } from './daemonAuth';
import {
  addressAction,
  knownAddresses,
  mergeThreadSources,
  openRefWith,
  participantLabel,
  refAction,
  replyPlan,
  replyRoute,
  rowControl,
  threadLookups,
  threadTitle,
} from './threadSources';

const ME = 'human:wyat';
function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'run:r-000001',
    to: [ME],
    kind: 'message',
    body: id,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}
function item(
  message: Message,
  state: MailboxItem['delivery']['state'],
  recipient = ME
): MailboxItem {
  return {
    message,
    delivery: {
      id: `d-${message.id}`,
      messageId: message.id,
      recipient,
      runId: null,
      via: 'direct',
      state,
      updatedAt: message.createdAt,
    },
  };
}
function agent(
  address: string,
  over: Partial<AgentSummary> = {}
): AgentSummary {
  return {
    address,
    displayName: address,
    client: 'codex',
    status: 'approved',
    muted: false,
    approvedBy: ME,
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}
const DECIDER: MessageAccess = {
  canDecide: true,
  canMessage: true,
  explanation: null,
};
const TEAMMATE: MessageAccess = {
  canDecide: false,
  canMessage: true,
  explanation: 'needs decide',
};
const AGENT_WINDOW: MessageAccess = {
  canDecide: false,
  canMessage: false,
  explanation: 'cannot message',
};
const scopeGate = msg('m-s', {
  kind: 'question',
  blocking: true,
  choices: ['grant', 'deny'],
  data: { type: 'scope', paths: ['a.ts'], reason: 'needed' },
});
const lookups = threadLookups(
  [{ meta: { id: 't-000001', title: 'Checkout' } }],
  [{ id: 'r-000001', taskId: 't-000001' }],
  [
    agent('agent:wyat/old', { status: 'revoked' }),
    agent('agent:wyat/quiet', { muted: true }),
  ]
);

describe('mergeThreadSources', () => {
  it('dedupes across the mailbox and open gates and keeps only my deliveries', () => {
    const q = msg('m-02', {
      kind: 'question',
      blocking: true,
      choices: ['a', 'b'],
    });
    const out = mergeThreadSources(
      {
        mailbox: [
          item(q, 'notified'),
          item(msg('m-09'), 'notified', 'task:t-000001'),
        ],
        openGates: [q],
      },
      ME
    );
    expect(out.messages.map((m) => m.id).sort()).toEqual(['m-02', 'm-09']);
    expect(out.deliveries.map((d) => d.id)).toEqual(['d-m-02']);
    expect([...out.openIds]).toEqual(['m-02']);
  });

  it('finds what waits on a teammate from their mailbox, since open decisions are refused to them', () => {
    const question = msg('m-01', { kind: 'question', blocking: true });
    const handoff = msg('m-02', {
      kind: 'handoff',
      choices: ['accept', 'decline'],
    });
    const answered = msg('m-03', { kind: 'question', blocking: true });
    const chat = msg('m-04');
    const out = mergeThreadSources(
      {
        mailbox: [
          item(question, 'read'),
          item(handoff, 'notified'),
          item(answered, 'answered'),
          item(chat, 'notified'),
        ],
        openGates: [],
      },
      ME
    );
    expect([...out.openIds].sort()).toEqual(['m-01', 'm-02']);
  });
});

describe('rowControl', () => {
  it('shows a gate read-only, with the reason, to a viewer who cannot decide', () => {
    expect(
      rowControl(scopeGate, { me: ME, open: true, access: TEAMMATE })
    ).toEqual({ kind: 'read-only', reason: 'needs decide' });
  });

  it('gives a decider the gate card, and a teammate the buttons of a question or handoff put to them', () => {
    expect(
      rowControl(scopeGate, { me: ME, open: true, access: DECIDER })
    ).toEqual({ kind: 'scope', paths: ['a.ts'], reason: 'needed' });
    const q = msg('m-q', {
      kind: 'question',
      blocking: true,
      choices: ['old', 'new'],
    });
    expect(rowControl(q, { me: ME, open: true, access: TEAMMATE })).toEqual({
      kind: 'choices',
      choices: ['old', 'new'],
      gate: false,
    });
    expect(
      rowControl(msg('m-h', { kind: 'handoff' }), {
        me: ME,
        open: true,
        access: TEAMMATE,
      })
    ).toEqual({ kind: 'choices', choices: ['accept', 'decline'], gate: false });
  });

  it('gives a decider the approval card, saying when the call preview was cut', () => {
    const approval = (truncated: boolean) =>
      msg('m-a', {
        from: 'agent:dispatch',
        kind: 'question',
        blocking: true,
        choices: ['approve', 'approve-session', 'deny'],
        data: {
          type: 'tool-approval',
          requestId: 'req-1',
          runId: 'r-000001',
          tool: 'Bash',
          input: truncated ? '{"command":"ls' : { command: 'ls' },
          ...(truncated ? { truncated: true as const } : {}),
          floor: false,
        },
      });
    expect(
      rowControl(approval(true), { me: ME, open: true, access: DECIDER })
    ).toEqual({
      kind: 'tool-approval',
      tool: 'Bash',
      input: '{"command":"ls',
      truncated: true,
    });
    expect(
      rowControl(approval(false), { me: ME, open: true, access: DECIDER })
    ).toEqual({
      kind: 'tool-approval',
      tool: 'Bash',
      input: { command: 'ls' },
      truncated: false,
    });
  });

  it('offers nothing once answered or to someone else, and says why an agent window cannot answer', () => {
    const q = msg('m-q', {
      kind: 'question',
      blocking: true,
      choices: ['old', 'new'],
    });
    expect(rowControl(q, { me: ME, open: false, access: DECIDER })).toEqual({
      kind: 'none',
    });
    expect(
      rowControl(q, { me: 'human:ada', open: true, access: DECIDER })
    ).toEqual({ kind: 'none' });
    expect(rowControl(q, { me: ME, open: true, access: AGENT_WINDOW })).toEqual(
      { kind: 'read-only', reason: 'cannot message' }
    );
  });
});

describe('replyPlan', () => {
  it('answers an open question put to me', () => {
    const q = msg('m-01', { kind: 'question', blocking: true });
    expect(replyPlan([q], ME, new Set(['m-01']))).toEqual({
      kind: 'reply',
      target: q,
    });
  });

  it('answers an open question put to me even after later messages in its thread', () => {
    const q = msg('m-01', { kind: 'question', blocking: true });
    const followUp = msg('m-02', { thread: 'm-01', replyTo: 'm-01' });
    const aside = msg('m-03', {
      thread: 'm-01',
      replyTo: 'm-02',
      from: 'human:ada',
      to: [ME, 'run:r-000001'],
    });
    expect(replyPlan([q, followUp, aside], ME, new Set(['m-01']))).toEqual({
      kind: 'reply',
      target: q,
    });
  });

  it('answers a non-blocking question put to me until its thread holds an answer', () => {
    const q = msg('m-01', { kind: 'question' });
    expect(replyPlan([q], ME, new Set())).toEqual({ kind: 'reply', target: q });
    const answer = msg('m-02', {
      thread: 'm-01',
      replyTo: 'm-01',
      from: ME,
      to: ['run:r-000001'],
      kind: 'answer',
    });
    expect(replyPlan([q, answer], ME, new Set())).toEqual({
      kind: 'send',
      to: ['run:r-000001'],
      replyTo: 'm-01',
    });
  });

  it('writes beside an open question put to someone else, never answering it for them', () => {
    const q = msg('m-01', {
      kind: 'question',
      blocking: true,
      to: ['human:ada'],
    });
    // A decider's open gates list every open blocking question put to any human.
    const { openIds } = mergeThreadSources({ mailbox: [], openGates: [q] }, ME);
    expect(replyPlan([q], ME, openIds)).toEqual({
      kind: 'send',
      to: ['run:r-000001'],
      replyTo: 'm-01',
    });
  });

  it('writes beside an open handoff to its sender, since answering one needs accept or decline', () => {
    const handoff = msg('m-01', {
      kind: 'handoff',
      choices: ['accept', 'decline'],
    });
    expect(replyPlan([handoff], ME, new Set(['m-01']))).toEqual({
      kind: 'send',
      to: ['run:r-000001'],
      replyTo: 'm-01',
    });
  });

  it('after my own last message, writes to whoever I wrote to, never to myself, replying to their message', () => {
    const theirs = msg('m-01');
    const mine = msg('m-02', {
      thread: 'm-01',
      replyTo: 'm-01',
      from: ME,
      to: ['run:r-000001'],
    });
    expect(replyPlan([theirs, mine], ME, new Set())).toEqual({
      kind: 'send',
      to: ['run:r-000001'],
      replyTo: 'm-01',
    });
  });

  it("after my own last message, replies to the other party's newest message to me, so a run that ended since reaches its task", () => {
    // The daemon reroutes an ended run to its task only when that run wrote the replied-to message.
    const first = msg('m-01');
    const theirs = msg('m-02', { thread: 'm-01', replyTo: 'm-01' });
    const aside = msg('m-03', { thread: 'm-01', to: ['human:ada'] });
    const mine = msg('m-04', {
      thread: 'm-01',
      replyTo: 'm-02',
      from: ME,
      to: ['run:r-000001'],
    });
    expect(replyPlan([first, theirs, aside, mine], ME, new Set())).toEqual({
      kind: 'send',
      to: ['run:r-000001'],
      replyTo: 'm-02',
    });
    const started = msg('m-05', { from: ME, to: ['task:t-000001'] });
    expect(replyPlan([started], ME, new Set())).toEqual({
      kind: 'send',
      to: ['task:t-000001'],
      replyTo: 'm-05',
    });
  });

  it('in a channel thread, writes to the channel', () => {
    const root = msg('m-01', { to: ['channel:epic/e-4a19c2'] });
    expect(replyPlan([root], ME, new Set())).toEqual({
      kind: 'send',
      to: ['channel:epic/e-4a19c2'],
      replyTo: 'm-01',
    });
  });

  it('never answers a question the daemon already closed: it sends a plain message to the asker', () => {
    const q = msg('m-01', { kind: 'question', blocking: true });
    const closed = msg('m-02', {
      thread: 'm-01',
      replyTo: 'm-01',
      from: 'agent:dispatch',
      kind: 'answer',
      data: { type: 'x-closed' },
    });
    expect(replyPlan([q, closed], ME, new Set())).toEqual({
      kind: 'send',
      to: ['run:r-000001'],
      replyTo: 'm-01',
    });
  });

  it('has nothing to reply to in a thread that is only an open gate', () => {
    expect(replyPlan([scopeGate], ME, new Set(['m-s']))).toBeNull();
  });

  it('never writes to the daemon itself after I answered one of its gates', () => {
    const wake = msg('m-w', {
      from: 'agent:dispatch',
      kind: 'question',
      blocking: true,
      choices: ['approve', 'deny'],
      data: { type: 'wake', target: 'task:t-000001', message: 'm-x' },
    });
    const answer = msg('m-a', {
      thread: 'm-w',
      replyTo: 'm-w',
      from: ME,
      to: ['agent:dispatch'],
      kind: 'answer',
      choice: 'approve',
    });
    expect(replyPlan([wake, answer], ME, new Set())).toBeNull();
  });
});

describe('replyRoute', () => {
  const line = msg('m-01', { from: ME, to: ['agent:wyat/overseer'] });

  it('keeps ordinary threads on the bus', () => {
    expect(replyRoute([msg('m-02')], 'm-02', 'm-01')).toBe('bus');
  });

  it('routes the live overseer conversation through the overseer and leaves an older one read-only', () => {
    expect(replyRoute([line], 'm-01', 'm-01')).toBe('overseer');
    expect(replyRoute([line], 'm-01', 'm-77')).toBe('overseer-elsewhere');
    expect(replyRoute([line], 'm-01', null)).toBe('overseer-elsewhere');
  });
});

describe('refs and labels', () => {
  it('routes each ref kind, and gives a commit or an unknown run no link', () => {
    expect(refAction({ type: 'task', id: 't-000001' }, lookups)).toEqual({
      kind: 'task',
      taskId: 't-000001',
    });
    expect(refAction({ type: 'run', id: 'r-000001' }, lookups)).toEqual({
      kind: 'run',
      taskId: 't-000001',
      runId: 'r-000001',
    });
    expect(refAction({ type: 'run', id: 'r-999999' }, lookups)).toBeNull();
    expect(
      refAction({ type: 'file', id: 'src/a.ts', at: 'abc' }, lookups)
    ).toEqual({ kind: 'file', path: 'src/a.ts' });
    expect(refAction({ type: 'message', id: 'm-01' }, lookups)).toEqual({
      kind: 'message',
      messageId: 'm-01',
    });
    expect(refAction({ type: 'commit', id: 'abc' }, lookups)).toBeNull();
    expect(addressAction('run:r-000001', lookups)).toEqual({
      kind: 'run',
      taskId: 't-000001',
      runId: 'r-000001',
    });
    expect(addressAction('task:t-000001', lookups)).toEqual({
      kind: 'task',
      taskId: 't-000001',
    });
    expect(addressAction(ME, lookups)).toBeNull();
  });

  it('turns each action into the matching navigation', () => {
    const calls: unknown[][] = [];
    const open = openRefWith({
      openTask: (...args) => calls.push(['task', ...args]),
      openThread: (id) => calls.push(['thread', id]),
      openImpact: (subject) => calls.push(['impact', subject]),
    });
    open({ kind: 'task', taskId: 't-000001' });
    open({ kind: 'run', taskId: 't-000001', runId: 'r-000001' });
    open({ kind: 'file', path: 'src/a.ts' });
    open({ kind: 'message', messageId: 'm-01' });
    expect(calls).toEqual([
      ['task', 't-000001', 'details'],
      ['task', 't-000001', 'chat', 'r-000001'],
      ['impact', { kind: 'file', id: 'src/a.ts' }],
      ['thread', 'm-01'],
    ]);
  });

  it('labels a run by its task, the daemon as Dispatch, and flags revoked or muted agents', () => {
    expect(participantLabel('run:r-000001', lookups)).toBe(
      't-000001 · Checkout · r-000001'
    );
    expect(participantLabel('agent:dispatch', lookups)).toBe('Dispatch');
    expect(lookups.agentStatus('agent:wyat/old')).toBe('revoked');
    expect(lookups.agentStatus('agent:wyat/quiet')).toBe('muted');
    expect(lookups.agentStatus('agent:wyat/other')).toBeNull();
    expect(
      threadTitle(msg('m-01', { body: `${'x'.repeat(90)}\nsecond line` }))
    ).toBe(`${'x'.repeat(79)}…`);
  });

  it('completes from the board, the channels, approved agents and who is connected', () => {
    expect(
      knownAddresses({
        tasks: [{ meta: { id: 't-000001', title: 'Checkout' } }],
        channels: [{ name: 'general', auto: false, members: [] }],
        agents: [
          agent('agent:wyat/quiet', { muted: true }),
          agent('agent:wyat/old', { status: 'revoked' }),
          agent('agent:wyat/new', { status: 'pending' }),
        ],
        presence: [{ ref: 'human:ada' }, { ref: ME }],
        me: ME,
      })
    ).toEqual({
      tasks: [{ id: 't-000001', title: 'Checkout' }],
      channels: ['general'],
      agents: ['agent:wyat/quiet'],
      humans: [ME, 'human:ada'],
    });
  });
});
