import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ContentE2eStatus } from '../src/apiClient.js';
import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

// `dispatch team encrypt`: the status of e2e team content, and --on.

const OFF_READY: ContentE2eStatus = {
  on: false,
  since: null,
  sinceAt: null,
  current: null,
  epochs: [],
  missing: [],
  lacking: [],
  legacyClosed: true,
};
const ON: ContentE2eStatus = {
  on: true,
  since: 'a'.repeat(64),
  sinceAt: '2026-10-20T12:00:00.000Z',
  current: 'b'.repeat(64),
  epochs: [
    { epoch: 'a'.repeat(64), held: true },
    { epoch: 'b'.repeat(64), held: false },
  ],
  missing: ['b'.repeat(64)],
  lacking: [],
  legacyClosed: true,
};

let root: string;
let fakeHome: string;
let lines: string[];
let asked: string[];
let answer: boolean;
let status: ContentE2eStatus;
let posted: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
const originalHome = process.env.DISPATCH_HOME;
const originalToken = process.env.DISPATCH_APP_TOKEN;

const run = (...argv: string[]) =>
  makeProgram(ctx).parseAsync(argv, { from: 'user' });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-encrypt-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-encrypt-'));
  process.env.DISPATCH_HOME = fakeHome;
  process.env.DISPATCH_APP_TOKEN = 'app-token';
  lines = [];
  asked = [];
  answer = true;
  posted = [];
  status = OFF_READY;
  ctx = {
    cwd: root,
    log: (l) => lines.push(l),
    confirm: (question) => {
      asked.push(question);
      return Promise.resolve(answer);
    },
  };
  await run('init');
  lines = [];
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (url.pathname !== '/api/team/content-e2e')
        return Response.json({ error: 'not found' }, { status: 404 });
      if (req.method === 'POST') {
        posted.push(url.pathname);
        status = { ...ON, missing: [], epochs: ON.epochs.slice(0, 1) };
        return Response.json({ ...status, ok: true });
      }
      return Response.json(status);
    },
  });
  mkdirSync(join(fakeHome, '.dispatch', 'daemons'), { recursive: true });
  writeFileSync(
    daemonFilePath(root),
    JSON.stringify({
      port: server.port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
      agentToken: 'agent',
    })
  );
});

afterEach(() => {
  void server.stop(true);
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  if (originalToken === undefined) delete process.env.DISPATCH_APP_TOKEN;
  else process.env.DISPATCH_APP_TOKEN = originalToken;
});

describe('dispatch team encrypt', () => {
  it('prints who still needs to update and the legacy window while off', async () => {
    status = {
      ...OFF_READY,
      legacyClosed: false,
      lacking: [{ replica: 'bob-0000000b', handle: 'bob' }],
    };
    await run('team', 'encrypt');
    expect(lines).toEqual([
      'End-to-end encryption: off.',
      'Older Dispatch builds: still sync. Close the window first: dispatch team advanced close-legacy',
      'Still need to update Dispatch: bob',
    ]);
    expect(posted).toEqual([]);
  });

  it('prints the date and the keys still missing while on', async () => {
    status = ON;
    await run('team', 'encrypt');
    expect(lines).toEqual([
      'End-to-end encryption: on since 2026-10-20.',
      'Keys: this machine holds 1 of 2.',
      "Waiting for a key from a teammate: this machine asks for them, and a teammate's machine sends them on its next sync.",
    ]);
  });

  it('--json prints the status as the daemon answers it', async () => {
    await run('team', 'encrypt', '--json');
    expect(JSON.parse(lines.join('\n'))).toEqual(OFF_READY);
  });

  it('--on shows the limits, asks, and turns it on', async () => {
    await run('team', 'encrypt', '--on');
    expect(asked).toEqual(["Encrypt the team's content end to end?"]);
    expect(lines[0]).toBe(
      'Turning this on cannot be undone. What it does not do:'
    );
    expect(lines.join('\n')).toContain('no forward secrecy');
    expect(posted).toEqual(['/api/team/content-e2e']);
    expect(lines).toContain('End-to-end encryption: on since 2026-10-20.');
  });

  it('--on --yes skips the question', async () => {
    await run('team', 'encrypt', '--on', '--yes');
    expect(asked).toEqual([]);
    expect(posted).toEqual(['/api/team/content-e2e']);
  });

  it('--on stops at a no, and changes nothing', async () => {
    answer = false;
    await expect(run('team', 'encrypt', '--on')).rejects.toThrow(
      'Not turned on'
    );
    expect(posted).toEqual([]);
  });

  it('--on refuses before asking while a teammate lacks the build', async () => {
    status = {
      ...OFF_READY,
      lacking: [{ replica: 'bob-0000000b', handle: 'bob' }],
    };
    await expect(run('team', 'encrypt', '--on', '--yes')).rejects.toThrow(
      'Not ready'
    );
    expect(lines).toContain('Still need to update Dispatch: bob');
    expect(asked).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('--on while already on only prints the status', async () => {
    status = ON;
    await run('team', 'encrypt', '--on');
    expect(posted).toEqual([]);
    expect(lines[0]).toBe('End-to-end encryption: on since 2026-10-20.');
  });
});
