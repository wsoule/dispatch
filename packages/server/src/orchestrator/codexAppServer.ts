import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

type JsonRpcId = number | string;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexAppServerMessage {
  method: string;
  params?: unknown;
  id?: JsonRpcId;
}

export interface CodexAppServerRequest extends CodexAppServerMessage {
  id: JsonRpcId;
}

export interface CodexAppServerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: 'error', listener: (error: Error) => void): CodexAppServerProcess;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): CodexAppServerProcess;
  kill(): boolean;
}

export type SpawnCodexAppServer = (cwd: string) => CodexAppServerProcess;

export interface CodexAppServerClose {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stderr: string;
}

const STDERR_TAIL_LIMIT = 8_192;

function spawnCodexAppServer(cwd: string): ChildProcessWithoutNullStreams {
  return spawn('codex', ['app-server', '--stdio'], {
    cwd,
    stdio: 'pipe',
    windowsHide: true,
  });
}

/**
 * Minimal JSONL transport for one local Codex App Server process.
 *
 * It deliberately owns no executor policy. An executor may claim a server
 * request and answer it later; every unclaimed request receives JSON-RPC
 * method-not-found so unsupported requests cannot leave Codex blocked.
 */
export class CodexAppServer {
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<
    (message: CodexAppServerMessage) => void
  >();
  private serverRequestHandler?: (request: CodexAppServerRequest) => boolean;
  private readonly process: CodexAppServerProcess;
  private nextId = 1;
  private stdoutBuffer = '';
  private stderrTail = '';
  private settled = false;
  private readonly resolveClosed: (close: CodexAppServerClose) => void;
  readonly closed: Promise<CodexAppServerClose>;

  constructor(
    cwd: string,
    spawnProcess: SpawnCodexAppServer = spawnCodexAppServer
  ) {
    this.process = spawnProcess(cwd);
    let resolveClosed!: (close: CodexAppServerClose) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.resolveClosed = resolveClosed;

    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    this.process.stdin.on('error', (error) => this.settle(null, null, error));
    this.process.once('error', (error) => this.settle(null, null, error));
    this.process.once('exit', (code, signal) => this.settle(code, signal));
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    try {
      this.write({ method, id, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return result;
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  onMessage(listener: (message: CodexAppServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Defers a server request when the executor reports that it can handle it. */
  onServerRequest(
    handler: (request: CodexAppServerRequest) => boolean
  ): () => void {
    this.serverRequestHandler = handler;
    return () => {
      if (this.serverRequestHandler === handler) {
        this.serverRequestHandler = undefined;
      }
    };
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  close(): void {
    if (this.settled) return;
    this.process.stdin.end();
    this.process.kill();
  }

  private write(message: object): void {
    if (this.settled) throw new Error('Codex App Server process is closed');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim() === '') continue;
      try {
        this.route(JSON.parse(line) as unknown);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.settle(
          null,
          null,
          new Error(`malformed Codex App Server output: ${detail}`)
        );
        this.process.kill();
        return;
      }
    }
  }

  private route(value: unknown): void {
    if (typeof value !== 'object' || value === null) {
      throw new Error('expected a JSON object');
    }
    const message = value as Record<string, unknown>;
    if ('id' in message && !('method' in message)) {
      const id = message.id as JsonRpcId;
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      if ('error' in message) {
        const rpcError = message.error as Partial<JsonRpcError>;
        pending.reject(
          new Error(
            `Codex App Server request failed (${String(rpcError.code ?? 'unknown')}): ${rpcError.message ?? 'unknown error'}`
          )
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string') {
      throw new Error('message has neither a response id nor a method');
    }
    const notification = message as unknown as CodexAppServerMessage;
    if (notification.id !== undefined) {
      const request = notification as CodexAppServerRequest;
      if (this.serverRequestHandler?.(request) === true) return;
      this.write({
        id: notification.id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${notification.method}`,
        },
      });
    }
    for (const listener of this.listeners) listener(notification);
  }

  private settle(
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error
  ): void {
    if (this.settled) return;
    this.settled = true;
    const reason =
      error ??
      new Error(
        `Codex App Server exited before replying (code ${String(code)}, signal ${String(signal)})`
      );
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    this.resolveClosed({ code, signal, error, stderr: this.stderrTail.trim() });
  }
}
