import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

import { terminalScrollbackPath, terminalsDir } from './orchestrator/paths.js';
import { spawnInThread } from './terminalSpawn.js';
import type { TerminalProcess, TerminalSpawner } from './terminalSpawn.js';

export type {
  SpawnTerminalOptions,
  TerminalProcess,
  TerminalSpawner,
} from './terminalSpawn.js';

/**
 * Long-lived shell sessions the desktop app attaches to — one per repo or run
 * worktree, split any number of ways in the UI.
 *
 * Two things make this more than "spawn a shell and pipe it":
 *
 *   - The child runs under a real pty (Bun's native one, see
 *     `spawnInThread`, run on the terminal worker), so a prompt, colour, and any curses program behave
 *     the way they do in a terminal emulator rather than the line-buffered,
 *     colorless way they behave behind a pipe.
 *   - Scrollback is kept on disk, so closing the app — or restarting the
 *     daemon — does not lose what a session printed. A reader resumes from a
 *     byte cursor rather than a message index, which means a client that was
 *     offline for a minute catches up in one request.
 */

// How much output one session keeps. Past this the oldest bytes are dropped;
// `trimmed` below tells a reader how much it can never see, so a cursor that
// has fallen behind is corrected rather than silently serving a gap.
const SCROLLBACK_MAX_BYTES = 2 * 1024 * 1024;

// Written to disk at most this often while a session is chatty. A session that
// exits, or a daemon that shuts down cleanly, flushes immediately regardless.
const PERSIST_DEBOUNCE_MS = 750;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/**
 * Where a session is in its life.
 *
 * `orphaned` is the one that only exists because scrollback outlives the
 * process: it marks a session this daemon inherited from a previous run of
 * itself. Its output is still readable, but nothing is on the other end of its
 * stdin, so `write` on it fails rather than appearing to work.
 */
type TerminalState = 'running' | 'exited' | 'orphaned';

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  command: string[];
  cols: number;
  rows: number;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  state: TerminalState;
  /** Whether the child got a real pty, or fell back to plain pipes. */
  pty: boolean;
  /** Total bytes this session has ever produced — the end of the cursor range. */
  total: number;
  /** Bytes dropped off the front of scrollback; the start of the cursor range. */
  trimmed: number;
  /** The run this session belongs to, when it was opened on a run's worktree. */
  runId: string | null;
  /** The configured remote this session runs on, or null for this machine. */
  remote: string | null;
}

export interface TerminalReadResult {
  id: string;
  /** The cursor this read actually started at, clamped up past `trimmed`. */
  since: number;
  total: number;
  trimmed: number;
  /** Base64, because a chunk can split a multi-byte sequence or carry control bytes. */
  data: string;
  state: TerminalState;
  exitCode: number | null;
}

export interface CreateTerminalSpec {
  cwd: string;
  /** Defaults to the user's login shell. */
  command?: string[];
  title?: string;
  cols?: number;
  rows?: number;
  runId?: string | null;
  env?: Record<string, string>;
  /**
   * The remote this session runs on, or null for this machine.
   *
   * A remote session's `command` is already a full `ssh -tt …` invocation, and
   * ssh allocates the pty on the far side — so it runs over plain pipes here
   * rather than getting a second, local pty.
   */
  remote?: string | null;
}

// What gets written to `sessions.json`: the info rows, without any of the
// live process state, so a restart can list what came before.
interface PersistedSessions {
  sessions: TerminalInfo[];
}

/**
 * Quotes one argument for a POSIX shell, so a command with spaces or quotes in
 * it survives being handed to `script -c` as a single string.
 *
 * Single quotes with the `'\''` escape rather than backslashes: inside single
 * quotes a shell treats every byte literally, which is the only form that is
 * safe for arbitrary content including newlines and `$`.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Bun's native pty (`Bun.spawn({ terminal })`), which is POSIX-only. Where it
 * exists it is used for every local session: it is a real pty that can be
 * resized, with no wrapper process in between.
 */
export function nativePtyAvailable(): boolean {
  return platform() !== 'win32' && typeof Bun.Terminal === 'function';
}

/**
 * The fallback for a Bun without a native pty: wraps `command` in util-linux
 * `script -qfec <command-string> /dev/null`, or returns it unchanged to run
 * over plain pipes.
 *
 * BSD `script` (macOS) is deliberately not used. It calls `tcgetattr` on its
 * stdin, and Bun's piped stdin is a socket, so it fails with "Operation not
 * supported on socket" and exits before running anything.
 *
 * `whichScript` is injected so a test can force the lookup either way.
 */
export function ptyCommand(
  command: string[],
  opts: { os?: string; whichScript?: (name: string) => string | null } = {}
): { command: string[]; pty: boolean } {
  const which = opts.whichScript ?? ((name: string) => Bun.which(name));
  const os = opts.os ?? platform();
  if (os !== 'linux' || which('script') === null) {
    return { command, pty: false };
  }
  const joined = command.map(shellQuote).join(' ');
  return { command: ['script', '-qfec', joined, '/dev/null'], pty: true };
}

// The shell a session runs when the caller names no command. `$SHELL` is what
// the person actually uses; the fallback is the one shell POSIX guarantees.
function defaultShell(env: Record<string, string | undefined>): string[] {
  const shell = env.SHELL;
  return [shell !== undefined && shell !== '' ? shell : '/bin/sh'];
}

// One session's live state: the row clients see, plus the buffer and process
// that only exist while this daemon is the one running it.
interface Session {
  info: TerminalInfo;
  // The tail of the output, capped at SCROLLBACK_MAX_BYTES. `info.trimmed` is
  // kept as `info.total - buffer.length`, so a cursor stays absolute even
  // though the buffer is not.
  buffer: Buffer;
  proc: TerminalProcess | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
}

export interface TerminalRegistryOptions {
  spawn?: TerminalSpawner;
  maxScrollbackBytes?: number;
  now?: () => Date;
  /** Called after output lands, so the daemon can nudge attached clients. */
  onOutput?: (id: string) => void;
  /** Called when a session exits on its own. */
  onExit?: (id: string) => void;
  /** Overrides native pty detection, so a test can force either path. */
  nativePty?: boolean;
}

export class TerminalRegistry {
  private readonly sessions = new Map<string, Session>();
  // Set by `shutdown`. A registry that has been torn down must not write
  // again: output buffered in a killed child's pipe still arrives after the
  // kill, and re-arming the debounced flush from there would persist once the
  // daemon had already finished stopping.
  private closed = false;
  private readonly spawn: TerminalSpawner;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly onOutput: (id: string) => void;
  private readonly onExit: (id: string) => void;
  private readonly nativePty: boolean;

  constructor(
    private readonly rootDir: string,
    options: TerminalRegistryOptions = {}
  ) {
    this.spawn = options.spawn ?? spawnInThread;
    this.nativePty = options.nativePty ?? nativePtyAvailable();
    this.maxBytes = options.maxScrollbackBytes ?? SCROLLBACK_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
    this.onOutput = options.onOutput ?? (() => {});
    this.onExit = options.onExit ?? (() => {});
    this.hydrate();
  }

  private dir(): string {
    return terminalsDir(this.rootDir);
  }

  private indexPath(): string {
    return join(this.dir(), 'sessions.json');
  }

  /**
   * Re-reads what a previous daemon left behind. Every session it finds is
   * `orphaned` rather than `running` — this process holds no pipe to any of
   * them — but their scrollback is loaded so the UI can still show what they
   * printed, which is the whole point of persisting it.
   */
  private hydrate(): void {
    const path = this.indexPath();
    if (!existsSync(path)) return;
    let parsed: PersistedSessions;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedSessions;
    } catch {
      // A truncated index is not worth failing a daemon boot over; the
      // scrollback files are still on disk for a human to read.
      return;
    }
    if (!Array.isArray(parsed.sessions)) return;
    for (const info of parsed.sessions) {
      if (typeof info?.id !== 'string') continue;
      const logPath = terminalScrollbackPath(this.rootDir, info.id);
      const buffer = existsSync(logPath)
        ? readFileSync(logPath)
        : Buffer.alloc(0);
      this.sessions.set(info.id, {
        info: {
          ...info,
          state: info.state === 'exited' ? 'exited' : 'orphaned',
          // Absent in an index written before remotes existed.
          remote: info.remote ?? null,
          // A session whose process is gone cannot grow, so the cursor range
          // is pinned to exactly what is on disk.
          total: info.total,
          trimmed: Math.max(0, info.total - buffer.length),
        },
        buffer,
        proc: null,
        persistTimer: null,
        dirty: false,
      });
    }
  }

  /**
   * Writes the index and every dirty session's scrollback.
   *
   * The index goes through a temp file and a rename so a crash mid-write
   * leaves the previous index intact rather than a half-written one that
   * `hydrate` would throw away.
   */
  private persist(): void {
    if (this.closed) return;
    // Nothing to write and nothing written before: a daemon on a project where
    // no one ever opened a terminal should not leave a directory behind, and
    // `shutdown` runs on every daemon stop. Once an index exists this falls
    // through, so removing the last session still records that it is gone.
    if (this.sessions.size === 0 && !existsSync(this.indexPath())) return;
    const dir = this.dir();
    mkdirSync(dir, { recursive: true });
    for (const session of this.sessions.values()) {
      if (!session.dirty) continue;
      writeFileSync(
        terminalScrollbackPath(this.rootDir, session.info.id),
        session.buffer
      );
      session.dirty = false;
    }
    const body: PersistedSessions = {
      sessions: [...this.sessions.values()].map((s) => s.info),
    };
    const tmp = `${this.indexPath()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(tmp, this.indexPath());
  }

  private schedulePersist(session: Session): void {
    if (this.closed || session.persistTimer !== null) return;
    session.persistTimer = setTimeout(() => {
      session.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
    // A pending flush must never be the reason a daemon stays alive.
    session.persistTimer.unref?.();
  }

  private append(session: Session, chunk: Uint8Array): void {
    session.info.total += chunk.length;
    const combined = Buffer.concat([session.buffer, Buffer.from(chunk)]);
    session.buffer =
      combined.length > this.maxBytes
        ? combined.subarray(combined.length - this.maxBytes)
        : combined;
    session.info.trimmed = session.info.total - session.buffer.length;
    session.dirty = true;
    this.schedulePersist(session);
    this.onOutput(session.info.id);
  }

  // Drains the child's output into scrollback until the stream ends. Errors
  // are swallowed deliberately: a stream that breaks because the process died
  // is the ordinary exit path, and `exited` below is what records it.
  private async pump(
    session: Session,
    stream: ReadableStream<Uint8Array>
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined && value.length > 0)
          this.append(session, value);
      }
    } catch {
      // See above.
    } finally {
      reader.releaseLock();
    }
  }

  create(spec: CreateTerminalSpec): TerminalInfo {
    const id = randomUUID();
    const cols =
      spec.cols !== undefined && spec.cols > 0 ? spec.cols : DEFAULT_COLS;
    const rows =
      spec.rows !== undefined && spec.rows > 0 ? spec.rows : DEFAULT_ROWS;
    const requested =
      spec.command !== undefined && spec.command.length > 0
        ? spec.command
        : defaultShell(process.env);
    const remote = spec.remote ?? null;
    // A remote command is `ssh -tt …`, which already has a pty on the far
    // side, so it runs over pipes. A local one gets the native pty, or the
    // `script` fallback on a Bun without one.
    const native = remote === null && this.nativePty;
    const wrapped =
      remote !== null || native
        ? { command: requested, pty: true }
        : ptyCommand(requested);

    // `TERM` is what makes a program emit colour and cursor motion at all, and
    // `COLUMNS`/`LINES` give a size to a program that cannot ask a pty for one
    // — the only way to tell it under the fallbacks, which cannot resize.
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...spec.env,
      TERM: 'xterm-256color',
      COLUMNS: String(cols),
      LINES: String(rows),
    };

    const info: TerminalInfo = {
      id,
      title: spec.title ?? requested.join(' '),
      cwd: spec.cwd,
      command: requested,
      cols,
      rows,
      startedAt: this.now().toISOString(),
      exitedAt: null,
      exitCode: null,
      state: 'running',
      pty: wrapped.pty,
      total: 0,
      trimmed: 0,
      runId: spec.runId ?? null,
      remote,
    };

    const session: Session = {
      info,
      buffer: Buffer.alloc(0),
      proc: null,
      persistTimer: null,
      dirty: true,
    };
    this.sessions.set(id, session);

    let proc: TerminalProcess;
    try {
      proc = this.spawn({
        command: wrapped.command,
        cwd: spec.cwd,
        env,
        pty: native,
        cols,
        rows,
      });
    } catch (err) {
      // Bun throws synchronously when the executable is not on PATH — a
      // missing `ssh` for a remote session, a shell that was uninstalled. The
      // session is still created, already exited, with the reason written into
      // its scrollback: that is what a terminal does when a command does not
      // exist, and it keeps a bad session visible instead of failing the
      // request with nothing to look at.
      const message = err instanceof Error ? err.message : String(err);
      this.append(session, new TextEncoder().encode(`${message}\r\n`));
      session.info.state = 'exited';
      session.info.exitCode = 127;
      session.info.exitedAt = this.now().toISOString();
      this.persist();
      return { ...session.info };
    }
    session.proc = proc;

    void this.pump(session, proc.stdout);
    void proc.exited.then((code) => {
      session.info.state = 'exited';
      session.info.exitCode = code;
      session.info.exitedAt = this.now().toISOString();
      session.proc = null;
      session.dirty = true;
      this.persist();
      this.onExit(id);
    });

    this.persist();
    return { ...info };
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()]
      .map((s) => ({ ...s.info }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  get(id: string): TerminalInfo | null {
    const session = this.sessions.get(id);
    return session === undefined ? null : { ...session.info };
  }

  /**
   * Everything after `since`, as base64.
   *
   * A cursor below `trimmed` is not an error — it is a client that fell far
   * enough behind that the bytes it wanted are gone. It gets the oldest bytes
   * still held, and `since` in the reply tells it where the gap ended.
   */
  read(id: string, since: number): TerminalReadResult | null {
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    const { info, buffer } = session;
    const from = Math.min(Math.max(since, info.trimmed), info.total);
    const slice = buffer.subarray(from - info.trimmed);
    return {
      id,
      since: from,
      total: info.total,
      trimmed: info.trimmed,
      data: slice.toString('base64'),
      state: info.state,
      exitCode: info.exitCode,
    };
  }

  /** Feeds keystrokes to the child. False when nothing is listening. */
  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined || session.proc === null) return false;
    session.proc.write(data);
    return true;
  }

  /**
   * Records a new viewport size and applies it to the child's pty, which
   * signals `SIGWINCH` so a running full-screen program redraws at the new
   * size. Under the fallbacks there is no pty this process can resize, so only
   * the recorded size changes.
   */
  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    if (cols > 0) session.info.cols = cols;
    if (rows > 0) session.info.rows = rows;
    session.proc?.resize?.(session.info.cols, session.info.rows);
    session.dirty = true;
    this.schedulePersist(session);
    return true;
  }

  /** Ends the process but keeps the scrollback, so the output stays readable. */
  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    session.proc?.kill();
    return true;
  }

  /** Ends the process and forgets it, scrollback included. */
  remove(id: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    session.proc?.kill();
    if (session.persistTimer !== null) clearTimeout(session.persistTimer);
    this.sessions.delete(id);
    rmSync(terminalScrollbackPath(this.rootDir, id), { force: true });
    this.persist();
    return true;
  }

  /**
   * Kills every child and flushes scrollback.
   *
   * Sessions stay in the index: the next daemon hydrates them as `orphaned`,
   * which is how "scrollback survives a restart" actually works.
   */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.persistTimer !== null) {
        clearTimeout(session.persistTimer);
        session.persistTimer = null;
      }
      session.proc?.kill();
      session.proc = null;
    }
    this.persist();
    // Last, so the flush above still runs; everything after this is refused.
    this.closed = true;
  }
}
