import { describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';

import {
  checkString,
  decodeTeamLink,
  defaultRelayUrl,
  encodeTeamLink,
  teamLinkUrl,
  whereOf,
} from '../../../src/team/federation/onboarding.js';
import type { TeamLink } from '../../../src/team/federation/onboarding.js';

const LINK: TeamLink = {
  team: 'a'.repeat(32),
  name: 'acme',
  by: 'ada',
  fp: 'AAAA-BBBB',
  handle: 'bob',
  seed: randomBytes(32),
  expires: '2026-10-13T00:00:00.000Z',
  via: { kind: 'relay', url: 'wss://relay.dispatch.foo' },
  remote: 'git@github.com:acme/app.git',
};

describe('team links', () => {
  it('round-trips, in both the dispatch-team: and the URL form', () => {
    const link = encodeTeamLink(LINK);
    expect(link.startsWith('dispatch-team:')).toBe(true);
    expect(decodeTeamLink(link)).toEqual(LINK);
    expect(decodeTeamLink(teamLinkUrl(link))).toEqual(LINK);
    expect(decodeTeamLink(`  ${link}\n`)).toEqual(LINK);
  });

  it('refuses a damaged link, one from a newer build, and anything else', () => {
    const link = encodeTeamLink(LINK);
    const cut = link.slice(0, -4);
    expect(() => decodeTeamLink(cut)).toThrow('damaged');
    const payload = JSON.parse(
      Buffer.from(link.slice('dispatch-team:'.length), 'base64url').toString()
    ) as Record<string, unknown>;
    const tampered = `dispatch-team:${Buffer.from(
      JSON.stringify({ ...payload, handle: 'eve' })
    ).toString('base64url')}`;
    expect(() => decodeTeamLink(tampered)).toThrow('damaged');
    expect(() => decodeTeamLink('di1.x')).toThrow('not a Dispatch team');
  });

  it('gives both machines the same six-digit check, and others a different one', () => {
    const one = checkString(LINK.team, 'AAAA', 'BBBB');
    expect(one).toMatch(/^\d{3} \d{3}$/);
    expect(checkString(LINK.team, 'BBBB', 'AAAA')).toBe(one);
    expect(checkString(LINK.team, 'AAAA', 'CCCC')).not.toBe(one);
  });

  it('defaults to the hosted relay, overridable by DISPATCH_RELAY_URL', () => {
    expect(defaultRelayUrl({})).toBe('wss://relay.dispatch.foo');
    expect(defaultRelayUrl({ DISPATCH_RELAY_URL: 'wss://r.example' })).toBe(
      'wss://r.example'
    );
  });

  it('names where a team syncs in a few words', () => {
    const health = {
      kind: 'relay' as const,
      lastExchangeAt: null,
      lastError: null,
      unpublished: 0,
      sizeBytes: null,
      readBytes: 0,
      acks: {},
      url: 'wss://relay.dispatch.foo',
    };
    expect(whereOf(health, null)).toBe('relay.dispatch.foo');
    expect(
      whereOf(
        { ...health, kind: 'git', url: undefined },
        'git@github.com:acme/app.git'
      )
    ).toBe('git (acme/app)');
  });
});
