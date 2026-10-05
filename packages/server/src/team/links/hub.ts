import { ENVELOPE_URI, WORK_URI } from '@dispatch/a2a';
import type { LinkPayload } from '@dispatch/a2a';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AsyncGitRunner } from '../../sync/worktree.js';
import { linkReplicaId, LinkService } from './service.js';
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
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(private readonly deps: LinkHubDeps) {
    mkdirSync(deps.dir, { recursive: true });
    this.db = new Database(join(deps.dir, 'hub.db'), {
      create: true,
      strict: true,
    });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (alias TEXT PRIMARY KEY, paired_id TEXT NOT NULL UNIQUE, remote TEXT NOT NULL, branch TEXT NOT NULL, sign_pub TEXT NOT NULL, seal_pub TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sent (alias TEXT NOT NULL, message_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY (alias, message_id));
      CREATE TABLE IF NOT EXISTS remote_tasks (alias TEXT NOT NULL, task_id TEXT NOT NULL, json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (alias, task_id));
      CREATE TABLE IF NOT EXISTS served (alias TEXT NOT NULL, task_id TEXT NOT NULL, for_id TEXT NOT NULL, PRIMARY KEY (alias, task_id));
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

  /** Records a link and starts serving it. */
  add(row: LinkRow): void {
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
    for (const table of ['links', 'sent', 'remote_tasks', 'served'])
      this.db.query(`DELETE FROM ${table} WHERE alias = ?`).run(alias);
  }

  private open(row: LinkRow): void {
    const service = new LinkService({
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

  private async passAll(): Promise<void> {
    for (const [alias, s] of [...this.services]) {
      if (this.stopped) return;
      try {
        await s.sync();
      } catch (err) {
        console.error(`a2a: link a2a:${alias} pass failed`, err);
      }
    }
    this.deps.changed?.();
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
        waiting: s?.waiting() ?? 0,
        lastExchangeAt: h?.lastExchangeAt ?? null,
        lastError: h?.lastError ?? null,
        unpublished: h?.unpublished ?? 0,
        problems: s?.problems() ?? [],
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
    if (from !== linkReplicaId(row.signPub)) return 'applied';
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
