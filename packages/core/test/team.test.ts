import { describe, expect, it } from 'bun:test';

import {
  handleFromEmail,
  parseTeam,
  serializeTeam,
  TeamParseError,
  upsertMember,
} from '../src/team.js';

describe('handleFromEmail', () => {
  it('uses the local part, lowercased', () => {
    expect(handleFromEmail('Wyat.Soule@example.com', new Set())).toBe(
      'wyat.soule'
    );
  });

  it('strips characters a handle cannot hold', () => {
    expect(handleFromEmail('a+tag@example.com', new Set())).toBe('atag');
  });

  it('suffixes on collision', () => {
    expect(handleFromEmail('wyat@a.com', new Set(['wyat']))).toBe('wyat2');
    expect(handleFromEmail('wyat@a.com', new Set(['wyat', 'wyat2']))).toBe(
      'wyat3'
    );
  });

  it('falls back when the local part yields nothing usable', () => {
    expect(handleFromEmail('+++@example.com', new Set())).toBe('member');
  });
});

describe('parseTeam / serializeTeam', () => {
  it('round-trips a roster', () => {
    const members = [
      {
        handle: 'wyat',
        email: 'w@example.com',
        displayName: 'Wyat Soule',
        emails: ['old@example.com'],
      },
    ];
    expect(parseTeam(serializeTeam(members))).toEqual(members);
  });

  it('treats an empty or absent file as an empty roster', () => {
    expect(parseTeam('')).toEqual([]);
    expect(parseTeam('members: []\n')).toEqual([]);
  });

  it('defaults a missing emails list', () => {
    const yaml =
      'members:\n  - handle: a\n    email: a@x.com\n    displayName: A\n';
    expect(parseTeam(yaml)[0]?.emails).toEqual([]);
  });

  it('throws a typed error on malformed yaml rather than losing the roster', () => {
    expect(() =>
      parseTeam('members:\n  - handle: a\n  email: a@x.com')
    ).toThrow(TeamParseError);
  });

  it('drops an entry with no usable handle or email', () => {
    expect(parseTeam('members:\n  - displayName: A\n')).toEqual([]);
  });

  it('drops an entry whose handle is not a scalar', () => {
    expect(
      parseTeam('members:\n  - handle:\n      nested: x\n    email: a@x.com\n')
    ).toEqual([]);
  });

  it('defaults displayName to the handle when it is absent', () => {
    const yaml = 'members:\n  - handle: a\n    email: a@x.com\n';
    expect(parseTeam(yaml)[0]?.displayName).toBe('a');
  });
});

describe('upsertMember', () => {
  it('adds an unknown email as a new member', () => {
    const r = upsertMember([], 'w@example.com', 'Wyat');
    expect(r.changed).toBe(true);
    expect(r.member.handle).toBe('w');
    expect(r.members).toHaveLength(1);
  });

  it('is a no-op when the member is already present', () => {
    const first = upsertMember([], 'w@example.com', 'Wyat');
    const second = upsertMember(first.members, 'w@example.com', 'Wyat');
    expect(second.changed).toBe(false);
    expect(second.members).toHaveLength(1);
  });

  it('keeps the handle stable when the caller names it', () => {
    const first = upsertMember([], 'old@example.com', 'Wyat');
    const second = upsertMember(
      first.members,
      'new@example.com',
      'Wyat',
      first.member.handle
    );
    expect(second.member.handle).toBe(first.member.handle);
    expect(second.member.email).toBe('new@example.com');
    expect(second.member.emails).toContain('old@example.com');
    expect(second.members).toHaveLength(1);
  });

  it('matches a member by a prior address', () => {
    const first = upsertMember([], 'old@example.com', 'Wyat');
    const moved = upsertMember(
      first.members,
      'new@example.com',
      'Wyat',
      first.member.handle
    );
    const back = upsertMember(moved.members, 'old@example.com', 'Wyat');
    expect(back.members).toHaveLength(1);
  });

  it('never merges two people who share a display name', () => {
    const first = upsertMember([], 'alex.kim@example.com', 'Alex Kim');
    const second = upsertMember(first.members, 'akim@example.com', 'Alex Kim');
    expect(second.members).toHaveLength(2);
    expect(second.member.handle).not.toBe(first.member.handle);
  });

  it('ignores a known handle that is not in the roster', () => {
    const r = upsertMember([], 'w@example.com', 'Wyat', 'ghost');
    expect(r.members).toHaveLength(1);
    expect(r.member.handle).toBe('w');
  });
});
