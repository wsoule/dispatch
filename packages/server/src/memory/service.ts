import { readMemoryConfig } from '@dispatch/core';
import type { MemoryConfigWarning, TaskStorePort } from '@dispatch/core';
import {
  createMemoryIds,
  MemoryEngine,
  MemoryError,
  openMemoryDb,
  SqliteMemoryStore,
} from '@dispatch/memory';
import type { MemoryStores } from '@dispatch/memory';
import { unwatchFile, watchFile } from 'node:fs';

import type { EventBus } from '../events.js';
import type { LedgerStorePort } from '../ledger.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { memoryDbPath, projectKeyOf } from '../orchestrator/paths.js';
import { DaemonMemoryHost } from './host.js';
import {
  importLedger as importLedgerRows,
  renderImportReport,
} from './ledgerImport.js';
import type { LedgerImportReport } from './ledgerImport.js';

interface MemoryHealth {
  available: boolean;
  reason: string | null;
  search: 'fts5' | 'like' | null;
  entries: number;
  openProposals: number;
  ledgerImport: LedgerImportReport | null;
  configWarnings: MemoryConfigWarning[];
  lastDecayAt: string | null;
}

export interface MemoryService {
  /** Null when memory.db would not open. */
  readonly engine: MemoryEngine | null;
  readonly shared: SqliteMemoryStore | null;
  readonly host: DaemonMemoryHost;
  /** Throws MemoryError('unavailable') with the open failure. */
  requireEngine(): MemoryEngine;
  importLedger(opts?: { dryRun?: boolean }): LedgerImportReport | null;
  lastLedgerImport(): LedgerImportReport | null;
  health(): MemoryHealth;
  close(): void;
}

export interface OpenMemoryDeps {
  rootDir: string;
  store: TaskStorePort;
  orchestrator: Pick<Orchestrator, 'taskIdOfRun' | 'getRun'>;
  events: EventBus;
  ledgerStore: LedgerStorePort;
  dbPath?: string;
  /** The files backend's ledger.jsonl, re-imported when a pull rewrites it. */
  watchLedgerFile?: string | null;
  now?: () => Date;
}

const LAST_IMPORT_KEY = 'ledger-import:last';

// The last committed import report, or null when none was stored or it no longer parses.
function readLastImport(
  shared: SqliteMemoryStore | null
): LedgerImportReport | null {
  const raw = shared?.meta(LAST_IMPORT_KEY) ?? null;
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as LedgerImportReport;
  } catch {
    return null;
  }
}

/**
 * Opens memory.db and the engine over it, and keeps the ledger's lessons
 * imported. A database that will not open leaves memory unavailable, never a failed boot.
 */
export function openMemory(deps: OpenMemoryDeps): MemoryService {
  const now = deps.now ?? (() => new Date());
  const host = new DaemonMemoryHost({
    projectKey: projectKeyOf(deps.rootDir),
    store: deps.store,
    orchestrator: deps.orchestrator,
    events: deps.events,
    now,
  });
  let shared: SqliteMemoryStore | null = null;
  let reason: string | null = null;
  try {
    shared = new SqliteMemoryStore(
      openMemoryDb(deps.dbPath ?? memoryDbPath(deps.rootDir))
    );
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    console.error(`dispatchd: memory unavailable: ${reason}`);
  }
  const unavailable = () =>
    new MemoryError('unavailable', `memory unavailable: ${reason}`, 'store');
  const stores: MemoryStores = {
    shared: () => {
      if (shared === null) throw unavailable();
      return shared;
    },
    personal: () => {
      throw new MemoryError(
        'unavailable',
        'personal memory is not available',
        'store'
      );
    },
  };
  const config = () => readMemoryConfig(deps.rootDir).config;
  const engine =
    shared === null ? null : new MemoryEngine({ stores, host, config });
  const ids = createMemoryIds();
  let last = readLastImport(shared);

  // A dry run reports without writing and leaves the stored report alone.
  const importLedger = (
    opts: { dryRun?: boolean } = {}
  ): LedgerImportReport | null => {
    if (shared === null) return null;
    const snapshot = deps.ledgerStore.listSafe();
    const report = importLedgerRows({
      rows: snapshot.records,
      damaged: snapshot.errors.length,
      store: shared,
      ids,
      now: now(),
      cutoverAt: shared.meta('ledger-cutover-at'),
      dryRun: opts.dryRun,
    });
    if (opts.dryRun === true) return report;
    last = report;
    shared.setMeta(LAST_IMPORT_KEY, JSON.stringify(report));
    if (report.outcome === 'MISMATCH')
      console.error(
        `dispatchd: ledger import MISMATCH\n${renderImportReport(report)}`
      );
    if (report.memory.imported + report.memory.proposed > 0)
      host.changed({ scope: 'team' });
    return report;
  };

  // A failed import is logged and retried on the next change, never thrown
  // into the ledger writer that broadcast it.
  const importQuietly = () => {
    try {
      importLedger();
    } catch (err) {
      console.error('dispatchd: ledger import failed', err);
    }
  };
  const unsubscribe = deps.events.subscribe((event) => {
    if (event.type === 'ledger.changed') importQuietly();
  });
  const watched = deps.watchLedgerFile ?? null;
  if (watched !== null)
    watchFile(watched, { interval: 5000, persistent: false }, importQuietly);

  return {
    engine,
    shared,
    host,
    requireEngine: () => {
      if (engine === null) throw unavailable();
      return engine;
    },
    importLedger,
    lastLedgerImport: () => last,
    health: () => ({
      available: shared !== null,
      reason,
      search: shared?.search ?? null,
      entries: shared?.countEntries() ?? 0,
      openProposals: shared?.countOpenProposals() ?? 0,
      ledgerImport: last,
      configWarnings: readMemoryConfig(deps.rootDir).warnings,
      lastDecayAt: shared?.meta('last_decay_at') ?? null,
    }),
    close: () => {
      unsubscribe();
      if (watched !== null) unwatchFile(watched, importQuietly);
      shared?.close();
    },
  };
}
