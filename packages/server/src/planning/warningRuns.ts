import { loadConfig } from '@dispatch-foo/core';
import {
  buildDigests,
  type Digest,
  planWarnings,
  type WarningMemory,
} from '@dispatch/planning';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  type AllocationDeps,
  DAILY_HOUR,
  localDay,
  planningNow,
} from './dailyAllocation.js';

// The daily digest (Better Tracker's warnings): when config.yml's
// `planning.warnings` is `notify`, once a day from DAILY_HOUR the daemon
// works out which milestones are overdue, at risk, failing the rubric soon or
// blocking allocation (@dispatch/planning's planWarnings), remembers what it
// already said so a notice repeats only when something changes (or, overdue,
// every overdueRepeatDays), and builds one digest per project lead or watcher
// (buildDigests). Each digest is logged here, and POSTed to the notifications
// webhook when one is set (the Slack seam), as `planning.digest`.

/** How a logged digest left the daemon. */
type DigestDelivery = 'webhook' | 'logged' | 'failed';

/** One logged digest: what was sent to whom, and how. */
export interface DigestRecord {
  id: number;
  at: string;
  delivery: DigestDelivery;
  /** Why delivery failed; null otherwise. */
  error: string | null;
  digest: Digest;
}

/** How many digests the log keeps. */
const KEEP_DIGESTS = 500;

/** Warning memory and the digest log of one project, in one SQLite file. */
export class WarningStore {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (subject TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS digests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        day TEXT NOT NULL,
        delivery TEXT NOT NULL,
        error TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (day TEXT PRIMARY KEY, at TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  memory(): WarningMemory[] {
    return this.db
      .query<{ json: string }, []>('SELECT json FROM memory')
      .all()
      .map((row) => JSON.parse(row.json) as WarningMemory);
  }

  saveMemory(rows: readonly WarningMemory[]): void {
    const put = this.db.query(
      'INSERT OR REPLACE INTO memory (subject, json) VALUES (?, ?)'
    );
    this.db.transaction(() => {
      for (const row of rows) {
        put.run(`${row.subjectKind}:${row.subjectId}`, JSON.stringify(row));
      }
    })();
  }

  logDigest(
    digest: Digest,
    at: string,
    delivery: DigestDelivery,
    error: string | null
  ): void {
    this.db
      .query(
        'INSERT INTO digests (at, day, delivery, error, json) VALUES (?, ?, ?, ?, ?)'
      )
      .run(at, digest.day, delivery, error, JSON.stringify(digest));
    this.db
      .query(
        'DELETE FROM digests WHERE seq NOT IN (SELECT seq FROM digests ORDER BY seq DESC LIMIT ?)'
      )
      .run(KEEP_DIGESTS);
  }

  /** Logged digests, newest first. */
  digests(limit = 100): DigestRecord[] {
    return this.db
      .query<
        {
          seq: number;
          at: string;
          delivery: DigestDelivery;
          error: string | null;
          json: string;
        },
        [number]
      >(
        'SELECT seq, at, delivery, error, json FROM digests ORDER BY seq DESC LIMIT ?'
      )
      .all(limit)
      .map((row) => ({
        id: row.seq,
        at: row.at,
        delivery: row.delivery,
        error: row.error,
        digest: JSON.parse(row.json) as Digest,
      }));
  }

  /** Whether today's run already happened (empty runs count too). */
  ranOn(day: string): boolean {
    return (
      this.db
        .query<{ day: string }, [string]>('SELECT day FROM runs WHERE day = ?')
        .get(day) !== null
    );
  }

  markRan(day: string, at: string): void {
    this.db
      .query('INSERT OR REPLACE INTO runs (day, at) VALUES (?, ?)')
      .run(day, at);
  }
}

export interface WarningDeps extends Pick<
  AllocationDeps,
  'rootDir' | 'store' | 'actor' | 'people' | 'now'
> {
  warnings: WarningStore;
  /** Test seam. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/** The JSON body a digest webhook POST carries. */
interface DigestPayload {
  event: 'planning.digest';
  sentAt: string;
  project: { rootDir: string };
  digest: Digest;
}

/**
 * Plans today's warnings, remembers them, builds the digests and delivers
 * each (webhook when configured, else logged only). Returns what was logged.
 */
export async function runWarnings(deps: WarningDeps): Promise<DigestRecord[]> {
  const planning = planningNow(deps);
  const { config, snapshot, ctx, assessments, plan } = planning;
  const warningPlan = planWarnings({
    snapshot,
    ctx,
    assessments,
    allocationPlan: plan,
    memory: deps.warnings.memory(),
    watcherUserIds: config.planning?.watchers ?? [],
  });
  deps.warnings.saveMemory(warningPlan.memory);
  const digests = buildDigests({
    snapshot,
    ctx,
    assessments,
    notices: warningPlan.notices,
    appUrl: 'dispatch://',
    workspaceId: deps.rootDir,
  });
  const at = ctx.now;
  const webhook = config.notifications.webhook;
  const send = deps.fetch ?? globalThis.fetch;
  for (const digest of digests) {
    if (webhook === undefined) {
      deps.warnings.logDigest(digest, at, 'logged', null);
      continue;
    }
    const payload: DigestPayload = {
      event: 'planning.digest',
      sentAt: at,
      project: { rootDir: deps.rootDir },
      digest,
    };
    try {
      const res = await send(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      deps.warnings.logDigest(
        digest,
        at,
        res.ok ? 'webhook' : 'failed',
        res.ok ? null : `HTTP ${res.status}`
      );
    } catch (err) {
      deps.warnings.logDigest(digest, at, 'failed', (err as Error).message);
    }
  }
  deps.warnings.markRan(ctx.today, at);
  return deps.warnings.digests(digests.length);
}

/** Whether today's digest run is due: asked for, 8:00 or later, not yet run. */
export function dailyWarningsDue(deps: WarningDeps, now: Date): boolean {
  if (loadConfig(deps.rootDir).planning?.warnings !== 'notify') return false;
  if (now.getHours() < DAILY_HOUR) return false;
  return !deps.warnings.ranOn(localDay(now));
}
