import { readAgentAccounts } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

// `dispatch accounts`: stored subscription accounts for usage-limit failover.
// The token is a secret, so it is read from stdin or a prompt, never argv.

let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
const originalHome = process.env.DISPATCH_HOME;

const run = (...argv: string[]) =>
  makeProgram(ctx).parseAsync(argv, { from: 'user' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-accounts-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-accounts-'));
  process.env.DISPATCH_HOME = fakeHome;
  lines = [];
  ctx = {
    cwd: root,
    log: (l) => lines.push(l),
    readSecret: () => Promise.resolve(' oat-work \n'),
  };
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('dispatch accounts', () => {
  it('adds an account, switches failover on, lists and removes it', async () => {
    await run('accounts', 'add', 'work');
    expect(lines.join('\n')).not.toContain('oat-work');
    expect(lines.at(-1)).toContain('failover on');
    lines = [];
    await run('accounts', 'failover', 'on');
    expect(readAgentAccounts('claude').failover).toBe(true);
    lines = [];
    await run('accounts');
    expect(lines[0]).toBe('claude: failover on');
    expect(lines[1]).toContain('1. default');
    expect(lines[2]).toContain('2. work');
    await run('accounts', 'remove', 'work');
    expect(readAgentAccounts('claude').accounts).toEqual([]);
  });

  it('refuses an executor without accounts and a bad failover state', async () => {
    await expect(
      run('accounts', 'add', 'work', '--executor', 'codex')
    ).rejects.toThrow('does not take stored accounts');
    await expect(run('accounts', 'failover', 'maybe')).rejects.toThrow(
      'on" or "off'
    );
    await expect(run('accounts', 'remove', 'nobody')).rejects.toThrow(
      'no claude account named nobody'
    );
  });
});
