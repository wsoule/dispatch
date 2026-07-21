import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDaemon } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Counts how many `bin.ts --root <root>` processes are currently alive —
// `pgrep -f` matches against the full command line, and `--root <root>` is
// unique enough (root is a freshly mkdtemp'd path) that this can't collide
// with anything else running on the machine. `execFileSync` (an argument
// array, no shell) rather than a shell string — `root` is a real filesystem
// path here, not attacker-controlled, but there's no reason to interpolate
// it into a shell command when execFileSync avoids that entirely.
function countDaemonProcesses(root: string): number {
  try {
    const out = execFileSync('pgrep', ['-f', `bin.ts --root ${root}`], {
      encoding: 'utf8',
    });
    return out.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    // pgrep exits non-zero (and throws under execFileSync) when nothing matches.
    return 0;
  }
}

let root: string;
let dispatchHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-race-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  mkdirSync(join(root, '.dispatch', 'tasks'), { recursive: true });
  dispatchHome = mkdtempSync(join(tmpdir(), 'dispatch-race-home-'));
  process.env.DISPATCH_HOME = dispatchHome;
});

afterEach(() => {
  try {
    execFileSync('pkill', ['-9', '-f', `bin.ts --root ${root}`]);
  } catch {
    // Nothing left to kill.
  }
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(dispatchHome, { recursive: true, force: true });
});

describe('ensureDaemon race (I3)', () => {
  it('two concurrent ensureDaemon calls for the same project leave exactly one dispatchd process alive', async () => {
    const ctx: CliContext = { cwd: root, log: () => {} };

    // Both calls see "no daemon file yet" at essentially the same instant
    // (readDaemonFile is synchronous, called before either awaits
    // isHealthy) and so both spawn their own dispatchd for the same
    // rootDir/DISPATCH_HOME — the actual race this test exercises.
    const [a, b] = await Promise.all([ensureDaemon(ctx), ensureDaemon(ctx)]);

    // Both callers must agree on which daemon actually won — otherwise one
    // of them is talking to a process nothing else knows about.
    expect(a.port).toBe(b.port);

    // Give a SIGKILL'd loser a moment to actually disappear from `ps`.
    await sleep(1000);

    expect(countDaemonProcesses(root)).toBe(1);
  }, 20_000);
});
