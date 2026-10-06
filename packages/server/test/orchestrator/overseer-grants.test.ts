import { describe, expect, test } from 'bun:test';

import {
  GRANT_TTL_MS,
  grantKey,
  GrantStore,
} from '../../src/orchestrator/overseerGrants.js';

describe('grantKey', () => {
  test('Bash is scoped to the program it runs', () => {
    expect(grantKey('Bash', { command: 'moonx desktop:test' })).toBe(
      'Bash:moonx'
    );
    expect(
      grantKey('Bash', { command: 'FOO=1 ./node_modules/.bin/vitest run' })
    ).toBe('Bash:vitest');
    expect(grantKey('Bash', { command: '  git status' })).toBe('Bash:git');
  });

  test('other tools are scoped to the tool', () => {
    expect(grantKey('Edit', { file_path: 'a.ts' })).toBe('Edit');
  });
});

describe('GrantStore', () => {
  const now = Date.parse('2026-10-06T09:00:00Z');

  test('a grant allows the same key, not another program', () => {
    const store = new GrantStore();
    store.grant('c', 'Bash:moonx', now, 's-1');
    expect(store.allows('c', 'Bash:moonx', now, 's-1')).toBe(true);
    expect(store.allows('c', 'Bash:rm', now, 's-1')).toBe(false);
    expect(store.allows('other', 'Bash:moonx', now, 's-1')).toBe(false);
  });

  test('a grant ends after four hours', () => {
    const store = new GrantStore();
    store.grant('c', 'Edit', now, 's-1');
    expect(store.allows('c', 'Edit', now + GRANT_TTL_MS - 1, 's-1')).toBe(true);
    expect(store.allows('c', 'Edit', now + GRANT_TTL_MS, 's-1')).toBe(false);
    expect(store.list('c', now + GRANT_TTL_MS)).toEqual([]);
  });

  test('a grant ends at a context rollover (a new session)', () => {
    const store = new GrantStore();
    store.grant('c', 'Edit', now, 's-1');
    expect(store.allows('c', 'Edit', now, 's-2')).toBe(false);
  });

  test('grants are listed and revocable', () => {
    const store = new GrantStore();
    store.grant('c', 'Bash:moonx', now, 's-1');
    store.grant('c', 'Edit', now + 1000, 's-1');
    expect(store.list('c', now + 2000).map((g) => g.key)).toEqual([
      'Bash:moonx',
      'Edit',
    ]);
    expect(store.list('c', now + 2000)[0]).toEqual({
      key: 'Bash:moonx',
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + GRANT_TTL_MS).toISOString(),
    });
    expect(store.revoke('c', 'Bash:moonx')).toBe(true);
    expect(store.revoke('c', 'Bash:moonx')).toBe(false);
    expect(store.allows('c', 'Bash:moonx', now + 2000, 's-1')).toBe(false);
  });
});
