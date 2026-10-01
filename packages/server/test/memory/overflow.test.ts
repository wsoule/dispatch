import { describe, expect, it } from 'bun:test';

import type { DocsOverflowPort } from '../../src/memory/overflow.js';
import { docsOverflowPort, overflowBody } from '../../src/memory/overflow.js';

const DOC = 'doc-01K3Z9R0000000000000000000';
const FULL = 'line of text\n'.repeat(1000).trimEnd();
const entry = {
  id: 'mem-01',
  scope: 'personal',
  projectKey: 'aaaaaaaaaaaa',
  title: 'Long note',
  refs: [{ type: 'task', id: 't-1' }],
};
const ctx = (port: DocsOverflowPort | null) => ({
  projectKey: 'aaaaaaaaaaaa',
  human: 'human:wyat',
  identity: 'self',
  port,
});
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('overflowBody', () => {
  it('hands a project-keyed personal entry’s full text to a doc and refs it', () => {
    const asked: unknown[] = [];
    const port = {
      overflow: (i: unknown) => {
        asked.push(i);
        return DOC;
      },
    };
    const out = overflowBody(entry, { fullBody: FULL }, ctx(port));
    expect(out?.body).toMatch(
      new RegExp(
        `\\n\\[truncated by Dispatch: \\d+ bytes; full text in doc ${DOC} of project aaaaaaaaaaaa\\]$`
      )
    );
    expect(bytes(out?.body ?? '')).toBeLessThanOrEqual(8192);
    expect(out?.refs).toEqual([
      { type: 'task', id: 't-1' },
      { type: 'doc', id: DOC },
    ]);
    expect(asked).toEqual([
      {
        entryId: 'mem-01',
        human: 'human:wyat',
        identity: 'self',
        title: 'Long note',
        body: FULL,
      },
    ]);
  });

  it('leaves everything else plain and never asks docs', () => {
    let asked = 0;
    const port = {
      overflow: () => {
        asked += 1;
        return DOC;
      },
    };
    for (const [e, parsed] of [
      [entry, {}],
      [{ ...entry, scope: 'team' }, { fullBody: FULL }],
      [{ ...entry, scope: 'project' }, { fullBody: FULL }],
      [{ ...entry, projectKey: null }, { fullBody: FULL }],
      [{ ...entry, projectKey: 'bbbbbbbbbbbb' }, { fullBody: FULL }],
    ] as const) {
      expect(overflowBody(e, parsed, ctx(port))).toBeNull();
    }
    expect(asked).toBe(0);
    expect(overflowBody(entry, { fullBody: FULL }, ctx(null))).toBeNull();
    expect(
      overflowBody(entry, { fullBody: FULL }, ctx({ overflow: () => null }))
    ).toBeNull();
    expect(
      overflowBody(
        entry,
        { fullBody: FULL },
        ctx({
          overflow: () => {
            throw new Error('docs.db is busy');
          },
        })
      )
    ).toBeNull();
  });
});

describe('docsOverflowPort', () => {
  const docs = (available: boolean) => {
    const calls: string[] = [];
    return {
      calls,
      service: {
        available,
        overflowFromMemory: (i: { identity: string }) => {
          calls.push(i.identity);
          return DOC;
        },
      },
    };
  };
  const input = (identity: string) => ({
    entryId: 'mem-01',
    human: 'human:wyat',
    identity,
    title: 't',
    body: 'b',
  });

  it('answers null with docs down, and for a sentinel identity many humans share', () => {
    const up = docs(true);
    const port = docsOverflowPort(up.service);
    expect(port.overflow(input('self'))).toBe(DOC);
    expect(port.overflow(input('pid-01K3Z9R0000000000000000000'))).toBe(DOC);
    expect(port.overflow(input('identities-down'))).toBeNull();
    expect(port.overflow(input(''))).toBeNull();
    expect(up.calls).toEqual(['self', 'pid-01K3Z9R0000000000000000000']);
    expect(
      docsOverflowPort(docs(false).service).overflow(input('self'))
    ).toBeNull();
  });
});
