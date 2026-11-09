import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { credentialsPath } from '../src/credentials.js';
import {
  accountToken,
  addAgentAccount,
  readAgentAccounts,
  removeAgentAccount,
  setAccountFailover,
} from '../src/setup/agentAccounts.js';

let home: string;
const savedHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-agent-accounts-'));
  process.env.DISPATCH_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('agent accounts', () => {
  it('keeps accounts in the order added and never lists tokens', () => {
    addAgentAccount('claude', 'work', 'tok-work', '2026-10-20T00:00:00Z');
    addAgentAccount('claude', 'home', 'tok-home', '2026-10-20T01:00:00Z');
    const view = readAgentAccounts('claude');
    expect(view.accounts.map((a) => a.label)).toEqual(['work', 'home']);
    expect(JSON.stringify(view)).not.toContain('tok-');
    expect(accountToken('claude', 'home')).toBe('tok-home');
    expect(accountToken('claude', 'default')).toBeUndefined();
  });

  it('replacing a token keeps the account in place', () => {
    addAgentAccount('claude', 'a', 'one');
    addAgentAccount('claude', 'b', 'two');
    addAgentAccount('claude', 'a', ' three ');
    expect(readAgentAccounts('claude').accounts.map((a) => a.label)).toEqual([
      'a',
      'b',
    ]);
    expect(accountToken('claude', 'a')).toBe('three');
  });

  it('refuses the default label, bad labels, empty tokens and other executors', () => {
    expect(() => addAgentAccount('claude', 'default', 't')).toThrow();
    expect(() => addAgentAccount('claude', 'has space', 't')).toThrow();
    expect(() => addAgentAccount('claude', 'ok', '  ')).toThrow();
    expect(() => addAgentAccount('codex', 'ok', 't')).toThrow();
  });

  it('failover is off until switched on, and removal clears the entry', () => {
    addAgentAccount('claude', 'work', 'tok');
    expect(readAgentAccounts('claude').failover).toBe(false);
    setAccountFailover('claude', true);
    expect(readAgentAccounts('claude').failover).toBe(true);
    expect(removeAgentAccount('claude', 'work')).toBe(true);
    expect(removeAgentAccount('claude', 'work')).toBe(false);
    setAccountFailover('claude', false);
    const file = JSON.parse(readFileSync(credentialsPath(), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(file.agentAccounts).toBeUndefined();
  });
});
