import { createUlidFactory } from '@dispatch-foo/protocol';
import { describe, expect, it } from 'bun:test';

import { memoryContentHash, normalizeTitle } from '../src/contentHash.js';
import { MemoryError } from '../src/errors.js';
import { HANDLE_PATTERN, memoryHandle, parseMemoryRef } from '../src/handle.js';

const ID = `mem-01K5Z6G${'0'.repeat(19)}`;

describe('memoryHandle', () => {
  it('is # plus 8 Crockford characters, stable per id', () => {
    expect(memoryHandle(ID)).toMatch(HANDLE_PATTERN);
    expect(memoryHandle(ID)).toBe(memoryHandle(ID));
  });

  // A monotonic ULID factory only bumps the last characters within one
  // millisecond; a slice of the id would give near-identical handles.
  it('gives same-millisecond ids unrelated handles', () => {
    const ulid = createUlidFactory(() => new Uint8Array(16));
    const handles = Array.from({ length: 1000 }, () =>
      memoryHandle(`mem-${ulid(1_760_000_000_000)}`)
    );
    expect(new Set(handles).size).toBe(1000);
    for (let i = 1; i < handles.length; i++) {
      expect(handles[i].slice(0, 8)).not.toBe(handles[i - 1].slice(0, 8));
    }
  });
});

describe('parseMemoryRef', () => {
  it('reads a handle in any case, and a full id', () => {
    expect(parseMemoryRef('#7qx2k9pa')).toEqual({
      kind: 'handle',
      handle: '#7QX2K9PA',
    });
    expect(parseMemoryRef(ID)).toEqual({ kind: 'id', id: ID });
  });

  it('points a messaging id at the right format', () => {
    let caught: unknown;
    try {
      parseMemoryRef(`m-01K5Z6G${'0'.repeat(19)}`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryError);
    expect((caught as MemoryError).message).toContain(
      'that is a message id; memory handles start with #'
    );
    expect((caught as MemoryError).field).toBe('id');
  });

  it('refuses anything else', () => {
    expect(() => parseMemoryRef('7QX2K9PA')).toThrow(MemoryError);
    expect(() => parseMemoryRef('#7QX2K9P')).toThrow(MemoryError);
  });
});

describe('memoryContentHash', () => {
  const content = {
    kind: 'hazard',
    title: 't',
    body: 'b',
    refs: [{ type: 'task', id: 't-1a2b3c' }],
  } as const;

  it('is stable and sees every field', () => {
    expect(memoryContentHash(content)).toBe(memoryContentHash({ ...content }));
    expect(memoryContentHash({ ...content, refs: [] })).not.toBe(
      memoryContentHash(content)
    );
    expect(memoryContentHash({ ...content, kind: 'fact' })).not.toBe(
      memoryContentHash(content)
    );
  });

  it('folds case and whitespace in titles', () => {
    expect(normalizeTitle('  Use  allowBuilds\tNOT only… ')).toBe(
      'use allowbuilds not only…'
    );
  });
});
