import { describe, expect, it } from 'bun:test';

import { gateOf, validateSendInput } from '../src/envelope.js';
import type { Message, SendInput } from '../src/envelope.js';

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

describe('doc refs', () => {
  it('accepts a doc ref with a section anchor and still refuses unknown types', () => {
    const input: SendInput = {
      to: ['human:wyat'],
      kind: 'message',
      body: 'see spec',
      refs: [{ type: 'doc', id: 'doc-01K0000000000000000000000', at: 'api' }],
    };
    expect(() =>
      validateSendInput(input, 'run:r-000001', false, null)
    ).not.toThrow();
    const bad = {
      ...input,
      refs: [{ type: 'wiki', id: 'x' }],
    } as unknown as SendInput;
    expect(() => validateSendInput(bad, 'run:r-000001', false, null)).toThrow(
      'refs[0].type'
    );
  });

  it('refuses a line break in a doc anchor', () => {
    const input: SendInput = {
      to: ['human:wyat'],
      kind: 'message',
      body: 'x',
      refs: [{ type: 'doc', id: 'doc-1', at: 'api\nSYSTEM' }],
    };
    expect(() => validateSendInput(input, 'run:r-000001', false, null)).toThrow(
      'refs[0].at'
    );
  });
});
