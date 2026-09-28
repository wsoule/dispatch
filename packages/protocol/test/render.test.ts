import { describe, expect, it } from 'bun:test';

import type { Message } from '../src/envelope.js';
import { firstLine, renderDigestLine, renderForAgent } from '../src/render.js';

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

// The vectors do not cover federation, so a remote sender's forms are pinned here.
describe('a sender on another replica', () => {
  const m: Message = {
    id: 'm-01',
    thread: 'm-01',
    replyTo: null,
    from: 'human:bob',
    to: ['channel:ops'],
    kind: 'message',
    body: 'hello\nthere',
    refs: [{ type: 'task', id: 't-00000a01' }],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-26T10:00:00.000Z',
    origin: 'bob-0000000b',
  };

  it('names the replica in a digest line', () => {
    expect(renderDigestLine(m, false, 'bob')).toBe(
      '📬 #ops · message from human:bob (remote: bob): hello (m-01)'
    );
  });

  it('quotes every carried line of a push', () => {
    expect(renderForAgent(m, false, 'bob').split('\n')).toEqual([
      '[message from human:bob (remote: bob) · message · m-01]',
      '│ hello',
      '│ there',
      '│ refs: task:t-00000a01',
    ]);
  });
});
