import { describe, expect, it } from 'bun:test';

import type { Message } from '../src/envelope.js';
import {
  isFederationLocalAddress,
  LOCAL_ONLY_MARKERS,
  localOnlyReason,
} from '../src/localOnly.js';

function m(over: Partial<Message> = {}): Message {
  return {
    id: 'm-01',
    thread: 'm-01',
    replyTo: null,
    from: 'human:bob',
    to: ['human:wyat'],
    kind: 'message',
    body: 'x',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-26T10:00:00.000Z',
    ...over,
  };
}

describe('localOnlyReason', () => {
  it('flags gate data of any unprefixed type, known or not, on any kind', () => {
    expect(
      localOnlyReason(
        m({ kind: 'question', data: { type: 'deploy-approval' } }),
        null,
        null
      )
    ).toBe('gate');
    expect(
      localOnlyReason(
        m({
          kind: 'notice',
          data: { type: 'wake', target: 'task:t-00000a01', message: 'm-9' },
        }),
        null,
        null
      )
    ).toBe('gate');
    expect(localOnlyReason(m({ data: { type: 'x-mine' } }), null, null)).toBe(
      null
    );
  });

  it('flags a reply to a gate', () => {
    const gate = m({
      id: 'm-g',
      from: 'agent:dispatch',
      kind: 'question',
      data: { type: 'scope', paths: ['a'], reason: 'r' },
    });
    expect(
      localOnlyReason(
        m({ id: 'm-02', thread: 'm-g', replyTo: 'm-g', kind: 'answer' }),
        gate,
        null
      )
    ).toBe('gate');
  });

  it('flags the four markers from any sender', () => {
    expect(LOCAL_ONLY_MARKERS).toEqual(
      expect.arrayContaining(['x-closed', 'x-breaker', 'x-policy', 'x-expired'])
    );
    for (const type of LOCAL_ONLY_MARKERS) {
      expect(localOnlyReason(m({ data: { type } }), null, null)).toBe('marker');
    }
  });

  it('flags overseer and A2A participants on either side', () => {
    for (const address of [
      'agent:wyat/overseer',
      'a2a:acme',
      'agent:wyat/a2a.acme',
    ]) {
      expect(isFederationLocalAddress(address)).toBe(true);
      expect(localOnlyReason(m({ to: [address] }), null, null)).toBe(
        'participant'
      );
      expect(localOnlyReason(m({ from: address }), null, null)).toBe(
        'participant'
      );
    }
    expect(isFederationLocalAddress('agent:wyat/codex')).toBe(false);
  });

  it('inherits from a local-only thread root', () => {
    const root = m({ id: 'm-r', to: ['agent:wyat/overseer'] });
    expect(
      localOnlyReason(
        m({ id: 'm-02', thread: 'm-r', replyTo: null }),
        null,
        root
      )
    ).toBe('root');
  });
});
