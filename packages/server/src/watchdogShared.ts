// Layout of the SharedArrayBuffer the watchdog's main thread and worker share.
// Kept in its own module so the worker entry imports no daemon code.
//
//   [0, 8)    BigInt64  Date.now() at the main thread's last heartbeat
//   [8, 12)   Int32     byte length of the current label (0 while rewriting)
//   [16, 272) UTF-8     the label itself — the last blocking section entered
export const HEARTBEAT_OFFSET = 0;
export const LABEL_LENGTH_OFFSET = 8;
export const LABEL_OFFSET = 16;
export const LABEL_BYTES = 256;
export const SHARED_BUFFER_BYTES = LABEL_OFFSET + LABEL_BYTES;

export interface WatchdogWorkerInit {
  buffer: SharedArrayBuffer;
  thresholdMs: number;
  checkMs: number;
}

export type WatchdogReport = {
  type: 'stall-ended';
  stalledMs: number;
  section: string;
};
