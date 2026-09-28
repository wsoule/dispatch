import { describe, expect, it } from 'bun:test';

import type { Message } from '../src/envelope.js';
import { firstLine, renderForAgent } from '../src/render.js';

// Pushes and digests are tested by the kit's render vectors (vectors.test.ts).
describe('firstLine', () => {
  it('cuts on code points, never inside a surrogate pair', () => {
    expect(firstLine(`${'a'.repeat(78)}😀😀😀`)).toBe(`${'a'.repeat(78)}😀…`);
  });
});

describe('renderForAgent', () => {
  it('renders a doc ref with its anchor', () => {
    const m: Message = {
      id: 'm-01abc',
      thread: 'm-01abc',
      replyTo: null,
      from: 'run:r-000001',
      to: ['channel:epic/e-000001'],
      kind: 'message',
      body: 'see the spec',
      refs: [{ type: 'doc', id: 'doc-01K', at: 'api' }],
      urgent: false,
      blocking: false,
      wake: 'none',
      createdAt: '2026-09-23T10:00:00.000Z',
    };
    expect(renderForAgent(m)).toContain('refs: doc:doc-01K@api');
  });
});
