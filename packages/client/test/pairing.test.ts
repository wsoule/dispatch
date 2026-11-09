import { describe, expect, it } from 'bun:test';

import {
  formatPairingLink,
  normalizeDaemonUrl,
  parsePairingLink,
  remoteUrlProblem,
} from '../src/api';

describe('pairing links', () => {
  it('round-trips the link `dispatch pair` prints', () => {
    const link = formatPairingLink(
      'https://devbox.example.com:4771',
      'AB12-CD34'
    );
    expect(parsePairingLink(link)).toEqual({
      baseUrl: 'https://devbox.example.com:4771',
      code: 'AB12-CD34',
    });
  });

  it('reads anything else as no link', () => {
    expect(parsePairingLink('https://dispatch.foo/pair?code=x')).toBeNull();
    expect(parsePairingLink('dispatch://task/t-123456')).toBeNull();
    expect(parsePairingLink('dispatch://pair?url=https://a')).toBeNull();
    expect(parsePairingLink('not a url')).toBeNull();
  });
});

describe('remoteUrlProblem', () => {
  it('accepts https anywhere', () => {
    expect(remoteUrlProblem('https://devbox.tail1234.ts.net')).toBeNull();
  });

  it('accepts plain http only to loopback, where an SSH forward lands', () => {
    expect(remoteUrlProblem('http://127.0.0.1:4800')).toBeNull();
    expect(remoteUrlProblem('http://localhost:4800')).toBeNull();
    expect(remoteUrlProblem('http://[::1]:4800')).toBeNull();
    expect(remoteUrlProblem('http://192.168.1.20:4771')).toContain('https');
    expect(remoteUrlProblem('http://devbox.local:4771')).toContain('https');
  });

  it('refuses other schemes and non-URLs', () => {
    expect(remoteUrlProblem('ws://devbox:4771')).toContain('unsupported');
    expect(remoteUrlProblem('devbox:4771')).not.toBeNull();
    expect(remoteUrlProblem('')).toContain('not a URL');
  });

  it('keeps only the origin of a pasted URL', () => {
    expect(normalizeDaemonUrl(' https://devbox:4771/board?x=1 ')).toBe(
      'https://devbox:4771'
    );
  });
});
