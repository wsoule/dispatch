import type { WatchdogReport, WatchdogWorkerInit } from './watchdogShared.js';
import {
  HEARTBEAT_OFFSET,
  LABEL_BYTES,
  LABEL_LENGTH_OFFSET,
  LABEL_OFFSET,
} from './watchdogShared.js';

// The watchdog's worker half: polls the shared heartbeat and writes to stderr
// while the main thread is stalled. Runs on its own thread, so it keeps
// ticking when the event loop does not — which is the whole point. See
// EventLoopWatchdog for the layout it reads.

// Once a stall is reported, repeat at this cadence so a long stall keeps
// showing up in the log with its growing duration, without flooding it.
const REPEAT_MS = 10_000;

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

// A stall with no label is possible (nothing had marked a section yet), and
// an empty string in the log reads as a bug rather than as an absence.
function describeSection(section: string): string {
  return section === '' ? '(no section marked)' : section;
}

function watch(init: WatchdogWorkerInit): void {
  const heartbeat = new BigInt64Array(init.buffer, HEARTBEAT_OFFSET, 1);
  const labelLength = new Int32Array(init.buffer, LABEL_LENGTH_OFFSET, 1);
  const label = new Uint8Array(init.buffer, LABEL_OFFSET, LABEL_BYTES);
  const decoder = new TextDecoder();

  let stalledSince: number | null = null;
  // Captured when the stall is first seen, not when it ends: by the time the
  // loop is running again it has usually already marked its next section, and
  // the useful name is the one it was stuck in.
  let stalledSection = '';
  let lastReportAt = 0;
  let lastLabel = '';

  const readLabel = (): string => {
    const length = Atomics.load(labelLength, 0);
    // Zero means the main thread is mid-write (or never marked anything);
    // keep the previous reading rather than report an empty section.
    if (length === 0) return lastLabel;
    lastLabel = decoder.decode(label.slice(0, length));
    return lastLabel;
  };

  setInterval(() => {
    const now = Date.now();
    const lastBeat = Number(Atomics.load(heartbeat, 0));
    const age = now - lastBeat;
    if (age > init.thresholdMs) {
      const section = readLabel();
      if (stalledSince === null) {
        stalledSince = lastBeat;
        stalledSection = section;
      }
      if (now - lastReportAt >= REPEAT_MS) {
        lastReportAt = now;
        console.error(
          `dispatchd: event loop stalled ${formatSeconds(age)} in: ${describeSection(stalledSection)}`
        );
      }
      return;
    }
    if (stalledSince !== null) {
      const stalledMs = lastBeat - stalledSince;
      const section = stalledSection;
      console.error(
        `dispatchd: event loop recovered after ${formatSeconds(stalledMs)} (was in: ${describeSection(section)})`
      );
      const report: WatchdogReport = {
        type: 'stall-ended',
        stalledMs,
        section,
      };
      postMessage(report);
      stalledSince = null;
      stalledSection = '';
      lastReportAt = 0;
    }
  }, init.checkMs);
}

addEventListener('message', (event: MessageEvent) => {
  watch(event.data as WatchdogWorkerInit);
});
