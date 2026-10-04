import type { TerminalEvent, TerminalRequest } from './terminalHost.js';
// The terminal host: a small helper process that spawns each terminal session's
// child and relays its output and exit over IPC. A pty spawn takes ~200 ms of
// native work; in the daemon it blocked the event loop (and, from a worker,
// stalled every garbage collection), so it runs here instead.
import { spawnInThread } from './terminalSpawn.js';
import type { TerminalProcess } from './terminalSpawn.js';

// Bytes sent but not yet written to the IPC socket. Bun's process.send never
// pushes back, so without this cap a flood queues unbounded in this process.
const MAX_IN_FLIGHT = 256 * 1024;
// One message carries at most this much of one session's output, so a
// flooding session takes turns with the others instead of holding the channel.
const MAX_MESSAGE = 64 * 1024;
// Output a session may hold here before its reader pauses (the pty then
// backs up and the child blocks, as in any terminal).
const MAX_QUEUED = 256 * 1024;
// How long a killed session has after TERM and HUP before SIGKILL.
const KILL_GRACE_MS = 2000;

interface Child {
  proc: TerminalProcess;
  queue: Uint8Array[];
  queued: number;
  // Wakes the reader once the queue has room again.
  resume: (() => void) | null;
}

const children = new Map<string, Child>();
let inFlight = 0;
// Round-robin order of sessions with output waiting.
const ready: string[] = [];

const post = (event: TerminalEvent, done?: () => void): void => {
  process.send?.(event, undefined, undefined, done);
};

// Sends waiting output, one capped message per session in turn, while the
// in-flight budget lasts; each send's callback frees budget and flushes again.
function flush(): void {
  while (inFlight < MAX_IN_FLIGHT && ready.length > 0) {
    const id = ready.shift() ?? '';
    const child = children.get(id);
    if (child === undefined || child.queued === 0) continue;
    const parts: Uint8Array[] = [];
    let size = 0;
    while (child.queue.length > 0 && size < MAX_MESSAGE) {
      const head = child.queue[0];
      const take = Math.min(head.length, MAX_MESSAGE - size);
      parts.push(head.subarray(0, take));
      size += take;
      if (take === head.length) child.queue.shift();
      else child.queue[0] = head.subarray(take);
    }
    child.queued -= size;
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    inFlight += size;
    post({ type: 'data', id, bytes }, () => {
      inFlight -= size;
      flush();
    });
    if (child.queued > 0) ready.push(id);
    if (child.queued < MAX_QUEUED && child.resume !== null) {
      const wake = child.resume;
      child.resume = null;
      wake();
    }
  }
}

// Queues a session's output for flush, pausing its reader while it is full.
async function pump(id: string, child: Child): Promise<void> {
  const reader = child.proc.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (child.queued === 0) ready.push(id);
    child.queue.push(value.slice());
    child.queued += value.length;
    flush();
    if (child.queued >= MAX_QUEUED)
      await new Promise<void>((resolve) => {
        child.resume = resolve;
      });
  }
}

// Waits until every byte a session produced has left this process.
async function drained(child: Child): Promise<void> {
  while (child.queued > 0)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

// TERM and HUP to the session's process group, then SIGKILL after a grace.
function killHard(proc: TerminalProcess): void {
  proc.kill();
  setTimeout(() => proc.forceKill?.(), KILL_GRACE_MS);
}

function handle(req: TerminalRequest): void {
  if (req.type === 'spawn') {
    let proc: TerminalProcess;
    try {
      proc = spawnInThread(req.opts);
    } catch (err) {
      post({
        type: 'error',
        id: req.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const child: Child = { proc, queue: [], queued: 0, resume: null };
    children.set(req.id, child);
    void Promise.all([pump(req.id, child).catch(() => {}), proc.exited])
      .then(async ([, code]) => {
        await drained(child);
        return code;
      })
      .then((code) => {
        children.delete(req.id);
        post({ type: 'exit', id: req.id, code });
      });
    return;
  }
  const child = children.get(req.id);
  if (child === undefined) return;
  if (req.type === 'write') child.proc.write(req.data);
  else if (req.type === 'resize') child.proc.resize?.(req.cols, req.rows);
  else killHard(child.proc);
}

// The daemon is gone or stopping: every session goes, stubborn ones included.
function shutdown(): void {
  for (const child of children.values()) killHard(child.proc);
  setTimeout(() => process.exit(0), KILL_GRACE_MS + 200);
}

process.on('message', (req) => handle(req as TerminalRequest));
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
