import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

// A watchdog that outlives its server keeps reporting: every multi-second
// synchronous stretch anywhere in the same process becomes a "stalled in:
// git config user.name" line for a server that has been gone for minutes.
// The suite runs 45 servers' worth of boots in one process, so one leak (a
// boot that rejected after arming its watchdog) was enough to print sixteen
// false stalls per run and train readers to ignore the real one.
//
// The lines come from a worker thread's stderr, so each scenario runs in a
// subprocess and the assertion is on what that process actually wrote.
const FIXTURE = resolve(import.meta.dirname, 'fixtures/watchdogTeardown.ts');

async function runScenario(
  scenario: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn({
    cmd: ['bun', FIXTURE, scenario],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('watchdog teardown', () => {
  it('a stopped server logs no stall for a block that comes after it', async () => {
    const result = await runScenario('stopped');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('scenario complete');
    expect(result.stderr).not.toContain('event loop stalled');
  }, 30_000);

  it('a boot that rejects after arming its watchdog takes it down too', async () => {
    const result = await runScenario('boot-failed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('scenario complete');
    expect(result.stderr).not.toContain('event loop stalled');
  }, 30_000);

  // Without this the two above could pass against a harness that never
  // captures the worker's stderr at all.
  it('still reports a stall while the server is running', async () => {
    const result = await runScenario('running');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('event loop stalled');
  }, 30_000);
});
