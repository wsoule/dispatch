import { isStub, opHash, signText } from '@dispatch-foo/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch-foo/protocol/federation';

import { plainText } from './onboarding.js';
import { RELAY_DISCLOSURE } from './teamKeys.js';
import { TransportOffline } from './transport.js';
import type {
  FederationTransport,
  TransportHealth,
  Watermarks,
} from './transport.js';

// The relay transport (spec "Relay (F4)"): one WebSocket to the team's relay,
// URL-bound auth, request frames answered by id, and pushes that wake a pass.
// docs/specs/2026-10-05-sealed-relay-contract.md is the frame contract.

export { RELAY_DISCLOSURE };

/** What the relay's auth signature covers: the exact URL dialed. */
export const relayAuthText = (url: string, teamId: string, nonce: string) =>
  `dispatch-relay-v1\n${url}\n${teamId}\n${nonce}`;

export type RelayFrame =
  | { t: 'challenge'; nonce: string }
  | { t: 'auth'; replica: string; sig: string; keyOp?: LogEntry }
  | { t: 'ready' }
  | { t: 'refused'; reason: string }
  | { t: 'publish'; id: number; ops: LogEntry[] }
  | { t: 'stored'; re: number; through: number }
  | {
      t: 'pull';
      id: number;
      since: Record<string, number>;
      replicas?: string[];
    }
  | { t: 'ops'; re?: number; ops: LogEntry[]; more?: boolean }
  | { t: 'ack'; id: number; through: Record<string, number> }
  | { t: 'acknowledged'; re: number }
  | { t: 'error'; re: number; reason: string }
  | { t: 'presence'; online: { replica: string; since: string }[] };

// A request waits this long for its answer before the socket is dropped.
const REQUEST_MS = 15_000;
// Reconnect backoff, doubling from the first to the last.
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// Pull rounds one call follows `more` for.
const PULL_ROUNDS = 20;
// A publish frame carries at most this many entries and bytes (the contract).
const OPS_PER_FRAME = 1000;
const FRAME_BYTES = 4 * 1024 * 1024;
// A frame from the relay over this many characters closes the socket.
const MAX_INCOMING_CHARS = 16 * 1024 * 1024;

interface Waiter {
  resolve: (frame: RelayFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RelayDeps {
  /** The relay's base URL, as the roster's `transport` op names it. */
  url: string;
  teamId: string;
  replica: string;
  signPriv: string;
  /** This replica's key op, which carries its invite proof while pending. */
  keyOp: () => LogEntry | null;
  /** A push arrived: run a pass soon. */
  wake: () => void;
  now: () => Date;
  /** Tests only: sign the challenge for another URL than the one dialed. */
  signFor?: string;
  /** Tests only: entries per publish frame, in place of OPS_PER_FRAME. */
  opsPerFrame?: number;
}

/** A relay URL as it is dialed and signed: no trailing slash. */
const normalRelayUrl = (url: string): string => url.replace(/\/+$/, '');

/** The relay's HTTP base for a relay URL: the same host and path, over
 *  https for wss (http for a ws:// relay in tests), no trailing slash. */
export function relayHttpBase(url: string): string {
  return normalRelayUrl(url).replace(/^ws(s?):\/\//i, 'http$1://');
}

/** What `POST /v1/teams` takes: the founder's key and found ops, and its
 *  ops after the key op through its latest `license` op, so a hosted relay
 *  sees the team's license. Every entry is the founder's, in one chain. */
export interface RelayRegistration {
  key: LogEntry;
  found: LogEntry;
  ops: LogEntry[];
}

const rosterAction = (e: LogEntry): string | undefined =>
  e.type === 'roster' && !isStub(e)
    ? (e.body as { action?: string } | undefined)?.action
    : undefined;

/**
 * The founder chain a registration sends, from entries of the founder's log
 * (its own log on the founder, a transport scan elsewhere): the key op, the
 * found op at `foundSeq`, and every op between them and on through the
 * latest license op, as long as the seqs run unbroken. Null when the key or
 * found op, or an op between them, is missing.
 */
export function founderChain(
  entries: readonly LogEntry[],
  founder: string,
  foundSeq: number
): RelayRegistration | null {
  const bySeq = new Map<number, LogEntry>();
  for (const e of entries)
    if (e.replica === founder && !bySeq.has(e.seq)) bySeq.set(e.seq, e);
  const seqs = [...bySeq.keys()].sort((a, b) => a - b);
  const key = bySeq.get(seqs[0] ?? -1);
  const found = bySeq.get(foundSeq);
  if (key?.type !== 'key' || found === undefined) return null;
  if (rosterAction(found) !== 'found') return null;
  // The chain verifies from the key op, so it may not skip a seq.
  const run: LogEntry[] = [];
  for (let seq = key.seq; bySeq.has(seq); seq++)
    run.push(bySeq.get(seq) as LogEntry);
  if ((run.at(-1)?.seq ?? 0) < foundSeq) return null;
  const license = run.findLast((e) => rosterAction(e) === 'license');
  const through = Math.max(foundSeq, license?.seq ?? 0);
  const ops = run.filter(
    (e) => e.seq > key.seq && e.seq <= through && e.seq !== foundSeq
  );
  return { key, found, ops };
}

/** A relay refused, or could not be asked, to register the team. */
export class RelayRegistrationError extends Error {
  override name = 'RelayRegistrationError';
}

// How long a registration waits for the relay's answer.
const REGISTER_MS = 15_000;
/** The most leading zero bits a relay may ask a stamp for; past it, the
 *  relay is refused rather than costing this machine minutes of hashing. */
const MAX_POW_DIFFICULTY = 26;
// Hashes between yields to the event loop while minting, so the daemon
// keeps answering requests during the second or two a stamp takes.
const MINT_SLICE = 20_000;

/** What `GET /v1/registration` answers: the stamp's difficulty in leading
 *  zero bits, whether this relay needs its operator's token (self-hosted),
 *  and whether it takes one in place of a stamp. */
interface RegistrationTerms {
  difficulty: number;
  tokenRequired: boolean;
  tokenAccepted: boolean;
}

/** The text a registration stamp hashes (the contract's Registration):
 *  `t` in unix seconds, the URL with no trailing slash, a decimal nonce. */
export const powText = (
  teamId: string,
  relayUrl: string,
  t: number,
  nonce: string
) => `dispatch-relay-reg-v1\n${teamId}\n${relayUrl}\n${String(t)}\n${nonce}`;

/** Leading zero bits of a digest, most significant bit first. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/**
 * A proof-of-work stamp: the first decimal nonce whose
 * sha256(powText(teamId, relayUrl, t, nonce)) has at least `difficulty`
 * leading zero bits. The relay checks one hash; this machine pays about
 * 2^difficulty, which keeps anonymous registrations cheap to accept and
 * dear to flood. It yields every MINT_SLICE hashes.
 */
export async function mintStamp(
  teamId: string,
  relayUrl: string,
  t: number,
  difficulty: number
): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for (let n = 0; ; n++) {
    if (n > 0 && n % MINT_SLICE === 0)
      await new Promise((resolve) => setImmediate(resolve));
    const nonce = String(n);
    hasher.update(powText(teamId, relayUrl, t, nonce));
    if (leadingZeroBits(hasher.digest()) >= difficulty) return nonce;
  }
}

// The relay's registration terms, or null when it publishes none (an older
// relay, which takes a token or nothing).
async function registrationTerms(
  base: string,
  doFetch: typeof fetch
): Promise<RegistrationTerms | null> {
  let res: Response;
  try {
    res = await doFetch(`${base}/v1/registration`, {
      signal: AbortSignal.timeout(REGISTER_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as {
      difficulty?: unknown;
      tokenRequired?: unknown;
      tokenAccepted?: unknown;
    };
    if (
      typeof body.difficulty !== 'number' ||
      !Number.isInteger(body.difficulty) ||
      body.difficulty < 0
    )
      return null;
    return {
      difficulty: body.difficulty,
      tokenRequired: body.tokenRequired === true,
      tokenAccepted: body.tokenAccepted === true,
    };
  } catch {
    return null;
  }
}

/**
 * Registers the team at the relay with `POST /v1/teams`, before a switch
 * signs its `transport` op: the relay serves no team it has not registered.
 * Registering a team the relay already holds succeeds.
 *
 * The relay's terms (`GET /v1/registration`) decide what proves the
 * registration besides the founder's signed chain: a proof-of-work stamp,
 * or the operator's token where the relay needs one or takes one in place
 * of the stamp. A stamp the relay calls stale (403) is minted once more
 * with a fresh time. `token` goes only into this request's Authorization
 * header. Answers the relay's team id; throws RelayRegistrationError with
 * a reason a person can act on.
 */
export async function registerAtRelay(
  url: string,
  registration: RelayRegistration,
  opts: { token?: string; fetch?: typeof fetch; now?: () => number } = {}
): Promise<string> {
  const base = relayHttpBase(url);
  const where = normalRelayUrl(url);
  const doFetch = opts.fetch ?? fetch;
  const fail = (why: string): RelayRegistrationError =>
    new RelayRegistrationError(
      `could not register the team at the relay ${where}: ${why}`
    );
  const terms = await registrationTerms(base, doFetch);
  if (terms?.tokenRequired === true && opts.token === undefined)
    throw fail(
      'it needs a registration token; pass the one its operator gave you'
    );
  if (terms !== null && terms.difficulty > MAX_POW_DIFFICULTY)
    throw fail(
      `it asks for more work (${String(terms.difficulty)} bits) than Dispatch will do`
    );
  // An older relay publishes no terms: it gets the token, if any, and no
  // stamp. A newer one gets the token where it takes one, else a stamp.
  const useToken =
    opts.token !== undefined &&
    (terms === null || terms.tokenRequired || terms.tokenAccepted);
  const stamp = async (): Promise<{ t: number; nonce: string } | undefined> => {
    if (terms === null || useToken) return undefined;
    const t = Math.floor((opts.now?.() ?? Date.now()) / 1000);
    const nonce = await mintStamp(
      opHash(registration.found).slice(0, 32),
      where,
      t,
      terms.difficulty
    );
    return { t, nonce };
  };
  const post = async (pow: { t: number; nonce: string } | undefined) => {
    try {
      return await doFetch(`${base}/v1/teams`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(useToken ? { authorization: `Bearer ${opts.token ?? ''}` } : {}),
        },
        body: JSON.stringify({
          ...registration,
          ...(pow === undefined ? {} : { pow }),
        }),
        signal: AbortSignal.timeout(REGISTER_MS),
      });
    } catch (err) {
      throw fail(`it is unreachable (${(err as Error).message})`);
    }
  };
  let res = await post(await stamp());
  // A stale stamp (the relay's clock moved on while it was minted) gets one
  // more try with a fresh time.
  if (res.status === 403 && !useToken && terms !== null)
    res = await post(await stamp());
  let answer: { teamId?: unknown; error?: unknown } = {};
  try {
    answer = (await res.json()) as typeof answer;
  } catch {
    // A body that is not JSON leaves only the status to report.
  }
  if (res.ok && typeof answer.teamId === 'string') return answer.teamId;
  const said =
    typeof answer.error === 'string' ? `: ${plainText(answer.error, 200)}` : '';
  throw fail(
    res.status === 401
      ? useToken
        ? 'it refused the registration token'
        : 'it needs a registration token; pass the one its operator gave you'
      : res.status === 403
        ? `it refused the proof of work twice${said}; check this machine's clock`
        : res.ok
          ? 'its answer named no team'
          : `it answered HTTP ${String(res.status)}${said}`
  );
}

/** Ops on the relay; every call made while it is unreachable throws
 *  TransportOffline, so the outbox waits (no fallback to git). */
export class RelayFederationTransport implements FederationTransport {
  readonly kind = 'relay' as const;
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, Waiter>();
  private online: { replica: string; since: string }[] = [];
  private lastError: string | null = null;
  private lastExchangeAt: string | null = null;
  private retryAt = 0;
  private backoff = 0;
  private pushes = 0;
  private closed = false;

  constructor(private readonly deps: RelayDeps) {}

  get url(): string {
    return this.deps.url;
  }

  async publish(ops: FederatedOp[]): Promise<void> {
    await this.upload(ops);
  }

  /** Stores entries (stubs too) on the relay, idempotent by (replica, seq),
   *  in frames of at most OPS_PER_FRAME entries and FRAME_BYTES; it stops at
   *  the first frame the relay stored only part of. */
  async upload(entries: readonly LogEntry[]): Promise<void> {
    const per = this.deps.opsPerFrame ?? OPS_PER_FRAME;
    let frame: LogEntry[] = [];
    let bytes = 0;
    const send = async (): Promise<void> => {
      if (frame.length === 0) return;
      const ops = frame;
      frame = [];
      bytes = 0;
      const reply = await this.request({ t: 'publish', id: 0, ops });
      if (reply.t !== 'stored')
        throw new TransportOffline('the relay stored nothing');
      const top = Math.max(...ops.map((e) => e.seq));
      if (reply.through < top)
        throw new TransportOffline(
          `the relay holds this machine's ops only through seq ${reply.through}`
        );
    };
    for (const e of entries) {
      const size = Buffer.byteLength(JSON.stringify(e));
      if (
        frame.length >= per ||
        (frame.length > 0 && bytes + size > FRAME_BYTES)
      )
        await send();
      frame.push(e);
      bytes += size;
    }
    await send();
  }

  async pull(since: Watermarks): Promise<LogEntry[]> {
    return this.pullFrom(Object.fromEntries(since));
  }

  async scan(replicas: readonly string[] | null): Promise<LogEntry[]> {
    return this.pullFrom({}, replicas === null ? undefined : [...replicas]);
  }

  stamp(): string {
    return String(this.pushes);
  }

  forgetScans(): void {}

  async ack(through: Watermarks): Promise<void> {
    const reply = await this.request({
      t: 'ack',
      id: 0,
      through: Object.fromEntries(through),
    });
    if (reply.t !== 'acknowledged')
      throw new TransportOffline('the relay did not acknowledge');
  }

  presence(): { replica: string; since: string }[] | null {
    return this.ws === null ? null : [...this.online];
  }

  health(): TransportHealth {
    return {
      kind: 'relay',
      lastExchangeAt: this.lastExchangeAt,
      lastError: this.lastError,
      unpublished: 0,
      sizeBytes: null,
      readBytes: 0,
      // The relay's own 30-day retention replaces git's pruning blockers.
      acks: {},
      url: this.deps.url,
    };
  }

  /** Drops the socket for good. */
  close(): void {
    this.closed = true;
    this.ws?.close();
    this.down('closed');
  }

  private async pullFrom(
    since: Record<string, number>,
    replicas?: string[]
  ): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    const marks = { ...since };
    for (let round = 0; round < PULL_ROUNDS; round++) {
      const reply = await this.request({
        t: 'pull',
        id: 0,
        since: marks,
        ...(replicas === undefined ? {} : { replicas }),
      });
      if (reply.t !== 'ops')
        throw new TransportOffline('the relay sent no ops');
      out.push(...reply.ops);
      for (const e of reply.ops)
        marks[e.replica] = Math.max(marks[e.replica] ?? 0, e.seq);
      if (reply.more !== true) break;
    }
    this.lastExchangeAt = this.deps.now().toISOString();
    return out;
  }

  // One request frame, answered by the frame that names its id.
  private async request(
    frame: Extract<RelayFrame, { id: number }>
  ): Promise<RelayFrame> {
    const ws = await this.socket();
    const id = this.nextId++;
    return await new Promise<RelayFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new TransportOffline('the relay did not answer'));
        ws.close();
      }, REQUEST_MS);
      this.waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...frame, id }));
    }).then((reply) => {
      if (reply.t === 'error') throw new TransportOffline(reply.reason);
      return reply;
    });
  }

  // The authenticated socket, connecting when there is none and the
  // backoff allows.
  private socket(): Promise<WebSocket> {
    if (this.ws !== null) return Promise.resolve(this.ws);
    if (this.closed)
      return Promise.reject(
        new TransportOffline('the relay transport is closed')
      );
    if (this.connecting !== null) return this.connecting;
    if (Date.now() < this.retryAt)
      return Promise.reject(
        new TransportOffline(this.lastError ?? 'the relay is unreachable')
      );
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private open(): Promise<WebSocket> {
    const { teamId, replica, signPriv } = this.deps;
    const url = normalRelayUrl(this.deps.url);
    const endpoint = `${url}/v1/teams/${teamId}`;
    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const fail = (why: string): void => {
        this.lastError = why;
        this.backoff = Math.min(
          BACKOFF_MAX_MS,
          Math.max(BACKOFF_MIN_MS, this.backoff * 2)
        );
        this.retryAt = Date.now() + this.backoff;
        if (!settled) {
          settled = true;
          reject(new TransportOffline(why));
        }
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(endpoint);
      } catch (err) {
        fail(`the relay is unreachable: ${(err as Error).message}`);
        return;
      }
      const timer = setTimeout(() => {
        fail('the relay did not answer');
        ws.close();
      }, REQUEST_MS);
      ws.onmessage = (ev) => {
        const frame = readFrame(ev.data);
        // A frame off the contract closes the socket, as the contract says.
        if (frame === null) {
          ws.close();
          return;
        }
        if (!settled && frame.t === 'challenge') {
          const keyOp = this.deps.keyOp();
          const sig = signText(
            signPriv,
            relayAuthText(this.deps.signFor ?? url, teamId, frame.nonce)
          );
          ws.send(
            JSON.stringify({
              t: 'auth',
              replica,
              sig,
              ...(keyOp === null ? {} : { keyOp }),
            })
          );
          return;
        }
        if (!settled && frame.t === 'refused') {
          clearTimeout(timer);
          fail(`refused: ${frame.reason}`);
          ws.close();
          return;
        }
        if (!settled && frame.t === 'ready') {
          clearTimeout(timer);
          settled = true;
          this.ws = ws;
          this.backoff = 0;
          this.lastError = null;
          resolve(ws);
          return;
        }
        if (settled) this.onFrame(frame);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.ws === ws) this.down('the relay closed the connection');
        fail(this.lastError ?? 'the relay closed the connection');
      };
      ws.onerror = () => {
        if (!settled) fail('the relay is unreachable');
      };
    });
  }

  // A frame on an authenticated socket: an answer, a push or presence.
  private onFrame(frame: RelayFrame): void {
    if (frame.t === 'presence') {
      this.online = frame.online;
      return;
    }
    if ('re' in frame && typeof frame.re === 'number') {
      const waiter = this.waiting.get(frame.re);
      if (waiter === undefined) return;
      this.waiting.delete(frame.re);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    if (frame.t === 'ops') {
      this.pushes += 1;
      this.deps.wake();
    }
  }

  // The socket is gone: every waiting call fails, and the next reconnects.
  private down(why: string): void {
    this.ws = null;
    this.online = [];
    this.lastError = why === 'closed' ? this.lastError : why;
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new TransportOffline(why));
      this.waiting.delete(id);
    }
  }
}

// A frame off the wire, or null; its ops are checked by the pass, not here.
function readFrame(data: unknown): RelayFrame | null {
  if (typeof data !== 'string' || data.length > MAX_INCOMING_CHARS) return null;
  try {
    const v = JSON.parse(data) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const t = (v as { t?: unknown }).t;
    if (typeof t !== 'string') return null;
    if ('ops' in v && !Array.isArray((v as { ops?: unknown }).ops)) return null;
    return v as RelayFrame;
  } catch {
    return null;
  }
}
