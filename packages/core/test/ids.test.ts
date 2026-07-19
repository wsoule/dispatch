import { describe, expect, it } from 'bun:test';

import { generateTaskId } from '../src/ids.js';
import { slugify } from '../src/slug.js';

describe('generateTaskId', () => {
  it('prefixes tasks with t- and epics with e-, 6 hex chars', () => {
    expect(
      generateTaskId('task', 'Fix login', '2026-07-13T00:00:00Z', 'n1')
    ).toMatch(/^t-[0-9a-f]{6}$/);
    expect(
      generateTaskId('epic', 'Auth', '2026-07-13T00:00:00Z', 'n1')
    ).toMatch(/^e-[0-9a-f]{6}$/);
  });
  it('is deterministic for identical inputs, differs across nonces', () => {
    const a = generateTaskId('task', 'X', '2026-01-01T00:00:00Z', 'n1');
    expect(generateTaskId('task', 'X', '2026-01-01T00:00:00Z', 'n1')).toBe(a);
    expect(generateTaskId('task', 'X', '2026-01-01T00:00:00Z', 'n2')).not.toBe(
      a
    );
  });
  it('generates a random nonce when omitted', () => {
    const a = generateTaskId('task', 'X', '2026-01-01T00:00:00Z');
    const b = generateTaskId('task', 'X', '2026-01-01T00:00:00Z');
    expect(a).not.toBe(b);
  });
});

describe('slugify', () => {
  it('lowercases, replaces non-alphanumerics with dashes, collapses and trims', () => {
    expect(slugify('Fix Login: Redirect Loop!')).toBe(
      'fix-login-redirect-loop'
    );
  });
  it('caps length at 40 chars without trailing dash', () => {
    const s = slugify('word '.repeat(30));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });
});
