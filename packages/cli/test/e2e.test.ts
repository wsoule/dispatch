import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve(import.meta.dirname, '../dist/cli.js');
let repo: string;
// `task status` resolves an ActorContext (git identity + team.yml roster),
// which writes a known-handle file under DISPATCH_HOME — the child process
// otherwise inherits the shared fallback home from packages/server/test/
// setup.ts's preload, which the test-setup contract there forbids writing
// into (see its own doc comment). Isolated once for the whole file since
// this suite never touches it directly.
let dispatchHome: string;

// Runs a command in the temp repo and returns trimmed stdout; throws on
// non-zero exit so a failing CLI invocation fails the test loudly.
function run(cmd: string[]): string {
  const proc = Bun.spawnSync({
    cmd,
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, DISPATCH_HOME: dispatchHome },
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `${cmd.join(' ')} exited ${proc.exitCode}: ${proc.stderr.toString()}`
    );
  }
  return proc.stdout.toString().trim();
}

function dispatch(...args: string[]): string {
  return run(['node', BIN, ...args]);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'dispatch-e2e-'));
  dispatchHome = mkdtempSync(join(tmpdir(), 'dispatch-e2e-home-'));
  run(['git', 'init', '-q']);
}, 20_000);

describe('dispatch e2e', () => {
  it('init → create → block → status → next → doctor', () => {
    dispatch('init');
    const a = JSON.parse(dispatch('task', 'create', 'Build parser', '--json'));
    const b = JSON.parse(
      dispatch(
        'task',
        'create',
        'Use parser',
        '--blocked-by',
        a.meta.id,
        '--json'
      )
    );
    let next = JSON.parse(dispatch('task', 'next', '--json'));
    expect(next.map((t: { meta: { id: string } }) => t.meta.id)).toEqual([
      a.meta.id,
    ]);

    dispatch('task', 'status', a.meta.id, 'done');
    next = JSON.parse(dispatch('task', 'next', '--json'));
    expect(next.map((t: { meta: { id: string } }) => t.meta.id)).toEqual([
      b.meta.id,
    ]);

    expect(dispatch('doctor')).toContain('ok — 2 tasks checked');

    expect(run(['git', 'status', '--porcelain'])).toContain('.dispatch/');
  }, 30_000);
});
