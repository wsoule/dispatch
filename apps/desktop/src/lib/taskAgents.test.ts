import type { Message } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { agentLabel, partySummary, taskAgentParties } from './taskAgents';

let seq = 0;
function msg(over: Partial<Message>): Message {
  seq += 1;
  return {
    id: `m-${seq}`,
    thread: 'th-1',
    replyTo: null,
    from: 'run:r-1',
    to: ['task:t-1'],
    kind: 'message',
    body: 'hi',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: `2026-10-29T10:${String(seq).padStart(2, '0')}:00.000Z`,
    ...over,
  };
}

describe('agentLabel', () => {
  test('names a peer by its alias and a client by its name', () => {
    expect(agentLabel('a2a:acme-billing')).toBe('acme-billing');
    expect(agentLabel('agent:wyat/a2a.ci-bot')).toBe('ci-bot');
  });
});

describe('taskAgentParties', () => {
  test('a task with no outside agents has no parties', () => {
    expect(
      taskAgentParties([msg({ from: 'human:wyat', to: ['run:r-1'] })])
    ).toEqual([]);
  });

  test('an unanswered question to a peer is waiting on them, an answered one is not', () => {
    const asked = msg({ kind: 'question', to: ['a2a:acme'] });
    const answered = msg({ kind: 'question', to: ['a2a:acme'] });
    const reply = msg({
      kind: 'answer',
      from: 'a2a:acme',
      to: ['run:r-1'],
      replyTo: answered.id,
    });
    const [acme] = taskAgentParties([asked, answered, reply]);
    expect(acme?.waitingOnThem).toBe(1);
    expect(acme?.waitingOnYou).toBe(0);
    expect(acme?.messages).toBe(3);
    expect(partySummary(acme)).toBe('Waiting on them · 1 question');
  });

  test('a question from a client is waiting on you and sorts first', () => {
    const parties = taskAgentParties([
      msg({ kind: 'question', to: ['a2a:docs'] }),
      msg({
        kind: 'question',
        from: 'agent:wyat/a2a.ci-bot',
        to: ['task:t-1'],
      }),
    ]);
    expect(parties.map((p) => p.label)).toEqual(['ci-bot', 'docs']);
    expect(partySummary(parties[0])).toBe('Waiting on you · 1 question');
  });

  test('handoffs both ways are counted once each', () => {
    const [acme] = taskAgentParties([
      msg({ kind: 'handoff', to: ['a2a:acme', 'a2a:acme'] }),
      msg({ kind: 'handoff', from: 'a2a:acme', to: ['task:t-1'] }),
    ]);
    expect(acme?.handoffsOut).toBe(1);
    expect(acme?.handoffsIn).toBe(1);
    expect(partySummary(acme)).toBe('1 handoff in · 1 handoff out');
  });
});
