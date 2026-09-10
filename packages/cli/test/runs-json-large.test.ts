import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { RunMeta } from '../src/apiClient.js';
import { daemonFilePath } from '../src/commands/daemon.js';
import { makeProgram } from '../src/program.js';

// `dispatch runs --json` was reported to truncate on a large registry when
// an agent polled it. The output path is console.log to a piped stdout,
// where a process.exit() before the pipe drains is the classic way to lose
// the tail of anything past the 64KB pipe buffer — so this drives the real
// CLI as a subprocess, stdout piped, against a registry several buffers
// long, and requires the whole document back.

const CLI = resolve(import.meta.dirname, '../src/cli.ts');
const AGENT_TOKEN = 'agent-token-from-the-daemon-file';

let root: string;
let fakeHome: string;
let server: ReturnType<typeof Bun.serve> | null = null;
const originalDispatchHome = process.env.DISPATCH_HOME;

function fakeRuns(count: number): RunMeta[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `r-${String(i).padStart(6, '0')}`,
    taskId: `t-${String(i).padStart(6, '0')}`,
    taskTitle: `Task number ${i} with a reasonably long title`,
    executor: 'claude',
    state: 'failed',
    branch: `dispatch/t-${i}/r-${i}`,
    baseBranch: 'main',
    worktreePath: `/home/user/.dispatch/worktrees/abcdef012345/r-${i}`,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:05:00.000Z',
    error: `verify failed: ${'lint: unexpected token at src/file.ts:12:3 — '.repeat(12)}`,
  }));
}

// Runs the CLI from source as a real child process with stdout piped —
// spawn, not spawnSync, which would block this process's Bun.serve from
// ever answering the child. DISPATCH_DAEMON_BIN points nowhere so that, if
// the child ever fails to find the fake daemon, it errors out instead of
// starting a real dispatchd in a temp dir.
function runCli(
  ...argv: string[]
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn('bun', [CLI, ...argv], {
      cwd: root,
      env: {
        ...process.env,
        DISPATCH_HOME: fakeHome,
        DISPATCH_DAEMON_BIN: join(fakeHome, 'no-such-dispatchd'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolvePromise({ stdout, stderr, code }));
  });
}

beforeEach(() => {
  // Real path: the child's process.cwd() is the resolved one, and the daemon
  // file is keyed on that exact string.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-cli-runs-')));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-runs-'));
  process.env.DISPATCH_HOME = fakeHome;
  makeProgram({ cwd: root, log: () => {} }).parse(['init'], { from: 'user' });
});

afterEach(async () => {
  await server?.stop(true);
  server = null;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('dispatch runs --json on a large registry', () => {
  it('delivers the whole document through a piped stdout', async () => {
    const runs = fakeRuns(200);
    const expected = JSON.stringify(runs, null, 2);
    // Several pipe buffers long, or the test proves nothing.
    expect(expected.length).toBeGreaterThan(2 * 64 * 1024);

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/api/health') return Response.json({ ok: true });
        if (req.headers.get('authorization') !== `Bearer ${AGENT_TOKEN}`) {
          return Response.json({ error: 'not recognized' }, { status: 401 });
        }
        if (path === '/api/runs') return Response.json(runs);
        return Response.json({ error: `unexpected ${path}` }, { status: 404 });
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
        agentToken: AGENT_TOKEN,
      })
    );

    const result = await runCli('runs', '--json');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${expected}\n`);
    expect((JSON.parse(result.stdout) as RunMeta[]).length).toBe(200);
  }, 30_000);
});
