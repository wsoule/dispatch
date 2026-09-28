import { describe, expect, it } from 'bun:test';

import { gateOf, isSystemMarker, validateSendInput } from '../src/envelope.js';
import type { Message, Ref } from '../src/envelope.js';

const gate: Message = {
  id: 'm-g',
  thread: 'm-g',
  replyTo: null,
  from: 'agent:dispatch',
  to: ['human:wyat'],
  kind: 'question',
  body: 'ok?',
  refs: [],
  urgent: false,
  blocking: true,
  choices: ['approve', 'deny'],
  data: {
    type: 'tool-approval',
    requestId: 'req-1',
    runId: 'r-000001',
    tool: 'Bash',
    input: { command: 'ls' },
  },
  wake: 'none',
  createdAt: '2026-09-23T00:00:00.000Z',
};

// Send-input validation is tested by the kit's envelope vectors
// (vectors.test.ts); this file keeps the TypeScript helpers.
describe('gateOf', () => {
  it('recognizes gate payloads and ignores other data', () => {
    expect(gateOf(gate)?.type).toBe('tool-approval');
    expect(gateOf({ data: { type: 'other' } })).toBeNull();
    expect(gateOf({ data: [1] })).toBeNull();
    expect(gateOf({})).toBeNull();
  });
});

describe('Ref', () => {
  it('types a received ref of a type this package does not know', () => {
    // A message received through a binding keeps such a ref (§4.4).
    const kept: Ref = { type: 'wiki', id: 'handbook', at: 's2' };
    const known: Ref = { type: 'file', id: 'src/a.ts', at: 'abc123' };
    expect([kept.type, known.type]).toEqual(['wiki', 'file']);
  });
});

describe('validateSendInput with parentOptional', () => {
  const answer = {
    to: ['human:bob'],
    kind: 'answer' as const,
    body: 'yes',
    replyTo: 'm-root',
  };

  it('refuses a reply to an unknown message unless its parent may be missing', () => {
    expect(() =>
      validateSendInput(answer, 'human:bob', false, null, {
        origin: 'received',
      })
    ).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(() =>
      validateSendInput(answer, 'human:bob', false, null, {
        origin: 'received',
        parentOptional: true,
      })
    ).not.toThrow();
  });

  it('still judges a reply against a parent that is stored', () => {
    expect(() =>
      validateSendInput(
        answer,
        'human:bob',
        false,
        { ...gate, choices: undefined, data: undefined, kind: 'message' },
        {
          parentOptional: true,
        }
      )
    ).toThrow(expect.objectContaining({ code: 'invalid', field: 'replyTo' }));
  });
});

describe('isSystemMarker', () => {
  it("never reads another replica's system as this one's", () => {
    const close = { from: 'agent:dispatch', data: { type: 'x-closed' } };
    expect(isSystemMarker(close, 'x-closed')).toBe(true);
    expect(
      isSystemMarker({ ...close, origin: 'bob-0000000b' }, 'x-closed')
    ).toBe(false);
  });
});
