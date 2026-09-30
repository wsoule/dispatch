import type { AgentSummary, MailboxItem, Message } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import type { MessageAccess } from './daemonAuth';
import { taskDoc } from './taskDoc.test-helper';
import {
  addressAction,
  hasAnswerButtons,
  kindLabel,
  knownAddresses,
  lookupsKey,
  mergeThreadSources,
  offersAnswer,
  openRefWith,
  participantLabel,
  refAction,
  replyPlan,
  replyRoute,
  replyTarget,
  rowControl,
  threadLookups,
  threadOpenIds,
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
  [taskDoc({ id: 't-000001', title: 'Checkout' })],
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

  it('gives a decider the approval card, saying when the call preview was cut and which call it is', () => {
    const approval = (
      truncated: boolean,
      parkedOn: { runId: string } | { conversation: string } = {
        runId: 'r-000001',
      }
    ) =>
      msg('m-a', {
        from: 'agent:dispatch',
        kind: 'question',
        blocking: true,
        choices: ['approve', 'approve-session', 'deny'],
        data: {
          type: 'tool-approval',
          requestId: 'req-1',
          ...parkedOn,
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
      call: { runId: 'r-000001', requestId: 'req-1' },
    });
    expect(
      rowControl(approval(false), { me: ME, open: true, access: DECIDER })
    ).toEqual({
      kind: 'tool-approval',
      tool: 'Bash',
      input: { command: 'ls' },
      truncated: false,
      call: { runId: 'r-000001', requestId: 'req-1' },
    });
    // An Assistant call is parked on its conversation instead of a run.
    expect(
      rowControl(approval(true, { conversation: 'o-000001' }), {
        me: ME,
        open: true,
        access: DECIDER,
      })
    ).toEqual({
      kind: 'tool-approval',
      tool: 'Bash',
      input: '{"command":"ls',
      truncated: true,
      call: { conversation: 'o-000001', requestId: 'req-1' },
    });
  });

  it('gives a decider the memory card for a memory gate, and a teammate the reason', () => {
    const memoryGate = msg('m-mem', {
      from: 'agent:dispatch',
      kind: 'question',
      blocking: true,
      choices: ['approve', 'reject'],
      data: {
        type: 'memory',
        proposalId: 'mp-000001',
        action: 'add',
        scope: 'team',
        kind: 'hazard',
      },
    });
    const decider = rowControl(memoryGate, {
      me: ME,
      open: true,
      access: DECIDER,
    });
    expect(decider).toEqual({ kind: 'memory', proposalId: 'mp-000001' });
    expect(offersAnswer(decider)).toBe(true);
    expect(
      rowControl(memoryGate, { me: ME, open: true, access: TEAMMATE })
    ).toEqual({ kind: 'read-only', reason: 'needs decide' });
  });

  it('gives everyone who sees a task proposal its card, with answers only for a decider', () => {
    const proposal = msg('m-p', {
      from: 'agent:dispatch',
      kind: 'question',
      blocking: true,
      choices: ['approve', 'decline'],
      data: {
        type: 'task-proposal',
        task: 't-a1b2c3',
        proposedBy: 'agent:wyat/a2a.acme',
        message: 'm-root',
      },
    });
    const decider = rowControl(proposal, {
      me: ME,
      open: true,
      access: DECIDER,
    });
    expect(decider).toEqual({
      kind: 'task-proposal',
      task: 't-a1b2c3',
      proposedBy: 'agent:wyat/a2a.acme',
      canDecide: true,
    });
    expect(offersAnswer(decider)).toBe(true);
    const teammate = rowControl(proposal, {
      me: ME,
      open: true,
      access: TEAMMATE,
    });
    expect(teammate).toEqual({
      kind: 'task-proposal',
      task: 't-a1b2c3',
      proposedBy: 'agent:wyat/a2a.acme',
      canDecide: false,
    });
    expect(offersAnswer(teammate)).toBe(false);
    expect(
      hasAnswerButtons([proposal], {
        me: ME,
        openIds: new Set(['m-p']),
        access: TEAMMATE,
      })
    ).toBe(false);
    expect(
      rowControl(proposal, { me: ME, open: false, access: DECIDER })
    ).toEqual({ kind: 'none' });
  });

  it('shows a system gate of an unknown type as a decision card to a decider, and read-only to a teammate', () => {
    const unknown = msg('m-u', {
      from: 'agent:dispatch',
      kind: 'question',
      blocking: true,
      choices: ['approve', 'reject'],
      data: { type: 'future-gate', ref: 'x' },
    });
    expect(
      rowControl(unknown, { me: ME, open: true, access: DECIDER })
    ).toEqual({ kind: 'choices', choices: ['approve', 'reject'], gate: true });
    expect(
      rowControl(unknown, { me: ME, open: true, access: TEAMMATE })
    ).toEqual({ kind: 'read-only', reason: 'needs decide' });
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

describe('hasAnswerButtons', () => {
  it('counts a gate card or at least one choice as something to answer with', () => {
    expect(
      offersAnswer({ kind: 'scope', paths: ['a.ts'], reason: 'needed' })
    ).toBe(true);
    expect(
      offersAnswer({
        kind: 'tool-approval',
        tool: 'Bash',
        input: {},
        truncated: false,
        call: null,
      })
    ).toBe(true);
    expect(offersAnswer({ kind: 'choices', choices: ['a'], gate: false })).toBe(
      true
    );
    expect(offersAnswer({ kind: 'choices', choices: [], gate: true })).toBe(
      false
    );
    expect(offersAnswer({ kind: 'read-only', reason: 'why' })).toBe(false);
    expect(offersAnswer({ kind: 'none' })).toBe(false);
  });

  it('is true only when an open row gives this viewer buttons to answer with', () => {
    const open = new Set(['m-s']);
    expect(
      hasAnswerButtons([scopeGate], { me: ME, openIds: open, access: DECIDER })
    ).toBe(true);
    // A gate the viewer cannot decide shows only its read-only reason.
    expect(
      hasAnswerButtons([scopeGate], { me: ME, openIds: open, access: TEAMMATE })
    ).toBe(false);
    expect(
      hasAnswerButtons([scopeGate], {
        me: ME,
        openIds: new Set(),
        access: DECIDER,
      })
    ).toBe(false);
    const bare = msg('m-b', { kind: 'question', blocking: true });
    expect(
      hasAnswerButtons([bare], {
        me: ME,
        openIds: new Set(['m-b']),
        access: TEAMMATE,
      })
    ).toBe(false);
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

  it('writes a plain message, not an answer, once I have written since the question', () => {
    const q = msg('m-01', { kind: 'question', blocking: true });
    const mine = msg('m-02', {
      thread: 'm-01',
      replyTo: 'm-01',
      from: ME,
      to: ['run:r-000001'],
    });
    expect(replyPlan([q, mine], ME, new Set(['m-01']))).toEqual({
      kind: 'send',
      to: ['run:r-000001'],
      replyTo: 'm-01',
    });
    const again = msg('m-03', { thread: 'm-01', kind: 'question' });
    expect(replyPlan([q, mine, again], ME, new Set(['m-01']))).toEqual({
      kind: 'reply',
      target: again,
    });
  });

  it('names where a reply goes: who it answers, or who it is to', () => {
    const q = msg('m-01', { kind: 'question' });
    expect(replyTarget({ kind: 'reply', target: q }, lookups)).toBe(
      'Answering t-000001 · Checkout · r-000001'
    );
    expect(
      replyTarget(
        { kind: 'send', to: ['channel:general', 'human:ada'], replyTo: 'm-01' },
        lookups
      )
    ).toBe('To #general, ada');
  });

  it('answers a blocking question put to me by what the thread holds, even when no open list names it', () => {
    // A teammate's task tab loads no open lists, yet the question waits on them.
    const q = msg('m-01', {
      kind: 'question',
      blocking: true,
      choices: ['old', 'new'],
    });
    expect(replyPlan([q], ME, new Set())).toEqual({ kind: 'reply', target: q });
    expect([...threadOpenIds([q], ME, new Set())]).toEqual(['m-01']);
    const answer = msg('m-02', {
      thread: 'm-01',
      replyTo: 'm-01',
      from: ME,
      to: ['run:r-000001'],
      kind: 'answer',
      choice: 'new',
    });
    expect(replyPlan([q, answer], ME, new Set())).toMatchObject({
      kind: 'send',
    });
    expect([...threadOpenIds([q, answer], ME, new Set())]).toEqual([]);
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

  it("writes back to the sender of someone else's plain message as a send, which a retry can key", () => {
    const theirs = msg('m-01');
    expect(replyPlan([theirs], ME, new Set())).toEqual({
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
    // The daemon reroutes an ended run that wrote or received the replied-to message.
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

  it("anchors a teammate's reply on a message they took part in, which is all the daemon lets them reply to", () => {
    const question = msg('m-01', { kind: 'question' });
    const answer = msg('m-02', {
      thread: 'm-01',
      replyTo: 'm-01',
      from: ME,
      to: ['run:r-000001'],
      kind: 'answer',
    });
    const note = msg('m-03', {
      thread: 'm-01',
      replyTo: 'm-02',
      to: ['human:owner'],
    });
    const thread = [question, answer, note];
    const teammate = { canDecide: false, deliveries: [] };
    expect(replyPlan(thread, ME, new Set(), teammate)).toEqual({
      kind: 'send',
      to: ['run:r-000001'],
      replyTo: 'm-01',
    });
    // A decider may reply to anything, so they write beside the newest.
    expect(replyPlan(thread, ME, new Set())).toEqual({
      kind: 'send',
      to: ['run:r-000001'],
      replyTo: 'm-03',
    });
  });

  it('counts a channel message delivered to a teammate as one they took part in', () => {
    const root = msg('m-01', { to: ['channel:general'] });
    const aside = msg('m-02', {
      thread: 'm-01',
      replyTo: 'm-01',
      to: ['human:owner'],
    });
    const delivered = {
      id: 'd-01',
      messageId: 'm-01',
      recipient: ME,
      runId: null,
      via: 'channel' as const,
      state: 'read' as const,
      updatedAt: root.createdAt,
    };
    expect(
      replyPlan([root, aside], ME, new Set(), {
        canDecide: false,
        deliveries: [delivered],
      })
    ).toEqual({ kind: 'send', to: ['channel:general'], replyTo: 'm-01' });
    expect(
      replyPlan([root, aside], ME, new Set(), {
        canDecide: false,
        deliveries: [],
      })
    ).toBeNull();
  });
});

describe('threadOpenIds', () => {
  it('adds an unanswered non-blocking question put to me, so its choices answer it', () => {
    const q = msg('m-01', { kind: 'question', choices: ['yes', 'no'] });
    const gate = msg('m-g', {
      from: 'agent:dispatch',
      kind: 'question',
      blocking: true,
      data: { type: 'wake', target: 'task:t-000002', message: 'm-x' },
    });
    const open = new Set(['m-g']);
    expect([...threadOpenIds([gate, q], ME, open)].sort()).toEqual([
      'm-01',
      'm-g',
    ]);
    const answer = msg('m-02', {
      thread: 'm-01',
      replyTo: 'm-01',
      from: ME,
      to: ['run:r-000001'],
      kind: 'answer',
      choice: 'yes',
    });
    expect(threadOpenIds([gate, q, answer], ME, open)).toBe(open);
    const theirs = msg('m-03', { kind: 'question', to: ['human:ada'] });
    expect(threadOpenIds([theirs], ME, open)).toBe(open);
  });

  it('drops a listed gate the thread already answers, as a restart closes it before the list refetches', () => {
    const gate = msg('m-g', {
      from: 'agent:dispatch',
      kind: 'question',
      blocking: true,
      choices: ['approve', 'deny'],
      data: { type: 'wake', target: 'task:t-000002', message: 'm-x' },
    });
    const closed = msg('m-c', {
      thread: 'm-g',
      replyTo: 'm-g',
      from: 'agent:dispatch',
      to: [ME],
      kind: 'answer',
      data: { type: 'x-closed' },
    });
    const stale = new Set(['m-g', 'm-other']);
    expect([...threadOpenIds([gate, closed], ME, stale)]).toEqual(['m-other']);
    expect(
      hasAnswerButtons([gate, closed], {
        me: ME,
        openIds: threadOpenIds([gate, closed], ME, stale),
        access: DECIDER,
      })
    ).toBe(false);
  });
});

describe('replyRoute', () => {
  const line = msg('m-01', { from: ME, to: ['agent:wyat/overseer'] });
  // The roster holds the daemon's own overseer, approved by the daemon, and
  // a teammate's external agent that registered under the same name.
  const withRoster = threadLookups(
    [],
    [],
    [
      agent('agent:wyat/overseer', {
        client: 'dispatch',
        approvedBy: 'agent:dispatch',
      }),
      agent('agent:pmirand/overseer', { approvedBy: ME }),
    ]
  );

  it('keeps ordinary threads on the bus', () => {
    expect(replyRoute([msg('m-02')], 'm-02', 'm-01', withRoster)).toBe('bus');
  });

  it('routes the live overseer conversation through the overseer and leaves an older one read-only', () => {
    expect(replyRoute([line], 'm-01', 'm-01', withRoster)).toBe('overseer');
    expect(replyRoute([line], 'm-01', 'm-77', withRoster)).toBe(
      'overseer-elsewhere'
    );
    expect(replyRoute([line], 'm-01', null, withRoster)).toBe(
      'overseer-elsewhere'
    );
  });

  it("keeps a teammate's agent named overseer on the bus: only the daemon's own overseer is the Assistant", () => {
    const external = msg('m-05', { from: ME, to: ['agent:pmirand/overseer'] });
    expect(replyRoute([external], 'm-05', null, withRoster)).toBe('bus');
    expect(withRoster.isOverseer('agent:wyat/overseer')).toBe(true);
    expect(withRoster.isOverseer('agent:pmirand/overseer')).toBe(false);
  });

  it('treats any overseer-named agent as the Assistant only until the roster loads', () => {
    const unloaded = threadLookups([], [], []);
    expect(replyRoute([line], 'm-01', 'm-01', unloaded)).toBe('overseer');
    expect(unloaded.isOverseer('agent:pmirand/overseer')).toBe(true);
    expect(unloaded.isOverseer('agent:wyat/claude')).toBe(false);
  });
});

describe('refs and labels', () => {
  it('gives a ref of a type this build does not register no link', () => {
    // A peer's newer version may send one; it stays a plain chip.
    expect(refAction({ type: 'wiki', id: 'handbook' }, lookups)).toBeNull();
  });

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

  it('routes a doc ref to the doc and its section', () => {
    const none = { taskIdOfRun: () => null };
    expect(refAction({ type: 'doc', id: 'doc-01K', at: 'api' }, none)).toEqual({
      kind: 'doc',
      docId: 'doc-01K',
      anchor: 'api',
    });
    expect(refAction({ type: 'doc', id: 'doc-01K' }, none)).toEqual({
      kind: 'doc',
      docId: 'doc-01K',
      anchor: null,
    });
  });

  it('turns each action into the matching navigation', () => {
    const calls: unknown[][] = [];
    const open = openRefWith({
      openTask: (...args) => calls.push(['task', ...args]),
      openThread: (id) => calls.push(['thread', id]),
      openImpact: (subject) => calls.push(['impact', subject]),
      openDoc: (docId, anchor) => calls.push(['doc', docId, anchor]),
    });
    open({ kind: 'task', taskId: 't-000001' });
    open({ kind: 'run', taskId: 't-000001', runId: 'r-000001' });
    open({ kind: 'file', path: 'src/a.ts' });
    open({ kind: 'message', messageId: 'm-01' });
    open({ kind: 'doc', docId: 'doc-01K', anchor: 'api' });
    expect(calls).toEqual([
      ['task', 't-000001', 'details'],
      ['task', 't-000001', 'chat', 'r-000001'],
      ['impact', { kind: 'file', id: 'src/a.ts' }],
      ['thread', 'm-01'],
      ['doc', 'doc-01K', 'api'],
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
    expect(lookups.taskDoc('t-000001')?.meta.title).toBe('Checkout');
    expect(lookups.taskDoc('t-000404')).toBeNull();
    expect(
      threadTitle(msg('m-01', { body: `${'x'.repeat(90)}\nsecond line` }))
    ).toBe(`${'x'.repeat(79)}…`);
  });

  it('badges every kind but a plain message, a custom kind by its own name', () => {
    expect(kindLabel('question')).toBe('Question');
    expect(kindLabel('handoff')).toBe('Handoff');
    expect(kindLabel('notice')).toBe('Notice');
    expect(kindLabel('answer')).toBe('Answer');
    expect(kindLabel('x-review')).toBe('x-review');
    expect(kindLabel('message')).toBeUndefined();
  });

  it('keys the lookups by what they read, so an event that changes no label keeps them', () => {
    const task = (status: string, updated = '2026-09-25T10:00:00.000Z') =>
      taskDoc({ id: 't-000001', title: 'Checkout', status, updated });
    const run = (state: string) => ({
      id: 'r-000001',
      taskId: 't-000001',
      state,
    });
    const tasks = [task('working')];
    const runs = [run('running')];
    const agents = [agent('agent:wyat/quiet', { muted: true })];
    const key = lookupsKey(tasks, runs, agents);
    // A run moving on, or a task changing status, touches no label.
    expect(lookupsKey([task('review')], [run('finished')], [...agents])).toBe(
      key
    );
    expect(
      lookupsKey(
        [taskDoc({ id: 't-000001', title: 'Cart', status: 'working' })],
        runs,
        agents
      )
    ).not.toBe(key);
    // A proposal card shows its draft, so a draft's edit counts; another task's does not.
    expect(
      lookupsKey([task('working', '2026-09-25T11:00:00.000Z')], runs, agents)
    ).toBe(key);
    const draftKey = lookupsKey([task('draft')], runs, agents);
    expect(
      lookupsKey([task('draft', '2026-09-25T11:00:00.000Z')], runs, agents)
    ).not.toBe(draftKey);
    expect(
      lookupsKey(
        tasks,
        [...runs, { id: 'r-000002', taskId: 't-000001' }],
        agents
      )
    ).not.toBe(key);
    expect(
      lookupsKey(tasks, runs, [agent('agent:wyat/quiet', { muted: false })])
    ).not.toBe(key);
    // Who approved an agent decides which overseer is the daemon's own.
    expect(
      lookupsKey(tasks, runs, [
        agent('agent:wyat/quiet', {
          muted: true,
          approvedBy: 'agent:dispatch',
        }),
      ])
    ).not.toBe(key);
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
