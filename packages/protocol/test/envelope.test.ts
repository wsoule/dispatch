import { describe, expect, it } from 'bun:test';

import { gateOf } from '../src/envelope.js';
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
