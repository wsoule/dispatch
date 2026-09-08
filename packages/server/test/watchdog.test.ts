import { afterEach, describe, expect, it } from 'bun:test';

import type { StallReport } from '../src/watchdog.js';
import { EventLoopWatchdog, markBlockingSection } from '../src/watchdog.js';

// Holds the event loop hostage for `ms` — the exact shape the watchdog exists
// to catch (a spawnSync that never returns, a hot loop), minus the mystery.
function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

let watchdog: EventLoopWatchdog | null = null;

afterEach(() => {
  watchdog?.stop();
  watchdog = null;
});

describe('EventLoopWatchdog', () => {
  it('reports a stall longer than the threshold, naming the section it was in', async () => {
    const reports: StallReport[] = [];
    watchdog = new EventLoopWatchdog({
      thresholdMs: 150,
      heartbeatMs: 20,
      checkMs: 20,
      onStall: (report) => reports.push(report),
    });
    watchdog.start();
    // Let the worker boot and see a healthy heartbeat first, so the stall
    // below is a transition it observes rather than a state it started in.
    await tick();
    await tick();

    watchdog.mark('git pull --rebase origin main (cwd /tmp/board)');
    blockEventLoop(400);
    await tick();
    await tick();

    expect(reports.length).toBeGreaterThanOrEqual(1);
    const report = reports[0];
    expect(report.stalledMs).toBeGreaterThanOrEqual(150);
    expect(report.stalledMs).toBeLessThan(5000);
    expect(report.section).toBe(
      'git pull --rebase origin main (cwd /tmp/board)'
    );
  });

  it('stays silent while the loop keeps ticking', async () => {
    const reports: StallReport[] = [];
    watchdog = new EventLoopWatchdog({
      thresholdMs: 150,
      heartbeatMs: 20,
      checkMs: 20,
      onStall: (report) => reports.push(report),
    });
    watchdog.start();
    for (let i = 0; i < 6; i++) await tick();
    expect(reports).toEqual([]);
  });

  it('routes markBlockingSection to the running instance and truncates long labels', async () => {
    const reports: StallReport[] = [];
    watchdog = new EventLoopWatchdog({
      thresholdMs: 150,
      heartbeatMs: 20,
      checkMs: 20,
      onStall: (report) => reports.push(report),
    });
    watchdog.start();
    await tick();
    await tick();

    markBlockingSection(`git commit -m ${'x'.repeat(1000)}`);
    blockEventLoop(400);
    await tick();
    await tick();

    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].section.startsWith('git commit -m xxx')).toBe(true);
    expect(reports[0].section.length).toBeLessThan(300);
  });

  // The daemon marks a new section as soon as it is running again (the very
  // next request or tick), so a report that read the label at recovery time
  // would name the section that was fine rather than the one that hung.
  it('names the section the loop was stuck in, not the one entered after it', async () => {
    const reports: StallReport[] = [];
    watchdog = new EventLoopWatchdog({
      thresholdMs: 150,
      heartbeatMs: 20,
      checkMs: 20,
      onStall: (report) => reports.push(report),
    });
    watchdog.start();
    await tick();
    await tick();

    watchdog.mark('git push origin HEAD:main (cwd /tmp/board)');
    blockEventLoop(400);
    watchdog.mark('GET /api/health');
    await tick();
    await tick();

    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].section).toBe(
      'git push origin HEAD:main (cwd /tmp/board)'
    );
  });

  it('reports nothing once stopped', async () => {
    const reports: StallReport[] = [];
    watchdog = new EventLoopWatchdog({
      thresholdMs: 150,
      heartbeatMs: 20,
      checkMs: 20,
      onStall: (report) => reports.push(report),
    });
    watchdog.start();
    await tick();
    watchdog.stop();

    blockEventLoop(400);
    await tick();
    await tick();
    expect(reports).toEqual([]);
  });
});
