import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

import { isRecord, isStringArray } from './guards.js';
import { PROFILES, VECTOR_CLASSES } from './types.js';
import type {
  Hello,
  Observation,
  RunnableVector,
  Unsupported,
} from './types.js';

export class AdapterError extends Error {}

const HELLO_TIMEOUT_MS = 10_000;
const BYE_GRACE_MS = 2000;

const SEPARATORS = /[\u2028\u2029]/g;

// One JSON line for the adapter, with U+2028 and U+2029 escaped (the same
// JSON value) so a reader that breaks lines at them still sees whole lines.
function jsonLine(msg: object): string {
  const text = JSON.stringify(msg).replace(
    SEPARATORS,
    (c) => `\\u${c.charCodeAt(0).toString(16)}`
  );
  return `${text}\n`;
}

// Calls `onLine` for each line of `stream`, split at LF alone (a CR before it
// is dropped), so U+2028 and U+2029 inside a JSON string never end a line.
function readLines(stream: Readable, onLine: (line: string) => void): void {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const lines = (buffered + chunk).split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines)
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  });
  stream.on('end', () => {
    if (buffered !== '') onLine(buffered);
  });
}

function isPattern(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  try {
    new RegExp(v);
    return true;
  } catch {
    return false;
  }
}

// Checks the adapter's hello field by field, so a bad declaration fails the
// run up front rather than surfacing as a confusing vector failure.
function checkHello(raw: unknown): Hello {
  const bad = (why: string): never => {
    throw new AdapterError(`bad hello: ${why}`);
  };
  if (!isRecord(raw) || raw['dmp'] !== 'hello')
    return bad('expected dmp "hello"');
  const impl = raw['implementation'];
  if (
    !isRecord(impl) ||
    typeof impl['name'] !== 'string' ||
    typeof impl['version'] !== 'string'
  )
    bad('implementation must be { name, version }');
  const classes: readonly unknown[] = VECTOR_CLASSES;
  const profiles: readonly unknown[] = PROFILES;
  if (
    !isStringArray(raw['classes']) ||
    !raw['classes'].every((c) => classes.includes(c))
  )
    bad(`classes must list only ${VECTOR_CLASSES.join(', ')}`);
  if (
    !isStringArray(raw['profiles']) ||
    !raw['profiles'].every((p) => profiles.includes(p))
  )
    bad(`profiles must list only ${PROFILES.join(', ')}`);
  if (!isStringArray(raw['capabilities'])) bad('capabilities must be strings');
  if (typeof raw['systemAddress'] !== 'string' || raw['systemAddress'] === '')
    bad('systemAddress is required');
  if (!isStringArray(raw['gateTypes'])) bad('gateTypes must be strings');
  const render = raw['render'];
  if (
    !isRecord(render) ||
    typeof render['quotePrefix'] !== 'string' ||
    render['quotePrefix'] === '' ||
    !isPattern(render['header']) ||
    !Array.isArray(render['hostLines']) ||
    !render['hostLines'].every(isPattern)
  )
    bad(
      'render must be { quotePrefix, header, hostLines } with valid patterns'
    );
  return raw as unknown as Hello;
}

// Checks an observation's shape, so compare never reads a missing list.
function checkObservation(raw: Record<string, unknown>): Observation {
  const bad = (why: string): never => {
    throw new AdapterError(
      `malformed observation for ${String(raw['id'])}: ${why}`
    );
  };
  const list = (key: string, ok: (v: unknown) => boolean): void => {
    const v = raw[key];
    if (!Array.isArray(v) || !v.every(ok))
      bad(`${key} is not a list of the right shape`);
  };
  const text = (r: Record<string, unknown>, keys: readonly string[]): boolean =>
    keys.every((k) => typeof r[k] === 'string');
  list(
    'steps',
    (s) =>
      isRecord(s) &&
      (s['ok'] === true ||
        (s['ok'] === false &&
          isRecord(s['error']) &&
          typeof s['error']['code'] === 'string'))
  );
  list(
    'messages',
    (m) => isRecord(m) && text(m, ['id', 'from', 'kind', 'body'])
  );
  list(
    'deliveries',
    (d) => isRecord(d) && text(d, ['id', 'message', 'recipient'])
  );
  list('calls', (c) => isRecord(c) && typeof c['hook'] === 'string');
  list('gateEffects', (g) => typeof g === 'string');
  list('voided', (g) => typeof g === 'string');
  list(
    'channels',
    (c) =>
      isRecord(c) &&
      typeof c['name'] === 'string' &&
      isStringArray(c['members'])
  );
  list(
    'render',
    (r) =>
      isRecord(r) &&
      typeof r['step'] === 'number' &&
      typeof r['text'] === 'string'
  );
  return raw as unknown as Observation;
}

// One adapter child speaking JSON lines. A crash, a timeout or a line that is
// not JSON rejects the request in flight; the runner then restarts it.
export class AdapterProcess {
  private child: ChildProcess | null = null;
  private waiting: {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  } | null = null;

  constructor(
    private readonly command: string,
    private readonly log: (line: string) => void
  ) {}

  async start(kit: string): Promise<Hello> {
    const child = spawn(this.command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    if (child.stdout !== null)
      readLines(child.stdout, (line) => this.onLine(line));
    child.stderr?.on('data', (chunk: Buffer) =>
      this.log(chunk.toString('utf8'))
    );
    // A write racing the child's exit raises EPIPE here; unhandled, it would
    // crash the runner instead of failing the vector in flight.
    child.stdin?.on('error', (err) =>
      this.fail(new AdapterError(`adapter stdin: ${err.message}`))
    );
    // `close` waits for stdout to drain, so a line written just before exit
    // still answers its request.
    child.on('close', (code, signal) =>
      this.fail(new AdapterError(`adapter exited (${signal ?? String(code)})`))
    );
    child.on('error', (err) => this.fail(new AdapterError(err.message)));
    return checkHello(
      await this.request({ dmp: 'hello', kit }, HELLO_TIMEOUT_MS)
    );
  }

  async run(
    vector: RunnableVector,
    timeoutMs: number
  ): Promise<Observation | Unsupported> {
    const reply = await this.request({ dmp: 'run', vector }, timeoutMs);
    if (
      !isRecord(reply) ||
      (reply['dmp'] !== 'observation' && reply['dmp'] !== 'unsupported') ||
      reply['id'] !== vector.id
    ) {
      throw new AdapterError(
        `expected an observation or unsupported for ${vector.id}`
      );
    }
    if (reply['dmp'] === 'unsupported') {
      if (typeof reply['reason'] !== 'string')
        throw new AdapterError(`unsupported for ${vector.id} gives no reason`);
      return reply as unknown as Unsupported;
    }
    return checkObservation(reply);
  }

  // Says bye and waits for the child to exit, killing it after a grace period.
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null)
      return;
    child.stdin?.end(jsonLine({ dmp: 'bye' }));
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done();
      }, BYE_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
    });
  }

  // Kills the child and closes its stdin, so a process the shell left
  // behind also reads end-of-file and exits.
  kill(): void {
    const child = this.child;
    this.child = null;
    if (child === null) return;
    child.stdin?.destroy();
    child.kill('SIGKILL');
  }

  private request(msg: object, timeoutMs: number): Promise<unknown> {
    const stdin = this.child?.stdin ?? null;
    if (stdin === null)
      return Promise.reject(new AdapterError('adapter is not running'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new AdapterError(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      stdin.write(jsonLine(msg));
    });
  }

  private onLine(line: string): void {
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting === null) {
      this.log(`unexpected adapter line: ${line.slice(0, 200)}\n`);
      return;
    }
    try {
      waiting.resolve(JSON.parse(line));
    } catch {
      waiting.reject(new AdapterError(`malformed line: ${line.slice(0, 200)}`));
    }
  }

  // Rejects the request in flight and drops the child, killing it if it is
  // still alive (a broken stdin can precede its exit).
  private fail(err: Error): void {
    const waiting = this.waiting;
    this.waiting = null;
    const child = this.child;
    this.child = null;
    if (child !== null && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    waiting?.reject(err);
  }
}
