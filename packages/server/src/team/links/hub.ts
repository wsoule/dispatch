import { ENVELOPE_URI, WORK_URI } from '@dispatch/a2a';
import type { LinkPayload } from '@dispatch/a2a';
import type { JsonValue } from '@dispatch/protocol';
import { isStub } from '@dispatch/protocol/federation';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AsyncGitRunner } from '../../sync/worktree.js';
import { defaultAsyncGitRunner } from '../../sync/worktree.js';
import { SyncRepo } from '../boardSync/repo.js';
import { signedEntry } from '../federation/git.js';
import { LINK_READ_BYTES, linkReplicaId, LinkService } from './service.js';
import type { LinkKeys, PublishResult } from './service.js';
import type { LinkProblem } from './store.js';

/** One paired teammate reached over a link (T54). */
export interface LinkRow {
  alias: string;
  /** The pairing id: the link's id and the branch suffix. */
  pairedId: string;
  remote: string;
  branch: string;
  /** The peer's link keys, decided by its verified binding. */
  signPub: string;
  sealPub: string;
  createdAt: string;
}

export interface LinkHealth {
  alias: string;
  remote: string;
  branch: string;
  ready: boolean;
  // Accepted here, and the offerer's first op not read yet.
  pending: boolean;
  // Fresh bytes this link read in the last pass (0 when it waited).
  readThisPass: number;
  waiting: number;
  lastExchangeAt: string | null;
  lastError: string | null;
  unpublished: number;
  problems: LinkProblem[];
}

export interface LinkHubDeps {
  /** Where the hub keeps hub.db and one directory per link. */
  dir: string;
  keys: LinkKeys;
  /** Whether `alias` is still a live, paired link peer here. */
  paired: (alias: string) => boolean;
  /** Runs one A2A request as the paired client of `alias` (handleA2A). */
  serve: (alias: string, req: Request) => Promise<Response>;
  /** Calls `onChange` when the paired client's task changes; returns a stop. */
  watch: (alias: string, taskId: string, onChange: () => void) => () => void;
  /** The other side ended pairing `pairedId` over the link. */
  unpaired: (alias: string, pairedId: string) => void;
  /** A key-change statement from the other side, under applyStatement's rules. */
  keyChange: (alias: string, statement: unknown) => void;
  now: () => Date;
  git?: AsyncGitRunner;
  intervalMs?: number;
  changed?: () => void;
  /** An offer's pairing state ('offered' while it may complete). */
  offerState?: (pairedId: string) => string | null;
  /** Checks a proof read on an offer's branch (linkPairing.checkLinkProof). */
  offerProof?: (pairedId: string, proof: unknown) => OfferProof;
  /** An accepted link the offerer never answered in time: end the pairing. */
  pairingFailed?: (alias: string, pairedId: string) => void;
  /** One link's fresh reads a pass (LINK_READ_BYTES). */
  linkReadBytes?: number;
  /** All links' fresh reads a pass (LINK_TOTAL_READ_BYTES). */
  totalReadBytes?: number;
}

/** What every link together may read a pass; round-robin past it (P-D6). */
const LINK_TOTAL_READ_BYTES = 24 * 1024 * 1024;
// Below this a link waits for the next pass rather than read a sliver.
const MIN_SHARE_BYTES = 64 * 1024;

type OfferProof =
  | { ok: true; signPub: string; sealPub: string; complete: () => boolean }
  | { ok: false; why: string };

export interface LinkOffer {
  pairedId: string;
  alias: string;
  remote: string;
  branch: string;
  createdAt: string;
  problems: string[];
}

const LINK_BASE = 'http://link.invalid/a2a/v1';
const TERMINAL = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

// The receiver's latest view of a task as one JSON Task, from any StreamResponse.
function taskOf(
  event: Record<string, unknown>
): Record<string, unknown> | null {
  const t = event['task'];
  if (typeof t === 'object' && t !== null) return t as Record<string, unknown>;
  return null;
}

/** A provisional task id for a send whose receiver has not answered yet. */
export function provisionalTaskId(messageId: string): string {
  return `link-${messageId}`;
}

// Every link of this project: the registry in hub.db, a LinkService per link,
// a pass timer, the sender's view of each remote task (from `event` ops), and
// the receiver's watches that publish its tasks' changes back.
export class LinkHub {
  private readonly db: Database;
  private readonly services = new Map<string, LinkService>();
  private readonly watches = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(alias: string) => void>();
  private readonly offerProblems = new Map<string, string[]>();
  private readonly readThisPass = new Map<string, number>();
  private rotation = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(private readonly deps: LinkHubDeps) {
    mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
    chmodSync(deps.dir, 0o700);
    this.db = new Database(join(deps.dir, 'hub.db'), {
      create: true,
      strict: true,
    });
    chmodSync(join(deps.dir, 'hub.db'), 0o600);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (alias TEXT PRIMARY KEY, paired_id TEXT NOT NULL UNIQUE, remote TEXT NOT NULL, branch TEXT NOT NULL, sign_pub TEXT NOT NULL, seal_pub TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sent (alias TEXT NOT NULL, message_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY (alias, message_id));
      CREATE TABLE IF NOT EXISTS remote_tasks (alias TEXT NOT NULL, task_id TEXT NOT NULL, json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (alias, task_id));
      CREATE TABLE IF NOT EXISTS served (alias TEXT NOT NULL, task_id TEXT NOT NULL, for_id TEXT NOT NULL, PRIMARY KEY (alias, task_id));
      CREATE TABLE IF NOT EXISTS key_bodies (alias TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (alias TEXT PRIMARY KEY, until TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (alias TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (alias, subject));
      CREATE TABLE IF NOT EXISTS offers (paired_id TEXT PRIMARY KEY, alias TEXT NOT NULL, remote TEXT NOT NULL, branch TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    for (const row of this.links()) this.open(row);
  }

  links(): LinkRow[] {
    return this.db
      .query<
        {
          alias: string;
          paired_id: string;
          remote: string;
          branch: string;
          sign_pub: string;
          seal_pub: string;
          created_at: string;
        },
        []
      >('SELECT * FROM links ORDER BY alias')
      .all()
      .map((r) => ({
        alias: r.alias,
        pairedId: r.paired_id,
        remote: r.remote,
        branch: r.branch,
        signPub: r.sign_pub,
        sealPub: r.seal_pub,
        createdAt: r.created_at,
      }));
  }

  get(alias: string): LinkRow | null {
    return this.links().find((l) => l.alias === alias) ?? null;
  }

  /** This side's link keys, for a pairing's binding. */
  ourKeys(): LinkKeys {
    return this.deps.keys;
  }

  /** Records a link and starts serving it; `keyBody` joins its key op. An
   *  accepted link stays pending until the offerer's first op, or fails at
   *  `pendingUntil`. */
  add(
    row: LinkRow,
    keyBody?: Record<string, JsonValue>,
    opts: { pendingUntil?: string } = {}
  ): void {
    if (opts.pendingUntil !== undefined)
      this.db
        .query('INSERT OR REPLACE INTO pending (alias, until) VALUES (?, ?)')
        .run(row.alias, opts.pendingUntil);
    if (keyBody !== undefined)
      this.db
        .query('INSERT OR REPLACE INTO key_bodies (alias, json) VALUES (?, ?)')
        .run(row.alias, JSON.stringify(keyBody));
    this.db
      .query(
        'INSERT INTO links (alias, paired_id, remote, branch, sign_pub, seal_pub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        row.alias,
        row.pairedId,
        row.remote,
        row.branch,
        row.signPub,
        row.sealPub,
        row.createdAt
      );
    this.open(row);
    this.kick();
  }

  /** Forgets a link and everything kept for it; its directory stays. */
  remove(alias: string): void {
    this.services.get(alias)?.close();
    this.services.delete(alias);
    for (const [key, stop] of this.watches)
      if (key.startsWith(`${alias}\n`)) {
        stop();
        this.watches.delete(key);
      }
    for (const table of [
      'links',
      'sent',
      'remote_tasks',
      'served',
      'key_bodies',
      'pending',
      'notes',
    ])
      this.db.query(`DELETE FROM ${table} WHERE alias = ?`).run(alias);
  }

  private open(row: LinkRow): void {
    const keyBody = this.db
      .query<{ json: string }, [string]>(
        'SELECT json FROM key_bodies WHERE alias = ?'
      )
      .get(row.alias);
    const service = new LinkService({
      ...(keyBody === null
        ? {}
        : {
            keyBody: JSON.parse(keyBody.json) as Record<string, JsonValue>,
          }),
      dir: join(this.deps.dir, row.pairedId),
      link: { id: row.pairedId, remote: row.remote, branch: row.branch },
      keys: this.deps.keys,
      peer: () => ({ signPub: row.signPub, sealPub: row.sealPub }),
      paired: () => this.deps.paired(row.alias),
      deliver: (payload, from) => this.deliver(row, payload, from.replica),
      now: this.deps.now,
      ...(this.deps.git === undefined ? {} : { git: this.deps.git }),
    });
    this.services.set(row.alias, service);
    for (const s of this.db
      .query<{ task_id: string; for_id: string }, [string]>(
        'SELECT task_id, for_id FROM served WHERE alias = ?'
      )
      .all(row.alias))
      this.follow(row.alias, s.task_id, s.for_id);
  }

  start(): void {
    this.timer = setInterval(() => this.kick(), this.deps.intervalMs ?? 15_000);
    this.timer.unref();
    this.kick();
  }

  /** Stops the timer and watches; stores close once a running pass ends. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const stop of this.watches.values()) stop();
    this.watches.clear();
    const close = () => {
      for (const s of this.services.values()) s.close();
      this.services.clear();
      this.db.close();
    };
    if (this.running !== null) await this.running.catch(() => undefined);
    close();
  }

  /** Runs a pass soon; passes never overlap. */
  kick(): void {
    if (this.stopped) return;
    if (this.running !== null) {
      this.again = true;
      return;
    }
    this.running = this.passAll().finally(() => {
      this.running = null;
      if (this.again && !this.stopped) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** One pass over every link, awaited (tests and the e2e use it). */
  async settle(): Promise<void> {
    while (this.running !== null) await this.running;
    if (this.stopped) return;
    this.running = this.passAll().finally(() => {
      this.running = null;
    });
    await this.running;
  }

  // One pass: every link in turn from a rotating start, each within its
  // share and all within the total, so read cost stays bounded however many
  // links there are (P-D6). A link past the total waits for the next pass.
  private async passAll(): Promise<void> {
    await this.scanOffers();
    const all = [...this.services];
    const start = all.length === 0 ? 0 : this.rotation % all.length;
    this.rotation += 1;
    const share = this.deps.linkReadBytes ?? LINK_READ_BYTES;
    let left = this.deps.totalReadBytes ?? LINK_TOTAL_READ_BYTES;
    for (let i = 0; i < all.length; i++) {
      if (this.stopped) return;
      const [alias, s] = all[(start + i) % all.length];
      if (left < MIN_SHARE_BYTES) {
        this.readThisPass.set(alias, 0);
        continue;
      }
      try {
        await s.sync({ readBytes: Math.min(share, left) });
        const used = s.health().readBytes;
        this.readThisPass.set(alias, used);
        left -= used;
      } catch (err) {
        this.readThisPass.set(alias, 0);
        console.error(`a2a: link a2a:${alias} pass failed`, err);
      }
      this.checkPending(alias, s);
    }
    this.deps.changed?.();
  }

  // An accepted link is pending until the offerer's first op is read; past
  // its deadline, the pairing fails with a note the owner sees.
  private checkPending(alias: string, s: LinkService): void {
    const row = this.db
      .query<{ until: string }, [string]>(
        'SELECT until FROM pending WHERE alias = ?'
      )
      .get(alias);
    if (row === null) return;
    if (s.peerSeen()) {
      this.db.query('DELETE FROM pending WHERE alias = ?').run(alias);
      return;
    }
    if (this.deps.now().getTime() <= Date.parse(row.until)) return;
    this.db.query('DELETE FROM pending WHERE alias = ?').run(alias);
    this.db
      .query(
        'INSERT OR REPLACE INTO notes (alias, subject, message, at) VALUES (?, ?, ?, ?)'
      )
      .run(
        alias,
        `link-unanswered:${this.get(alias)?.pairedId ?? alias}`,
        'the other side never started this link, so it never completed the pairing (its offer may have expired before it read the acceptance). The pairing is disabled: remove it and pair again.',
        this.deps.now().toISOString()
      );
    const pairedId = this.get(alias)?.pairedId;
    if (pairedId !== undefined) this.deps.pairingFailed?.(alias, pairedId);
  }

  private notes(alias: string): LinkProblem[] {
    return this.db
      .query<{ subject: string; message: string; at: string }, [string]>(
        'SELECT subject, message, at FROM notes WHERE alias = ?'
      )
      .all(alias)
      .map((n) => ({ ...n, dismissible: false }));
  }

  private isPending(alias: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM pending WHERE alias = ?'
        )
        .get(alias)?.n === 1
    );
  }

  // ---- offers waiting for the accepter's proof on their branch (T55) ----

  /** Watches an offer's branch for the accepter's key op and its proof. */
  watchOffer(o: {
    pairedId: string;
    alias: string;
    remote: string;
    branch: string;
  }): void {
    this.db
      .query(
        'INSERT OR REPLACE INTO offers (paired_id, alias, remote, branch, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        o.pairedId,
        o.alias,
        o.remote,
        o.branch,
        this.deps.now().toISOString()
      );
    this.kick();
  }

  offers(): LinkOffer[] {
    return this.db
      .query<
        {
          paired_id: string;
          alias: string;
          remote: string;
          branch: string;
          created_at: string;
        },
        []
      >('SELECT * FROM offers ORDER BY created_at')
      .all()
      .map((r) => ({
        pairedId: r.paired_id,
        alias: r.alias,
        remote: r.remote,
        branch: r.branch,
        createdAt: r.created_at,
        problems: this.offerProblems.get(r.paired_id) ?? [],
      }));
  }

  private dropOffer(pairedId: string): void {
    this.db.query('DELETE FROM offers WHERE paired_id = ?').run(pairedId);
    this.offerProblems.delete(pairedId);
  }

  // Reads each open offer's branch for key ops carrying a proof. A proof that
  // checks out and an op its bound key signed for this link complete it;
  // anything else is ignored with a note.
  private async scanOffers(): Promise<void> {
    for (const o of this.offers()) {
      if (this.stopped) return;
      const state = this.deps.offerState?.(o.pairedId) ?? 'gone';
      if (state !== 'offered') {
        this.dropOffer(o.pairedId);
        continue;
      }
      const repo = new SyncRepo(
        join(this.deps.dir, 'offers', o.pairedId),
        o.remote,
        o.branch,
        'offer-00000000',
        this.deps.git ?? defaultAsyncGitRunner
      );
      try {
        await repo.ensure();
        const res = await repo.exchange();
        if (res.offline !== undefined) continue;
      } catch (err) {
        console.error(`a2a: reading link offer ${o.pairedId} failed`, err);
        continue;
      }
      const notes: string[] = [];
      for (const e of repo.scanFull(null)) {
        if (e.type !== 'key' || isStub(e)) continue;
        // After isStub, `e` is a full op.
        const body = e.body as Record<string, unknown> | undefined;
        if (body?.['link'] !== o.pairedId || body['proof'] === undefined)
          continue;
        const check = this.deps.offerProof?.(o.pairedId, body['proof']) ?? null;
        if (check === null || !check.ok) {
          notes.push(check?.why ?? 'a proof nobody here can check');
          continue;
        }
        if (
          e.replica !== linkReplicaId(check.signPub, o.pairedId) ||
          !signedEntry(e, check.signPub)
        ) {
          notes.push('a proof in an op its link key did not sign');
          continue;
        }
        if (check.complete()) {
          this.dropOffer(o.pairedId);
          this.add({
            alias: o.alias,
            pairedId: o.pairedId,
            remote: o.remote,
            branch: o.branch,
            signPub: check.signPub,
            sealPub: check.sealPub,
            createdAt: this.deps.now().toISOString(),
          });
        }
        break;
      }
      if (notes.length > 0)
        this.offerProblems.set(o.pairedId, [
          `${notes.length} key op${notes.length === 1 ? '' : 's'} on the link branch offered a pairing proof that did not check out (${notes[0]}); ignored`,
        ]);
    }
  }

  publish(alias: string, payload: LinkPayload): PublishResult {
    const s = this.services.get(alias);
    if (s === undefined) return 'refused';
    const r = s.publish(payload);
    if (r === 'published' || r === 'waiting') this.kick();
    return r;
  }

  health(): LinkHealth[] {
    return this.links().map((l) => {
      const s = this.services.get(l.alias);
      const h = s?.health();
      return {
        alias: l.alias,
        remote: l.remote,
        branch: l.branch,
        ready: s?.linkReady() ?? false,
        pending: this.isPending(l.alias),
        readThisPass: this.readThisPass.get(l.alias) ?? 0,
        waiting: s?.waiting() ?? 0,
        lastExchangeAt: h?.lastExchangeAt ?? null,
        lastError: h?.lastError ?? null,
        unpublished: h?.unpublished ?? 0,
        problems: [...this.notes(l.alias), ...(s?.problems() ?? [])],
      };
    });
  }

  // ---- the sender's side: what the other side said about our sends ----

  /** Calls `fn` with the alias each time an `event` arrives on a link. */
  onEvent(fn: (alias: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The receiver's task id for a send, once its first event arrived. */
  taskFor(alias: string, messageId: string): string | null {
    return (
      this.db
        .query<{ task_id: string }, [string, string]>(
          'SELECT task_id FROM sent WHERE alias = ? AND message_id = ?'
        )
        .get(alias, messageId)?.task_id ?? null
    );
  }

  /** The latest snapshot of a remote task, by its id or a provisional one. */
  snapshot(
    alias: string,
    taskId: string
  ): { task: Record<string, unknown>; at: string } | null {
    const id = taskId.startsWith('link-')
      ? (this.taskFor(alias, taskId.slice('link-'.length)) ?? taskId)
      : taskId;
    const row = this.db
      .query<{ json: string; at: string }, [string, string]>(
        'SELECT json, at FROM remote_tasks WHERE alias = ? AND task_id = ?'
      )
      .get(alias, id);
    return row === null
      ? null
      : {
          task: JSON.parse(row.json) as Record<string, unknown>,
          at: row.at,
        };
  }

  // ---- the receiver's side ----

  // Hands one verified payload on. N4: the LinkService accepted it only on
  // the chain of this pairing's pinned link key; `from` is checked again here.
  private async deliver(
    row: LinkRow,
    payload: LinkPayload,
    from: string
  ): Promise<'applied' | 'parked'> {
    if (from !== linkReplicaId(row.signPub, row.pairedId)) return 'applied';
    switch (payload.kind) {
      case 'send':
        return this.served(row, payload);
      case 'event':
        this.recordEvent(row.alias, payload);
        return 'applied';
      case 'cancel':
        await this.call(
          row.alias,
          'POST',
          `/tasks/${encodeURIComponent(payload.taskId)}:cancel`
        );
        return 'applied';
      case 'resync':
        await this.republish(row.alias, payload.taskId, null);
        return 'applied';
      case 'key-change':
        this.deps.keyChange(row.alias, payload.statement);
        return 'applied';
      case 'unpair':
        // N4: it ends this pairing only, and only by its own id.
        if (payload.id === row.pairedId)
          this.deps.unpaired(row.alias, row.pairedId);
        return 'applied';
    }
  }

  private recordEvent(
    alias: string,
    p: Extract<LinkPayload, { kind: 'event' }>
  ): void {
    const event = p.event as Record<string, unknown>;
    const task = taskOf(event);
    if (task === null) return;
    if (p.for !== undefined)
      this.db
        .query(
          'INSERT OR IGNORE INTO sent (alias, message_id, task_id) VALUES (?, ?, ?)'
        )
        .run(alias, p.for, p.taskId);
    this.db
      .query(
        `INSERT INTO remote_tasks (alias, task_id, json, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(alias, task_id) DO UPDATE SET json = excluded.json, at = excluded.at`
      )
      .run(
        alias,
        p.taskId,
        JSON.stringify(task),
        this.deps.now().toISOString()
      );
    for (const fn of this.listeners) fn(alias);
  }

  private call(alias: string, method: string, path: string, body?: unknown) {
    return this.deps.serve(
      alias,
      new Request(`${LINK_BASE}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'a2a-version': '1.0',
          'a2a-extensions': `${ENVELOPE_URI}, ${WORK_URI}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
  }

  // A send runs through the A2A handler as the paired client, so every
  // inbound policy applies; the answer goes back as an `event`. A refusal
  // for load (429, 503) parks it for a later pass.
  private async served(
    row: LinkRow,
    p: Extract<LinkPayload, { kind: 'send' }>
  ): Promise<'applied' | 'parked'> {
    const messageId = p.message.messageId;
    const res = await this.call(row.alias, 'POST', '/message:send', {
      message: p.message,
      configuration: { returnImmediately: true },
    });
    if (res.status === 429 || res.status === 503) return 'parked';
    const body = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const task = body === null ? null : taskOf(body);
    if (res.ok && task !== null && typeof task['id'] === 'string') {
      const taskId = task['id'];
      this.db
        .query(
          'INSERT OR IGNORE INTO served (alias, task_id, for_id) VALUES (?, ?, ?)'
        )
        .run(row.alias, taskId, messageId);
      this.publishTask(row.alias, taskId, messageId, task);
      this.follow(row.alias, taskId, messageId);
      return 'applied';
    }
    const id = provisionalTaskId(messageId);
    const message =
      res.ok && body !== null && typeof body['message'] === 'object'
        ? body['message']
        : {
            messageId: `${id}-refused`,
            role: 'ROLE_AGENT',
            parts: [{ text: refusalText(body, res.status) }],
          };
    this.publish(row.alias, {
      kind: 'event',
      taskId: id,
      for: messageId,
      event: {
        task: {
          id,
          contextId: id,
          status: {
            state: res.ok ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_REJECTED',
            message,
          },
        },
      },
    } as LinkPayload);
    return 'applied';
  }

  private publishTask(
    alias: string,
    taskId: string,
    forId: string | null,
    task: Record<string, unknown>
  ): void {
    this.publish(alias, {
      kind: 'event',
      taskId,
      ...(forId === null ? {} : { for: forId }),
      event: { task },
    } as unknown as LinkPayload);
  }

  // The task as the paired client sees it now, published back.
  private async republish(
    alias: string,
    taskId: string,
    forId: string | null
  ): Promise<void> {
    const res = await this.call(
      alias,
      'GET',
      `/tasks/${encodeURIComponent(taskId)}`
    );
    if (!res.ok) return;
    const task = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (task === null || typeof task['id'] !== 'string') return;
    this.publishTask(alias, taskId, forId, task);
    const state = (task['status'] as { state?: string } | undefined)?.state;
    if (state !== undefined && TERMINAL.has(state))
      this.unfollow(alias, taskId);
  }

  // Each change to a task served over the link is published back.
  private follow(alias: string, taskId: string, forId: string): void {
    const key = `${alias}\n${taskId}`;
    if (this.watches.has(key)) return;
    let pending: Promise<void> = Promise.resolve();
    const stop = this.deps.watch(alias, taskId, () => {
      pending = pending.then(() => this.republish(alias, taskId, forId));
    });
    this.watches.set(key, stop);
  }

  private unfollow(alias: string, taskId: string): void {
    const key = `${alias}\n${taskId}`;
    this.watches.get(key)?.();
    this.watches.delete(key);
    this.db
      .query('DELETE FROM served WHERE alias = ? AND task_id = ?')
      .run(alias, taskId);
  }
}

// The receiver's refusal, in its own words, for the sender's thread.
function refusalText(
  body: Record<string, unknown> | null,
  status: number
): string {
  const err = body?.['error'] as { message?: unknown } | undefined;
  return typeof err?.message === 'string'
    ? err.message.slice(0, 300)
    : `the other side refused the message (HTTP ${status})`;
}
