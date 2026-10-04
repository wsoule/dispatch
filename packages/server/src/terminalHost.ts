import type { Subprocess } from 'bun';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { spawnInThread } from './terminalSpawn.js';
import type {
  SpawnTerminalOptions,
  TerminalProcess,
  TerminalSpawner,
} from './terminalSpawn.js';

// What the daemon asks the terminal host, and what it hears back.
export type TerminalRequest =
  | { type: 'spawn'; id: string; opts: SpawnTerminalOptions }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string };
export type TerminalEvent =
  | { type: 'data'; id: string; bytes: Uint8Array }
  | { type: 'exit'; id: string; code: number }
  | { type: 'error'; id: string; message: string };

// A compiled binary serves its modules from Bun's embedded filesystem.
const EMBEDDED_ROOT = '/$' + 'bun' + 'fs/';

// How to start the host: this same binary with a flag when compiled (see
// bin.ts), else Bun on the host module beside this one.
function hostCommand(): string[] {
  if (import.meta.url.includes(EMBEDDED_ROOT))
    return [process.execPath, '--terminal-host'];
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return [
    process.execPath,
    fileURLToPath(new URL(`./terminalHostMain.${extension}`, import.meta.url)),
  ];
}

interface Pending {
  controller: ReadableStreamDefaultController<Uint8Array>;
  exit: (code: number) => void;
}

/** A spawner whose children run in the terminal host process, plus `close`. */
export interface HostSpawner {
  spawn: TerminalSpawner;
  /** Stops the host and every session in it. */
  close(): void;
}

/**
 * Runs every terminal child in one shared helper process, started on the first
 * spawn, so a pty spawn never blocks the daemon. If the host cannot start, the
 * child spawns on the main thread as before.
 */
export function hostSpawner(): HostSpawner {
  let host: Subprocess | null = null;
  const pending = new Map<string, Pending>();

  const settle = (id: string, code: number, text?: string): void => {
    const p = pending.get(id);
    if (p === undefined) return;
    pending.delete(id);
    if (text !== undefined)
      p.controller.enqueue(new TextEncoder().encode(text));
    p.controller.close();
    p.exit(code);
  };

  const start = (): Subprocess => {
    if (host !== null) return host;
    const started = Bun.spawn(hostCommand(), {
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      serialization: 'advanced',
      ipc: (message) => {
        const e = message as TerminalEvent;
        if (e.type === 'data') pending.get(e.id)?.controller.enqueue(e.bytes);
        else if (e.type === 'exit') settle(e.id, e.code);
        else settle(e.id, 127, `${e.message}\r\n`);
      },
    });
    started.unref();
    host = started;
    void started.exited.then(() => {
      if (host === started) host = null;
      for (const id of [...pending.keys()])
        settle(id, 1, 'the terminal host stopped\r\n');
    });
    return started;
  };

  const spawn = (opts: SpawnTerminalOptions): TerminalProcess => {
    let proc: Subprocess;
    try {
      proc = start();
    } catch {
      return spawnInThread(opts);
    }
    const id = randomUUID();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    const exited = new Promise<number>((resolve) => {
      pending.set(id, { controller, exit: resolve });
    });
    const send = (req: TerminalRequest): void => {
      if (pending.has(id)) proc.send(req);
    };
    proc.send({ type: 'spawn', id, opts } satisfies TerminalRequest);
    return {
      stdout,
      exited,
      write: (data) => send({ type: 'write', id, data }),
      kill: () => send({ type: 'kill', id }),
      ...(opts.pty
        ? {
            resize: (cols: number, rows: number) =>
              send({ type: 'resize', id, cols, rows }),
          }
        : {}),
    };
  };

  return {
    spawn,
    close: () => {
      host?.kill();
      host = null;
    },
  };
}
