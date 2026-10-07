import type {
  BlockingGitRequest,
  BlockingGitResponse,
  BlockingGitWorkerData,
} from './blockingGitShared.js';
import { DONE_SLOT, READY_SLOT } from './blockingGitShared.js';

// spawnGitSync's worker half: runs each git command with the async
// `Bun.spawn` on this thread's own event loop, while the daemon's main thread
// sleeps in Atomics.wait for the answer. See spawnGitSync in blockingGit.ts
// for why the daemon cannot use Bun.spawnSync. Each result is posted on the
// `results` port first and only then announced through DONE_SLOT, so the main
// thread never wakes to an empty port.

// How long to keep reading git's pipes once git itself has exited. Git has
// written everything by then (at most one pipe buffer is left unread), but a
// process it started — a hook's background job, or the `sleep` under a
// SIGKILLed alias — can hold the pipe open indefinitely, and EOF would never
// come.
const DRAIN_AFTER_EXIT_MS = 1_000;

let signal: Int32Array | null = null;
let results: MessagePort | null = null;
const running = new Map<number, Bun.Subprocess>();

async function run(
  request: Extract<BlockingGitRequest, { type: 'run' }>
): Promise<BlockingGitResponse> {
  const child = Bun.spawn(request.cmd, {
    cwd: request.cwd,
    env: request.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  running.set(request.id, child);
  let timedOut = false;
  const timer =
    request.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          // SIGKILL, never SIGTERM: a git stuck behind ssh, or a hook that
          // traps TERM, would outlive a polite signal.
          child.kill('SIGKILL');
        }, request.timeoutMs);
  try {
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const exitCode = await child.exited;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([stdout.done, stderr.done]),
      new Promise((resolve) => {
        drainTimer = setTimeout(resolve, DRAIN_AFTER_EXIT_MS);
      }),
    ]);
    clearTimeout(drainTimer);
    return {
      id: request.id,
      exitCode,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    running.delete(request.id);
  }
}

// Reads a pipe to EOF in the background, so whatever has arrived can be
// taken at any point without waiting for an EOF that may never come.
function collect(stream: ReadableStream<Uint8Array>): {
  done: Promise<void>;
  text: () => string;
} {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) return;
      chunks.push(value);
    }
  })().catch(() => undefined);
  return {
    done,
    text: () => {
      void reader.cancel().catch(() => undefined);
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

function finish(response: BlockingGitResponse): void {
  results?.postMessage(response);
  if (signal === null) return;
  Atomics.store(signal, DONE_SLOT, response.id);
  Atomics.notify(signal, DONE_SLOT);
}

addEventListener('message', (event: MessageEvent) => {
  const data = event.data as BlockingGitRequest | BlockingGitWorkerData;
  if (!('type' in data)) {
    signal = new Int32Array(data.signal);
    results = data.results;
    Atomics.store(signal, READY_SLOT, 1);
    Atomics.notify(signal, READY_SLOT);
    return;
  }
  if (data.type === 'cancel') {
    running.get(data.id)?.kill('SIGKILL');
    return;
  }
  run(data).then(finish, (error: unknown) => {
    // A spawn that throws (cwd gone, git not on PATH) still has to answer, or
    // the main thread would sleep until its backstop.
    finish({
      id: data.id,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: error instanceof Error ? error.message : String(error),
    });
  });
});
