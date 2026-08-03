import { describe, expect, it } from 'bun:test';
import { parse } from 'yaml';

import { mergeTeamFile } from '../src/mergeTeam.js';

const member = (
  handle: string,
  overrides: Partial<Record<string, unknown>> = {}
) => ({
  handle,
  email: `${handle}@example.com`,
  displayName: handle,
  emails: [],
  ...overrides,
});

const doc = (...members: ReturnType<typeof member>[]) =>
  `members:\n${members
    .map(
      (m) =>
        `  - handle: ${m.handle}\n    email: ${m.email}\n    displayName: ${m.displayName}\n    emails: ${
          (m.emails as string[]).length === 0
            ? '[]'
            : `\n${(m.emails as string[]).map((e) => `      - ${e}`).join('\n')}`
        }`
    )
    .join('\n')}\n`;

describe('mergeTeamFile', () => {
  it('keeps two members appended concurrently on both sides', () => {
    const base = doc(member('wyat'));
    const ours = doc(member('wyat'), member('alice'));
    const theirs = doc(member('wyat'), member('bob'));
    const result = mergeTeamFile(base, ours, theirs);
    expect(result.ok).toBe(true);
    const parsed = parse(result.merged) as { members: { handle: string }[] };
    const handles = parsed.members.map((m) => m.handle).sort();
    expect(handles).toEqual(['alice', 'bob', 'wyat']);
  });

  it('conflicts when the same member is edited differently on both sides', () => {
    const base = doc(member('alice', { email: 'a@old.com' }));
    const ours = doc(member('alice', { email: 'a@ours.com' }));
    const theirs = doc(member('alice', { email: 'a@theirs.com' }));
    const result = mergeTeamFile(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.merged).toContain('<<<<<<< ours');
    expect(result.merged).toContain('a@ours.com');
    expect(result.merged).toContain('a@theirs.com');
    // The conflict-marked output must not silently parse as a clean roster.
    expect(() => {
      parse(result.merged);
    }).toThrow();
  });

  it('does not duplicate a member added identically on both sides', () => {
    const base = doc(member('wyat'));
    const added = doc(member('wyat'), member('alice'));
    const result = mergeTeamFile(base, added, added);
    expect(result.ok).toBe(true);
    const parsed = parse(result.merged) as { members: { handle: string }[] };
    expect(parsed.members.filter((m) => m.handle === 'alice')).toHaveLength(1);
  });

  it('resolves a member removed on one side and untouched on the other', () => {
    const base = doc(member('wyat'), member('alice'));
    const removed = doc(member('wyat'));
    const untouched = doc(member('wyat'), member('alice'));
    const result = mergeTeamFile(base, removed, untouched);
    expect(result.ok).toBe(true);
    const parsed = parse(result.merged) as { members: { handle: string }[] };
    expect(parsed.members.map((m) => m.handle)).toEqual(['wyat']);
  });

  it('leaves an untouched roster unchanged (no false conflicts)', () => {
    const base = doc(member('wyat'), member('alice'));
    const result = mergeTeamFile(base, base, base);
    expect(result.ok).toBe(true);
    const parsed = parse(result.merged) as { members: { handle: string }[] };
    expect(parsed.members.map((m) => m.handle).sort()).toEqual([
      'alice',
      'wyat',
    ]);
  });
});
