import { canonicalize, sha256Hex } from '@dispatch-foo/protocol/federation';
import { describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';

import {
  checkString,
  decodeTeamLink,
  defaultRelayUrl,
  encodeTeamLink,
  plainText,
  teamLinkUrl,
  teamStatus,
  whereOf,
} from '../../../src/team/federation/onboarding.js';
import type { TeamLink } from '../../../src/team/federation/onboarding.js';

const LINK: TeamLink = {
  team: 'a'.repeat(32),
  name: 'acme',
  by: 'ada',
  fp: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF',
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

// A link built by hand, its checksum right: what a hostile sender can make.
function forged(fields: Record<string, unknown>): string {
  const base = JSON.parse(
    Buffer.from(
      encodeTeamLink(LINK).slice('dispatch-team:'.length),
      'base64url'
    ).toString()
  ) as Record<string, unknown>;
  delete base.sum;
  const next = { ...base, ...fields };
  const sum = sha256Hex(canonicalize(next)).slice(0, 16);
  return `dispatch-team:${Buffer.from(canonicalize({ ...next, sum })).toString('base64url')}`;
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const RLO = String.fromCharCode(0x202e);

describe('a hostile link', () => {
  it('prints no escape sequence, bidi override or line break from its name', () => {
    const name = `acme${ESC}[31m red${ESC}]8;;https://evil${BEL}x${RLO}gpj.exe\nPWNED\r${String.fromCharCode(0x2028)}ok`;
    const decoded = decodeTeamLink(forged({ name }));
    expect(decoded.name).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u202e\u2028]/
    );
    expect(decoded.name).toBe('acme redx gpj.exe PWNED ok');
  });

  it('caps an over-long name', () => {
    const decoded = decodeTeamLink(forged({ name: 'n'.repeat(5000) }));
    expect([...decoded.name].length).toBeLessThanOrEqual(64);
  });

  it('refuses a handle, inviter, fingerprint or team id off its grammar', () => {
    for (const bad of [
      { handle: `bob${ESC}[2J` },
      { handle: 'Bob' },
      { by: 'ada\nPWNED' },
      { fp: `AAAA${RLO}` },
      { team: 'z'.repeat(32) },
      { via: { kind: 'relay', url: 'http://relay.example' } },
      { via: { kind: 'relay', url: 'wss://user:pw@relay.example' } },
      { via: { kind: 'carrier-pigeon' } },
      { name: `${ESC}[0m` },
    ])
      expect(() => decodeTeamLink(forged(bad))).toThrow('damaged');
  });

  it('shows a relay URL normalised', () => {
    const decoded = decodeTeamLink(
      forged({
        via: { kind: 'relay', url: 'wss://Relay.Example:443/a/?q=1#f' },
      })
    );
    expect(decoded.via).toEqual({
      kind: 'relay',
      url: 'wss://relay.example/a',
    });
  });

  it('cleans what a status line repeats of a joining link and peer text', () => {
    const status = teamStatus(
      {
        machine: { replica: 'bob-1', handle: 'bob', fingerprint: 'X' },
        view: null,
        pins: [],
        joining: {
          teamId: LINK.team,
          name: `acme${ESC}[31m\nx`,
          by: 'ada',
          fp: 'F',
        },
        foundings: [],
        waiting: [],
        health: {
          kind: 'git',
          lastExchangeAt: null,
          lastError: null,
          unpublished: 0,
          sizeBytes: null,
          readBytes: 0,
          acks: {},
        },
        lastSyncAt: null,
        lastError: `refused${ESC}]0;title${BEL}\nnext`,
        paused: null,
        problems: [{ subject: 'x', message: `a${RLO}b` }],
        olderBuilds: [],
        now: new Date(),
      },
      null
    );
    const text = [status.line, ...status.problems.map((p) => p.message)].join(
      ' | '
    );
    expect(text).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(status.line).toContain("Joining team 'acme x'");
  });

  it('plainText strips CSI, OSC and format characters and collapses space', () => {
    expect(plainText(`a${ESC}[1;31mb${ESC}]0;t${BEL}c\u200bd\te`)).toBe(
      'abc d e'
    );
  });
});
