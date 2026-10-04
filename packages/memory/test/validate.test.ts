import { describe, expect, it } from 'bun:test';

import { MemoryError } from '../src/errors.js';
import { cutUtf8, utf8Bytes } from '../src/limits.js';
import type { MemoryEntry } from '../src/types.js';
import {
  checkTarget,
  validateMemoryInput,
  validateQuery,
  validateReason,
} from '../src/validate.js';

// The MemoryError `fn` throws; anything else fails the test.
function failure(fn: () => unknown): MemoryError {
  try {
    fn();
  } catch (err) {
    if (err instanceof MemoryError) return err;
    throw err;
  }
  throw new Error('expected a MemoryError');
}

const base = {
  scope: 'team',
  kind: 'hazard',
  title: 'pnpm 11 ignores onlyBuiltDependencies; use allowBuilds',
  body: 'Seen on 2026-09-02.',
} as const;

describe('validateMemoryInput', () => {
  it('accepts a team hazard and fills the defaults', () => {
    expect(validateMemoryInput(base)).toEqual({
      ...base,
      refs: [],
      epic: null,
      appliesTo: [],
      projectKey: null,
    });
  });

  it('refuses control characters in a title: escapes, bidi overrides, NUL', () => {
    for (const title of [
      'pwned \u001b[2J',
      'a\u0000b',
      'admin\u202eexe.txt',
      'bell \u0007',
      'c1 \u009b31m',
    ]) {
      expect(
        failure(() => validateMemoryInput({ ...base, title }))
      ).toMatchObject({
        field: 'title',
        message: expect.stringContaining('control'),
      });
    }
    expect(validateMemoryInput({ ...base, title: 'tab\tis fine' }).title).toBe(
      'tab\tis fine'
    );
  });

  it('points an over-long body at doc_save', () => {
    expect(() =>
      validateMemoryInput({ ...base, body: 'x'.repeat(8193) })
    ).toThrow(
      'long-form belongs in a doc: doc_save it, then ref it from a short entry'
    );
  });

  it('keeps preferences personal and conventions shared', () => {
    expect(
      failure(() => validateMemoryInput({ ...base, kind: 'preference' })).field
    ).toBe('kind');
    expect(
      failure(() =>
        validateMemoryInput({ ...base, scope: 'personal', kind: 'convention' })
      ).field
    ).toBe('kind');
    expect(
      validateMemoryInput({ ...base, scope: 'personal', kind: 'preference' })
        .scope
    ).toBe('personal');
  });

  it('refuses reach fields on the wrong scope', () => {
    const personal = { ...base, scope: 'personal', kind: 'fact' } as const;
    expect(
      failure(() => validateMemoryInput({ ...personal, epic: 'e-1a2b3c' }))
        .field
    ).toBe('epic');
    expect(
      failure(() =>
        validateMemoryInput({ ...personal, appliesTo: ['t-1a2b3c'] })
      ).field
    ).toBe('appliesTo');
    expect(
      failure(() =>
        validateMemoryInput({ ...base, projectKey: '0123456789ab' })
      ).field
    ).toBe('projectKey');
    expect(
      validateMemoryInput({ ...personal, projectKey: '0123456789ab' })
        .projectKey
    ).toBe('0123456789ab');
  });

  it('checks task ids in epic and appliesTo', () => {
    expect(
      failure(() => validateMemoryInput({ ...base, epic: 'epic-7' })).field
    ).toBe('epic');
    expect(
      failure(() =>
        validateMemoryInput({ ...base, appliesTo: ['t-1a2b3c', 'nope'] })
      ).field
    ).toBe('appliesTo[1]');
    const many = Array.from(
      { length: 51 },
      (_, i) => `t-${(0x100000 + i).toString(16)}`
    );
    expect(
      failure(() => validateMemoryInput({ ...base, appliesTo: many })).field
    ).toBe('appliesTo');
  });

  it('measures the title in UTF-8 bytes', () => {
    expect(validateMemoryInput({ ...base, title: '€'.repeat(66) }).title).toBe(
      '€'.repeat(66)
    ); // 198 bytes
    expect(
      failure(() => validateMemoryInput({ ...base, title: '€'.repeat(67) }))
        .field
    ).toBe('title'); // 201
    expect(
      failure(() => validateMemoryInput({ ...base, title: '   ' })).field
    ).toBe('title');
  });

  it('rejects every line break in one-line fields', () => {
    for (const br of ['\n', '\r', '\v', '\f', '\u0085', ' ', ' ']) {
      expect(
        failure(() => validateMemoryInput({ ...base, title: `a${br}b` })).field
      ).toBe('title');
      expect(
        failure(() =>
          validateMemoryInput({
            ...base,
            refs: [{ type: 'task', id: `t-1${br}` }],
          })
        ).field
      ).toBe('refs[0].id');
    }
  });

  it('caps the body at 8 KiB and refs at 20', () => {
    expect(
      failure(() => validateMemoryInput({ ...base, body: 'x'.repeat(8193) }))
        .field
    ).toBe('body');
    const refs = Array.from({ length: 21 }, (_, i) => ({
      type: 'task' as const,
      id: `t-${i}`,
    }));
    expect(failure(() => validateMemoryInput({ ...base, refs })).field).toBe(
      'refs'
    );
    expect(
      failure(() =>
        validateMemoryInput({
          ...base,
          refs: [{ type: 'pr' as never, id: '1' }],
        })
      ).field
    ).toBe('refs[0].type');
  });

  it('maps every code to its status', () => {
    expect(new MemoryError('unavailable', 'down').status).toBe(503);
    expect(new MemoryError('limited', 'slow down').status).toBe(429);
  });
});

describe('checkTarget', () => {
  const entry = {
    id: 'mem-X',
    handle: '#AAAAAAAA',
    scope: 'team',
    status: 'active',
  } as MemoryEntry;

  it('needs a visible, active entry in the same scope', () => {
    expect(checkTarget(entry, 'team', 'supersedes', '#AAAAAAAA')).toBe(entry);
    expect(
      failure(() => checkTarget(null, 'team', 'supersedes', '#AAAAAAAA')).code
    ).toBe('not-found');
    expect(
      failure(() =>
        checkTarget({ ...entry, status: 'retired' }, 'team', 'supersedes', 'x')
      ).field
    ).toBe('supersedes');
    expect(
      failure(() =>
        checkTarget({ ...entry, scope: 'personal' }, 'team', 'supersedes', 'x')
      ).message
    ).toContain('personal');
  });
});

describe('reasons and queries', () => {
  it('keeps a reason to one non-empty line of 500 bytes', () => {
    expect(validateReason('stale')).toBe('stale');
    expect(failure(() => validateReason('a\nb')).field).toBe('reason');
    expect(failure(() => validateReason('x'.repeat(501))).field).toBe('reason');
    expect(failure(() => validateReason('  ')).field).toBe('reason');
  });

  it('caps a query at 500 bytes and allows an empty one', () => {
    expect(validateQuery('')).toBe('');
    expect(failure(() => validateQuery('x'.repeat(501))).field).toBe('query');
  });
});

describe('cutUtf8', () => {
  it('never splits a code point', () => {
    expect(cutUtf8('ab🧠cd', 5)).toBe('ab');
    expect(cutUtf8('ab🧠cd', 6)).toBe('ab🧠');
    expect(utf8Bytes(cutUtf8('漢字漢字', 7))).toBe(6);
  });
});
