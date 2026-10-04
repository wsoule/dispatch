// Spawning a terminal's child: Bun's native pty, or plain pipes. Kept apart
// from the registry so the terminal worker can import it alone.

/** The slice of a spawned child this module uses, so a test can supply its own. */
export interface TerminalProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  write(data: string): void;
  kill(): void;
  /** Resizes the child's pty. Absent when the child has no pty to resize. */
  resize?(cols: number, rows: number): void;
}

export interface SpawnTerminalOptions {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  /** Run `command` directly under a native pty rather than over pipes. */
  pty: boolean;
  cols: number;
  rows: number;
}

export type TerminalSpawner = (opts: SpawnTerminalOptions) => TerminalProcess;

// Spawns on the calling thread; the daemon runs it on the terminal worker.
export function spawnInThread(opts: SpawnTerminalOptions): TerminalProcess {
  return opts.pty ? spawnNativePty(opts) : spawnPiped(opts);
}

// Runs the child on Bun's native pty. The pty delivers output through a
// callback, so it is adapted to the stream the registry pumps; the stream ends
// on the pty's EOF, or once the child exits, whichever comes first.
function spawnNativePty(opts: SpawnTerminalOptions): TerminalProcess {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const stdout = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const end = () => {
    if (ended) return;
    ended = true;
    controller.close();
  };
  const proc = Bun.spawn(opts.command, {
    cwd: opts.cwd,
    env: opts.env,
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      name: 'xterm-256color',
      // Copied: the callback's buffer is not guaranteed to outlive the call.
      data: (_terminal, data) => {
        if (!ended) controller.enqueue(data.slice());
      },
      exit: end,
    },
  });
  const terminal = proc.terminal;
  // A background job can keep the pty open after the shell itself exits, and
  // an open pty keeps the daemon's event loop alive; closing it on exit also
  // flushes the last output before `exited` resolves.
  const exited = proc.exited.then((code) => {
    terminal?.close();
    end();
    return code;
  });
  return {
    stdout,
    exited,
    write(data: string) {
      terminal?.write(data);
    },
    kill() {
      proc.kill();
    },
    resize(cols: number, rows: number) {
      if (terminal !== undefined && !terminal.closed) {
        terminal.resize(cols, rows);
      }
    },
  };
}

// Interleaves two byte streams into one, in arrival order, ending once both
// have. Used to fold stderr into stdout for a child without a pty, where the
// two are separate pipes but a terminal shows them as one.
function mergeStreams(
  a: ReadableStream<Uint8Array>,
  b: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const drain = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          controller.enqueue(value);
        }
      };
      await Promise.allSettled([drain(a), drain(b)]);
      controller.close();
    },
  });
}

// Runs the child over plain pipes: remote sessions (ssh brings its own pty),
// and local ones on a Bun without a native pty.
function spawnPiped(opts: SpawnTerminalOptions): TerminalProcess {
  const proc = Bun.spawn(opts.command, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    // Merged, because an error the child prints is output the person needs
    // to see — dropping stderr hides exactly the message explaining a failure.
    stdout: mergeStreams(proc.stdout, proc.stderr),
    exited: proc.exited,
    write(data: string) {
      // Both return promises that resolve once the bytes reach the pipe.
      // Nothing here can act on that: a keystroke has no reply, and a write
      // that fails because the child just exited is the ordinary race, which
      // `exited` records. Awaiting would only serialize keystrokes behind it.
      void proc.stdin.write(data);
      void proc.stdin.flush();
    },
    kill() {
      proc.kill();
    },
  };
}
