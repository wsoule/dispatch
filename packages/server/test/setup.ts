import { afterAll, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Preloaded before every test file (see bunfig.toml). Runs, worktrees and
// daemon files fall back to the real home when DISPATCH_HOME is unset.
const fallbackHome = mkdtempSync(join(tmpdir(), 'dispatch-fallback-home-'));
process.env.DISPATCH_HOME = fallbackHome;

// Every startServer() here runs on the test's own thread, so its watchdog
// also times the test's synchronous fixture work (git init, worktree setup),
// which under load runs past the 5s production threshold. 30s keeps a real
// hang visible while the fixture's slow stretches stay out of the output.
// Tests that exercise the watchdog itself pass their own threshold.
process.env.DISPATCH_WATCHDOG_STALL_MS = '30000';

// Redirecting alone would only hide the mistake: anything landing here is a
// suite that forgot its own DISPATCH_HOME, so fail the test that wrote it.
afterEach(() => {
  const stray = join(fallbackHome, '.dispatch');
  if (!existsSync(stray)) return;
  const kinds = readdirSync(stray).join(', ');
  // Cleared so only the first offender is blamed, not every test after it.
  rmSync(stray, { recursive: true, force: true });
  throw new Error(
    `dispatch state (${kinds}) reached the shared fallback home, which is the ` +
      'real ~/.dispatch outside the test runner. Set process.env.DISPATCH_HOME ' +
      'to a per-test temp dir in beforeEach and restore it in afterEach. If ' +
      'this test looks innocent, an earlier one let a write escape its teardown.'
  );
});

afterAll(() => {
  rmSync(fallbackHome, { recursive: true, force: true });
});
