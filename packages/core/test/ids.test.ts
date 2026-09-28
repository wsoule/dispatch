import { describe, expect, it, test } from 'bun:test';

import {
  generateFindingId,
  generateLedgerId,
  generateRunId,
  generateSyncedRunId,
  generateSyncedTaskId,
  generateTaskId,
  isTaskId,
  SYNCED_RUN_ID_HEX,
  taskIdFromFilename,
} from '../src/ids.js';
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

describe('generateRunId', () => {
  it('prefixes with r-, 6 hex chars', () => {
    expect(generateRunId('2026-07-13T00:00:00Z', 'n1')).toMatch(
      /^r-[0-9a-f]{6}$/
    );
  });
  it('is deterministic for identical inputs, differs across nonces', () => {
    const a = generateRunId('2026-01-01T00:00:00Z', 'n1');
    expect(generateRunId('2026-01-01T00:00:00Z', 'n1')).toBe(a);
    expect(generateRunId('2026-01-01T00:00:00Z', 'n2')).not.toBe(a);
  });
  it('generates a random nonce when omitted', () => {
    const a = generateRunId('2026-01-01T00:00:00Z');
    const b = generateRunId('2026-01-01T00:00:00Z');
    expect(a).not.toBe(b);
  });
  it('mints 12 hex characters for a synced board', () => {
    expect(generateSyncedRunId('2026-09-26T00:00:00Z')).toMatch(
      /^r-[0-9a-f]{12}$/
    );
    expect(generateRunId('2026-09-26T00:00:00Z', 'n1')).toMatch(
      /^r-[0-9a-f]{6}$/
    );
    expect(
      generateRunId('2026-09-26T00:00:00Z', 'n1', SYNCED_RUN_ID_HEX).slice(0, 8)
    ).toBe(generateRunId('2026-09-26T00:00:00Z', 'n1'));
  });
});

describe('generateFindingId', () => {
  it('prefixes with f-, 6 hex chars', () => {
    expect(generateFindingId('2026-07-13T00:00:00Z', 'n1')).toMatch(
      /^f-[0-9a-f]{6}$/
    );
  });
  it('is deterministic for identical inputs, differs across nonces', () => {
    const a = generateFindingId('2026-01-01T00:00:00Z', 'n1');
    expect(generateFindingId('2026-01-01T00:00:00Z', 'n1')).toBe(a);
    expect(generateFindingId('2026-01-01T00:00:00Z', 'n2')).not.toBe(a);
  });
  it('generates a random nonce when omitted', () => {
    const a = generateFindingId('2026-01-01T00:00:00Z');
    const b = generateFindingId('2026-01-01T00:00:00Z');
    expect(a).not.toBe(b);
  });
});

describe('generateLedgerId', () => {
  it('prefixes with l-, 6 hex chars', () => {
    expect(generateLedgerId('2026-07-13T00:00:00Z', 'n1')).toMatch(
      /^l-[0-9a-f]{6}$/
    );
  });
  it('is deterministic for identical inputs, differs across nonces', () => {
    const a = generateLedgerId('2026-01-01T00:00:00Z', 'n1');
    expect(generateLedgerId('2026-01-01T00:00:00Z', 'n1')).toBe(a);
    expect(generateLedgerId('2026-01-01T00:00:00Z', 'n2')).not.toBe(a);
  });
  it('generates a random nonce when omitted', () => {
    const a = generateLedgerId('2026-01-01T00:00:00Z');
    const b = generateLedgerId('2026-01-01T00:00:00Z');
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

describe('synced task ids', () => {
  test('a synced board mints eight hex characters', () => {
    const id = generateSyncedTaskId(
      'task',
      'Fix login',
      '2026-09-23T00:00:00Z'
    );
    expect(id).toMatch(/^t-[0-9a-f]{8}$/);
    expect(isTaskId(id)).toBe(true);
    expect(
      generateSyncedTaskId('epic', 'Auth', '2026-09-23T00:00:00Z')
    ).toMatch(/^e-[0-9a-f]{8}$/);
  });

  test('the id pattern takes both lengths and still nothing but hex', () => {
    expect(isTaskId('t-abc123')).toBe(true);
    expect(isTaskId('t-abc12345')).toBe(true);
    expect(isTaskId('t-abc12')).toBe(false);
    expect(isTaskId('t-abc123abc123a')).toBe(false);
    // The guard exists to keep a hand-written id out of a filesystem path.
    expect(isTaskId('t-../../x')).toBe(false);
    expect(isTaskId('t-abc123/..')).toBe(false);
  });
});

describe('taskIdFromFilename', () => {
  test('reads six- and eight-character ids alike', () => {
    expect(taskIdFromFilename('t-abc123-fix-login')).toBe('t-abc123');
    expect(taskIdFromFilename('t-abc12345-fix-login')).toBe('t-abc12345');
    expect(taskIdFromFilename('e-abc12345')).toBe('e-abc12345');
  });

  test('a slug that starts with hex is not read as part of the id', () => {
    // The id's hex run ends at the dash, whatever the slug looks like.
    expect(taskIdFromFilename('t-abc123-deadbeef')).toBe('t-abc123');
  });

  test('anything else is not a task file', () => {
    expect(taskIdFromFilename('README')).toBeNull();
    expect(taskIdFromFilename('t-xyz123-nope')).toBeNull();
    expect(taskIdFromFilename('t-abc123x')).toBeNull();
  });
});
