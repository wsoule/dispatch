import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultAsyncGitRunner,
  spawnWithDeadline,
} from '../../src/sync/worktree.js';

describe('spawnWithDeadline', () => {
  it('returns the command output and exit status when it finishes in time', async () => {
    const result = await spawnWithDeadline(
      ['sh', '-c', 'echo out; echo err >&2; exit 3'],
      tmpdir(),
      5_000
    );
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
  });

  it('kills a command that outlives the deadline even when it ignores SIGTERM', async () => {
    const started = Date.now();
    const result = await spawnWithDeadline(
      ['sh', '-c', 'trap "" TERM; sleep 20'],
      tmpdir(),
      300
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.status).toBe(-1);
    expect(result.stderr).toContain('killed after 300ms');
  });

  it('does not hold the event loop while the command runs', async () => {
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 20);
    try {
      await spawnWithDeadline(['sleep', '0.3'], tmpdir(), 5_000);
    } finally {
      clearInterval(ticker);
    }
    expect(ticks).toBeGreaterThan(3);
  });

  it('runs in the given directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-deadline-'));
    try {
      const result = await spawnWithDeadline(['pwd'], dir, 5_000);
      expect(
        result.stdout.trim().endsWith(dir.split('/').at(-1) as string)
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// defaultAsyncGitRunner is the production path for `pull` and `push` — the
// two commands that reach the network, and the ones the 2026-08-23 daemon was
// stuck in. This covers it end to end against a real remote.
//
// It deliberately does NOT claim to prove NO_PROMPT_ENV works: git only opens
// a credential prompt when it has a tty, and a test runner has none, so this
// remote fails fast with or without those vars. (Checked by mutation —
// removing NO_PROMPT_ENV from either runner fails nothing, which is equally
// true of boardSyncer.test.ts's older "should not hang the daemon" case.
// Proving prompt suppression needs a pty harness nothing here has.)
describe('defaultAsyncGitRunner', () => {
  it('reports a failing remote as a non-zero status instead of hanging', async () => {
    // Its own OS process, so the stub keeps answering while the test awaits.
    const serverScript = `
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response('auth required', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="git"' },
          });
        },
      });
      console.log(server.port);
    `;
    const serverProc = Bun.spawn(['bun', '-e', serverScript], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-async-remote-'));
    try {
      const reader = serverProc.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      const port = new TextDecoder().decode(value ?? new Uint8Array()).trim();

      await spawnWithDeadline(['git', 'init', '-q'], dir, 10_000);
      await spawnWithDeadline(
        ['git', 'remote', 'add', 'origin', `http://127.0.0.1:${port}/repo.git`],
        dir,
        10_000
      );

      const startedAt = Date.now();
      const result = await defaultAsyncGitRunner(dir, ['fetch', 'origin']);

      expect(result.status).not.toBe(0);
      // git's own complaint reaches the caller, so BoardSyncer can put it in
      // a `local-only` result rather than reporting a bare exit code.
      expect(result.stderr.length).toBeGreaterThan(0);
      // Well inside GIT_TIMEOUT_MS, so a pass here means git returned on its
      // own rather than the 30s backstop rescuing it.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      serverProc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
