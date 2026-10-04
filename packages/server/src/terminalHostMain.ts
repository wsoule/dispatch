import type { TerminalEvent, TerminalRequest } from './terminalHost.js';
// The terminal host: a small helper process that spawns each terminal session's
// child and relays its output and exit over IPC. A pty spawn takes ~200 ms of
// native work; in the daemon it blocked the event loop (and, from a worker,
// stalled every garbage collection), so it runs here instead.
import { spawnInThread } from './terminalSpawn.js';
import type { TerminalProcess } from './terminalSpawn.js';

const children = new Map<string, TerminalProcess>();
const post = (event: TerminalEvent): void => {
  process.send?.(event);
};

// Copies a session's output to the daemon until the stream ends.
async function pump(id: string, proc: TerminalProcess): Promise<void> {
  const reader = proc.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    post({ type: 'data', id, bytes: value.slice() });
  }
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
    children.set(req.id, proc);
    void Promise.all([pump(req.id, proc).catch(() => {}), proc.exited]).then(
      ([, code]) => {
        children.delete(req.id);
        post({ type: 'exit', id: req.id, code });
      }
    );
    return;
  }
  const proc = children.get(req.id);
  if (proc === undefined) return;
  if (req.type === 'write') proc.write(req.data);
  else if (req.type === 'resize') proc.resize?.(req.cols, req.rows);
  else proc.kill();
}

process.on('message', (req) => handle(req as TerminalRequest));
// The daemon is gone: its sessions go with it.
process.on('disconnect', () => {
  for (const proc of children.values()) proc.kill();
  process.exit(0);
});
