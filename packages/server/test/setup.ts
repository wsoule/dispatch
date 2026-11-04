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

// No daemon here links to a machine hub unless its test asks for one
// (startServer's hubLink option): the link changes how mail is stamped.
process.env.DISPATCH_HUB = '0';

// The daemon defaults to the database now, but most of this suite drives an
// in-process daemon through the markdown files it writes into a fixture
// board — the files backend, still supported as the explicit escape hatch.
// Pinning it here keeps that coverage honest; the sqlite path has its own
// tests, which pass `storeBackend` or manage this variable themselves.
process.env.DISPATCH_STORE_BACKEND = 'files';

// The suite starts hundreds of in-process daemons, and each narrates its boot
// and requests on console.log ("dispatchd: board sync on as ...", "dispatchd:
// the task merge driver ... is not resolvable on PATH ...", the files-to-
// database import table): thousands of lines in CI that push Bun's own report
// of a failing test out of the last 5,000 lines GitHub's log API returns for
// the job, so a CI failure could not be named. Those informational lines are
// dropped. console.error and every other console.log line still print; a test
// that spies on console.log still sees every call (spyOn replaces this
// wrapper for that test); DISPATCH_TEST_LOGS=1 prints everything.
const DAEMON_CHATTER =
  /^(dispatchd: |a2a: |Imported into the dispatch database)/;
if (process.env.DISPATCH_TEST_LOGS !== '1') {
  const print = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && DAEMON_CHATTER.test(first)) return;
    print(...args);
  };
}

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
