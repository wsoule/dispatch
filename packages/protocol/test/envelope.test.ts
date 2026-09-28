import { describe, expect, it } from 'bun:test';

import { REF_TYPES } from '../src/constants.js';
import { gateOf } from '../src/envelope.js';
import type { Message, Ref, RefType } from '../src/envelope.js';

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

  it('names the registered types, so code that branches on a ref type keeps a default', () => {
    const registered: readonly RefType[] = REF_TYPES;
    const label = (ref: Ref): string => {
      switch (ref.type) {
        case 'task':
          return 'a task';
        default:
          return `a ${ref.type} ref`;
      }
    };
    expect(registered).toContain('file');
    expect(label({ type: 'wiki', id: 'handbook' })).toBe('a wiki ref');
  });
});
