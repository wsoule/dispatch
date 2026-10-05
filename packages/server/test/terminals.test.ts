import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HostSpawner } from '../src/terminalHost.js';
import { hostSpawner } from '../src/terminalHost.js';
import type {
  SpawnTerminalOptions,
  TerminalProcess,
} from '../src/terminals.js';
import {
  nativePtyAvailable,
  ptyCommand,
  shellQuote,
  TerminalRegistry,
} from '../src/terminals.js';

// A stand-in child whose output and exit the test drives by hand, so none of
// these assertions depend on a real shell's timing or on a pty existing.
class FakeProcess implements TerminalProcess {
  readonly written: string[] = [];
  readonly resized: [number, number][] = [];
  killed = false;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  private push!: (chunk: Uint8Array) => void;
  private finish!: () => void;
  private settle!: (code: number) => void;

  constructor(readonly opts: SpawnTerminalOptions) {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.push = (chunk) => controller.enqueue(chunk);
        this.finish = () => controller.close();
      },
    });
    this.exited = new Promise<number>((resolve) => {
      this.settle = resolve;
    });
  }

  emit(text: string): void {
    this.push(new TextEncoder().encode(text));
  }

  exit(code: number): void {
    this.finish();
    this.settle(code);
  }

  write(data: string): void {
    this.written.push(data);
  }

  kill(): void {
    this.killed = true;
  }

  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }
}

let home: string;
let root: string;
const originalHome = process.env.DISPATCH_HOME;

// The registry appends output from a stream reader, so an assertion has to let
// the microtask queue drain before it looks at the scrollback.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// Total bytes of everything under `dir`, so a test can assert that nothing
// was written without caring which file would have grown.
function totalBytesUnder(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? totalBytesUnder(full) : statSync(full).size;
  }
  return total;
}

function decode(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-terminals-home-'));
  process.env.DISPATCH_HOME = home;
  root = mkdtempSync(join(tmpdir(), 'dispatch-terminals-root-'));
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('shellQuote', () => {
  it('wraps a plain word so a shell sees exactly it', () => {
    expect(shellQuote('bash')).toBe("'bash'");
  });

  it('survives embedded single quotes', () => {
    // The `'\\''` dance: close the quote, emit an escaped quote, reopen. A
    // naive backslash escape would not survive, because a shell treats every
    // byte inside single quotes literally, backslashes included.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('round-trips through a real shell', () => {
    // The property that actually matters: whatever goes in comes back out as
    // one argument, byte for byte.
    const awkward = `a b'c"d $e \\f`;
    const result = Bun.spawnSync([
      'sh',
      '-c',
      `printf %s ${shellQuote(awkward)}`,
    ]);
    expect(result.stdout.toString()).toBe(awkward);
  });

  it('keeps spaces and dollar signs literal', () => {
    expect(shellQuote('echo $HOME now')).toBe("'echo $HOME now'");
  });
});

describe('ptyCommand', () => {
  it('uses the util-linux argument order on Linux', () => {
    const result = ptyCommand(['bash', '-l'], {
      os: 'linux',
      whichScript: () => '/usr/bin/script',
    });
    expect(result.pty).toBe(true);
    expect(result.command).toEqual([
      'script',
      '-qfec',
      "'bash' '-l'",
      '/dev/null',
    ]);
  });

  it('never uses BSD script on macOS, which cannot run under Bun’s piped stdin', () => {
    const result = ptyCommand(['bash', '-l'], {
      os: 'darwin',
      whichScript: () => '/usr/bin/script',
    });
    expect(result.pty).toBe(false);
    expect(result.command).toEqual(['bash', '-l']);
  });

  it('falls back to running the command directly when script is missing', () => {
    const result = ptyCommand(['bash'], {
      os: 'linux',
      whichScript: () => null,
    });
    expect(result.pty).toBe(false);
    expect(result.command).toEqual(['bash']);
  });
});

describe('TerminalRegistry', () => {
  let spawned: FakeProcess[];
  let registry: TerminalRegistry;

  function build(maxScrollbackBytes?: number): TerminalRegistry {
    spawned = [];
    return new TerminalRegistry(root, {
      spawn: (opts) => {
        const proc = new FakeProcess(opts);
        spawned.push(proc);
        return proc;
      },
      ...(maxScrollbackBytes === undefined ? {} : { maxScrollbackBytes }),
    });
  }

  beforeEach(() => {
    registry = build();
  });

  afterEach(() => {
    registry.shutdown();
  });

  it('starts a session in the project root and reports it as running', () => {
    const info = registry.create({ cwd: root, command: ['bash'] });
    expect(info.state).toBe('running');
    expect(info.cwd).toBe(root);
    expect(info.command).toEqual(['bash']);
    expect(registry.list().map((t) => t.id)).toEqual([info.id]);
    expect(spawned[0]?.opts.cwd).toBe(root);
  });

  it('passes the viewport through the environment so programs can read it', () => {
    registry.create({ cwd: root, command: ['bash'], cols: 100, rows: 40 });
    expect(spawned[0]?.opts.env.COLUMNS).toBe('100');
    expect(spawned[0]?.opts.env.LINES).toBe('40');
    expect(spawned[0]?.opts.env.TERM).toBe('xterm-256color');
  });

  it('serves output from a byte cursor and advances it', async () => {
    const info = registry.create({ cwd: root, command: ['bash'] });
    spawned[0]?.emit('hello ');
    spawned[0]?.emit('world');
    await settle();

    const all = registry.read(info.id, 0);
    expect(decode(all?.data ?? '')).toBe('hello world');
    expect(all?.total).toBe(11);

    // Resuming from where the last read ended returns only what is new.
    const rest = registry.read(info.id, 6);
    expect(decode(rest?.data ?? '')).toBe('world');
    expect(rest?.since).toBe(6);
  });

  it('returns nothing when the cursor is already at the end', async () => {
    const info = registry.create({ cwd: root, command: ['bash'] });
    spawned[0]?.emit('done');
    await settle();
    const caught = registry.read(info.id, 4);
    expect(decode(caught?.data ?? '')).toBe('');
    expect(caught?.total).toBe(4);
  });

  it('drops the oldest bytes past the cap and says how many are gone', async () => {
    registry.shutdown();
    registry = build(8);
    const info = registry.create({ cwd: root, command: ['bash'] });
    spawned[0]?.emit('0123456789');
    await settle();

    const read = registry.read(info.id, 0);
    // Ten bytes produced, eight kept: the cursor is corrected forward rather
    // than serving a gap the caller would never notice.
    expect(read?.total).toBe(10);
    expect(read?.trimmed).toBe(2);
    expect(read?.since).toBe(2);
    expect(decode(read?.data ?? '')).toBe('23456789');
  });

  it('forwards keystrokes to the child', () => {
    const info = registry.create({ cwd: root, command: ['bash'] });
    expect(registry.write(info.id, 'ls\r')).toBe(true);
    expect(spawned[0]?.written).toEqual(['ls\r']);
  });

  it('refuses to write to a session whose process has exited', async () => {
    const info = registry.create({ cwd: root, command: ['bash'] });
    spawned[0]?.exit(0);
    await settle();
    expect(registry.get(info.id)?.state).toBe('exited');
    expect(registry.get(info.id)?.exitCode).toBe(0);
    expect(registry.write(info.id, 'ls\r')).toBe(false);
  });

  it('records a resize and applies it to the child’s pty', () => {
    const info = registry.create({
      cwd: root,
      command: ['bash'],
      cols: 80,
      rows: 24,
    });
    expect(spawned[0]?.opts).toMatchObject({ cols: 80, rows: 24 });
    expect(registry.resize(info.id, 200, 50)).toBe(true);
    expect(registry.get(info.id)?.cols).toBe(200);
    expect(registry.get(info.id)?.rows).toBe(50);
    expect(spawned[0]?.resized).toEqual([[200, 50]]);
  });

  it('keeps scrollback readable after close, and drops it on remove', async () => {
    const info = registry.create({ cwd: root, command: ['bash'] });
    spawned[0]?.emit('output');
    await settle();

    registry.close(info.id);
    expect(spawned[0]?.killed).toBe(true);
    expect(decode(registry.read(info.id, 0)?.data ?? '')).toBe('output');

    registry.remove(info.id);
    expect(registry.get(info.id)).toBeNull();
    expect(registry.read(info.id, 0)).toBeNull();
  });

  it('reports unknown ids rather than inventing a session', () => {
    expect(registry.get('nope')).toBeNull();
    expect(registry.read('nope', 0)).toBeNull();
    expect(registry.write('nope', 'x')).toBe(false);
    expect(registry.resize('nope', 10, 10)).toBe(false);
    expect(registry.close('nope')).toBe(false);
    expect(registry.remove('nope')).toBe(false);
  });

  it('leaves no directory behind when no session was ever opened', () => {
    // `shutdown` runs on every daemon stop, so a project where nobody opened a
    // terminal must not get a state directory created for it.
    const local = new TerminalRegistry(root, {
      spawn: () =>
        new FakeProcess({
          command: [],
          cwd: root,
          env: {},
          pty: false,
          cols: 80,
          rows: 24,
        }),
    });
    local.shutdown();
    expect(existsSync(join(home, '.dispatch'))).toBe(false);
  });

  it('writes nothing once it has been shut down', async () => {
    // Output buffered in a killed child's pipe still arrives after the kill.
    // Re-arming the debounced flush from there would persist after the daemon
    // had already finished stopping.
    const local = build();
    const info = local.create({ cwd: root, command: ['bash'] });
    spawned[0]?.emit('before shutdown');
    await settle();
    local.shutdown();

    const log = join(home, '.dispatch', 'runs');
    const sizeAfterShutdown = totalBytesUnder(log);
    spawned[0]?.emit('late output after the kill');
    await settle();
    // Past the persist debounce, so a re-armed timer would have fired by now.
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(totalBytesUnder(log)).toBe(sizeAfterShutdown);
    expect(decode(local.read(info.id, 0)?.data ?? '')).toContain(
      'before shutdown'
    );
  });

  it('records an emptied index rather than silently keeping the last session', () => {
    const local = build();
    const info = local.create({ cwd: root, command: ['bash'] });
    local.remove(info.id);
    local.shutdown();

    // Once an index exists it keeps being written, so a revived registry sees
    // the removal rather than resurrecting the session.
    const revived = build();
    expect(revived.get(info.id)).toBeNull();
    revived.shutdown();
    local.shutdown();
  });

  it('reports a command that is not on PATH instead of throwing', () => {
    // A missing binary — `ssh` for a remote session, a shell that was
    // uninstalled — must leave a visible session saying so, not fail the
    // request with nothing to look at.
    const local = new TerminalRegistry(root, {
      spawn: () => {
        throw new Error('Executable not found in $PATH: "ssh"');
      },
    });
    const info = local.create({ cwd: root, command: ['ssh', 'nowhere'] });
    expect(info.state).toBe('exited');
    expect(info.exitCode).toBe(127);
    expect(decode(local.read(info.id, 0)?.data ?? '')).toContain(
      'Executable not found'
    );
    expect(local.write(info.id, 'x')).toBe(false);
    local.shutdown();
  });

  it('hydrates a previous daemon as orphaned with its scrollback intact', async () => {
    const info = registry.create({
      cwd: root,
      command: ['bash'],
      title: 'build',
    });
    spawned[0]?.emit('compiling...');
    await settle();
    registry.shutdown();

    // A second registry over the same DISPATCH_HOME is what a daemon restart
    // looks like from here.
    const revived = build();
    const found = revived.get(info.id);
    expect(found?.state).toBe('orphaned');
    expect(found?.title).toBe('build');
    expect(decode(revived.read(info.id, 0)?.data ?? '')).toBe('compiling...');
    // Nothing is on the other end of an orphan's stdin.
    expect(revived.write(info.id, 'x')).toBe(false);
    registry = revived;
  });

  it('does not wrap a remote command in a second pty', () => {
    // A remote command is `ssh -tt …`, which already has a pty on the far
    // side. Nesting `script` around it would double every echo.
    const info = registry.create({
      cwd: root,
      command: ['ssh', '-tt', 'box', 'exec $SHELL -l'],
      remote: 'box',
    });
    expect(info.remote).toBe('box');
    expect(info.pty).toBe(true);
    expect(spawned[0]?.opts.command[0]).toBe('ssh');
    expect(spawned[0]?.opts.command).not.toContain('script');
    expect(spawned[0]?.opts.pty).toBe(false);
  });

  it('runs a local command unwrapped on the native pty', () => {
    const local = new TerminalRegistry(root, {
      spawn: (opts) => {
        const proc = new FakeProcess(opts);
        spawned.push(proc);
        return proc;
      },
      nativePty: true,
    });
    const before = spawned.length;
    local.create({ cwd: root, command: ['bash', '-l'] });
    expect(spawned[before]?.opts.command).toEqual(['bash', '-l']);
    expect(spawned[before]?.opts.pty).toBe(true);
    local.shutdown();
  });

  it('announces output and exit to the daemon', async () => {
    const outputs: string[] = [];
    const exits: string[] = [];
    const local = new TerminalRegistry(root, {
      spawn: (opts) => {
        const proc = new FakeProcess(opts);
        spawned.push(proc);
        return proc;
      },
      onOutput: (id) => outputs.push(id),
      onExit: (id) => exits.push(id),
    });
    const before = spawned.length;
    const info = local.create({ cwd: root, command: ['bash'] });
    spawned[before]?.emit('tick');
    await settle();
    expect(outputs).toEqual([info.id]);
    spawned[before]?.exit(3);
    await settle();
    expect(exits).toEqual([info.id]);
    local.shutdown();
  });
});

// The pty path, against real processes rather than the fake above. This is the
// claim worth proving directly: a child behind a plain pipe reports "not a
// tty", and everything a terminal is for follows from it not saying that.
describe('TerminalRegistry with a real process', () => {
  let registry: TerminalRegistry;
  // Counts pty spawns made in this process: they belong in the terminal host.
  let ptySpawns = 0;
  let spawnSpy: ReturnType<typeof spyOn<typeof Bun, 'spawn'>>;
  // One terminal host for the block, as the daemon has, so a pty spawn can
  // never block this thread.
  let host: HostSpawner;

  beforeAll(() => {
    const original = Bun.spawn;
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((
      ...args: Parameters<typeof Bun.spawn>
    ) => {
      const opts = (typeof args[1] === 'object' ? args[1] : args[0]) as {
        terminal?: unknown;
      };
      if (opts.terminal !== undefined) ptySpawns++;
      return original(...(args as [never]));
    }) as typeof Bun.spawn);
    host = hostSpawner();
  });

  afterAll(() => {
    host.close();
    spawnSpy.mockRestore();
  });

  beforeEach(() => {
    registry = new TerminalRegistry(root, { spawn: host.spawn });
  });

  afterEach(() => {
    registry.shutdown();
  });

  // Polls until the session exits, so the assertion never races the child.
  async function waitForExit(id: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
      if (registry.get(id)?.state === 'exited') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // One more beat: `exited` resolves before the last read of stdout lands.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return decode(registry.read(id, 0)?.data ?? '');
  }

  function runToExit(command: string[]): Promise<string> {
    return waitForExit(registry.create({ cwd: root, command }).id);
  }

  it('captures a real command’s output', async () => {
    expect(
      await runToExit(['sh', '-c', 'echo hello-from-a-terminal'])
    ).toContain('hello-from-a-terminal');
  });

  it('gives the child a tty', async () => {
    if (!nativePtyAvailable()) return;
    // `test -t` is the direct question: are stdin and stdout a terminal?
    expect(
      await runToExit([
        'sh',
        '-c',
        'test -t 0 && test -t 1 && echo IS_TTY || echo NO_TTY',
      ])
    ).toContain('IS_TTY');
  });

  it('starts the pty at the requested size and resizes it live', async () => {
    if (!nativePtyAvailable()) return;
    // `stty size` asks the pty itself, not the COLUMNS/LINES env.
    const info = registry.create({
      cwd: root,
      command: ['sh', '-c', 'stty size; sleep 0.4; stty size'],
      cols: 100,
      rows: 30,
    });
    // Resize only once the child has printed its starting size.
    for (let i = 0; i < 200; i++) {
      if (decode(registry.read(info.id, 0)?.data ?? '').includes('30 100'))
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    registry.resize(info.id, 132, 40);
    const output = await waitForExit(info.id);
    expect(output).toContain('30 100');
    expect(output).toContain('40 132');
  });

  it('feeds keystrokes to the child', async () => {
    if (!nativePtyAvailable()) return;
    const info = registry.create({
      cwd: root,
      command: ['sh', '-c', 'read line; echo got:$line'],
    });
    registry.write(info.id, 'typed\r');
    expect(await waitForExit(info.id)).toContain('got:typed');
  });

  it('shows what the child writes to stderr when it runs without a pty', async () => {
    registry.shutdown();
    registry = new TerminalRegistry(root, {
      spawn: host.spawn,
      nativePty: false,
    });
    expect(
      await runToExit(['sh', '-c', 'echo to-stderr >&2; exit 1'])
    ).toContain('to-stderr');
  });

  it('records a real exit code', async () => {
    const info = registry.create({
      cwd: root,
      command: ['sh', '-c', 'exit 7'],
    });
    for (let i = 0; i < 200; i++) {
      if (registry.get(info.id)?.state === 'exited') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(registry.get(info.id)?.state).toBe('exited');
    expect(registry.get(info.id)?.exitCode).toBe(7);
  });

  it('spawns no pty in the test process', () => {
    expect(ptySpawns).toBe(0);
  });
});
