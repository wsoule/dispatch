import { openSqliteDb, queryOne, readDocsConfig } from '@dispatch/core';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runsDir } from '../orchestrator/paths.js';
import type { DaemonDocsHost } from './host.js';
import { DocNotices } from './notices.js';
import { DocsService } from './service.js';
import { openDocsDb, SqliteDocStore } from './store.js';

const DOCS_SWEEP_MS = 60_000;

interface OpenDocs {
  service: DocsService;
  stop(): void;
}

// 0600 on the database and its WAL files, re-applied at every open.
function tightenModes(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    try {
      chmodSync(file, 0o600);
    } catch {
      // A filesystem without POSIX modes is not a reason to refuse docs.
    }
  }
}

// Other checkouts' docs.db files on this host whose recorded root is gone,
// because the checkout moved. A file it cannot read is skipped.
function findOrphanDocsDbs(runsParent: string, ownDbPath: string): string[] {
  if (!existsSync(runsParent)) return [];
  const out: string[] = [];
  for (const key of readdirSync(runsParent)) {
    const path = join(runsParent, key, 'docs.db');
    if (path === ownDbPath || !existsSync(path)) continue;
    try {
      const db = openSqliteDb(path);
      try {
        const row = queryOne<{ value: string }>(
          db,
          "SELECT value FROM meta WHERE key = 'root'"
        );
        if (row !== undefined && !existsSync(row.value)) out.push(path);
      } finally {
        db.close();
      }
    } catch {
      // Unreadable, or no meta table yet: not this build's to judge.
    }
  }
  return out.sort();
}

// Opens this project's docs.db. Any failure is the unavailable mode, never a
// failed boot: routes answer 503, prompts carry no docs, dispatch goes on.
export function openDocs(deps: {
  rootDir: string;
  host: DaemonDocsHost;
  ownerRef: string;
  dbPath?: string;
  sweepMs?: number;
}): OpenDocs {
  const path = deps.dbPath ?? join(runsDir(deps.rootDir), 'docs.db');
  const config = (): ReturnType<typeof readDocsConfig> =>
    readDocsConfig(deps.rootDir);
  const orphans = (): string[] =>
    findOrphanDocsDbs(dirname(dirname(path)), path);
  const common = { host: deps.host, ownerRef: deps.ownerRef, config, orphans };
  let service: DocsService;
  let store: SqliteDocStore | null = null;
  try {
    const { db, fts } = openDocsDb(path);
    store = new SqliteDocStore(db, fts, path);
    tightenModes(path);
    // The root this file belongs to, so a later scan can tell the checkout moved.
    store.setMeta('root', deps.rootDir);
    service = new DocsService({ store, ...common });
  } catch (err) {
    store?.close();
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`dispatchd: docs unavailable: ${reason}`);
    service = new DocsService({ store: null, unavailable: reason, ...common });
  }
  const notices = new DocNotices({
    service,
    host: deps.host,
    minutes: () => config().config.noticeMinutes,
  });
  service.attachNotices(notices);
  const unsubscribe = deps.host.onChange((c) => notices.onChange(c));
  const unsubscribeEnds = deps.host.onRunEnded((id) => notices.runEnded(id));
  const sweep = (): void => {
    try {
      service.sweep();
      notices.flush();
      if (service.available) tightenModes(path);
    } catch (err) {
      console.error('dispatchd: docs sweep failed', err);
    }
  };
  sweep();
  const timer = setInterval(sweep, deps.sweepMs ?? DOCS_SWEEP_MS);
  timer.unref();
  return {
    service,
    stop() {
      clearInterval(timer);
      unsubscribe();
      unsubscribeEnds();
      service.close();
    },
  };
}
