import { MEMORY_RECEIPT_FILE_BYTES } from '@dispatch/core';
import {
  MEMORY_ID_PATTERN,
  MEMORY_LIMITS,
  MemoryError,
  parseReceiptFile,
  renderReceiptFile,
} from '@dispatch/memory';
import type { MemoryEngine, MemoryStore, Principal } from '@dispatch/memory';
import { SYSTEM_ADDRESS } from '@dispatch/protocol';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { runsDir } from '../orchestrator/paths.js';
import type { ReceiptsStep } from '../receipts/exporter.js';

// Team memory in the receipt log: one file per team entry, written from
// memory.db and never read back; a restore turns files into proposals.

const MEMORY_REL = join('.dispatch', 'memory');
const UNAVAILABLE = 'memory store unavailable; .dispatch/memory left as it was';
// memory.db's record of the ids the step wrote, so it removes only its own files.
const EXPORTED_KEY = 'receipts_exported';

// Where `dispatch receipts restore` stages a log's team memory for the next boot.
export function memoryRestoreDir(rootDir: string): string {
  return join(runsDir(rootDir), 'memory-restore');
}

// How to clear a kept staging directory, named in problems and the restore report.
function clearHint(restoreDir: string): string {
  return `staged files are in ${restoreDir}; fix them and restart dispatchd to retry, or delete that directory once handled`;
}

// The entry id a `<id>.md` receipt file names, or null for any other name.
function receiptId(file: string): string | null {
  const id = file.endsWith('.md') ? file.slice(0, -3) : '';
  return MEMORY_ID_PATTERN.test(id) ? id : null;
}

function stagedFiles(restoreDir: string): string[] {
  if (!existsSync(restoreDir)) return [];
  return readdirSync(restoreDir).sort();
}

function readExported(store: MemoryStore): Set<string> {
  try {
    const parsed = JSON.parse(store.meta(EXPORTED_KEY) ?? '[]') as unknown;
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : []
    );
  } catch {
    return new Set();
  }
}

function writeExported(store: MemoryStore, ids: ReadonlySet<string>): void {
  const value = JSON.stringify([...ids].sort());
  if (store.meta(EXPORTED_KEY) !== value) store.setMeta(EXPORTED_KEY, value);
}

// Whether a restore already took `<id>.md` in: an entry holds its origin, or
// a proposal holding it was decided; an open one is not yet settled.
function restoredFrom(store: MemoryStore, id: string): boolean {
  const origin = `receipts:${id}`;
  if (store.entryByOrigin(origin) !== null) return true;
  const proposal = store.proposalByOrigin(origin);
  return proposal !== null && proposal.state !== 'open';
}

// Writes every team entry of `shared()`, in any state; a file is removed only
// when this store exported it or restored from it, even while a restore waits.
export function memoryReceiptsStep(
  shared: () => MemoryStore | null,
  restoreDir: string
): ReceiptsStep {
  return (dir) => {
    const store = shared();
    if (store === null)
      return { changed: 0, removed: 0, problems: [UNAVAILABLE] };
    const out = join(dir, MEMORY_REL);
    mkdirSync(out, { recursive: true });
    const exported = readExported(store);
    const wanted = new Set<string>();
    let changed = 0;
    for (const entry of store.listEntries({ scopes: ['team'] })) {
      if (entry.scope !== 'team') continue;
      wanted.add(entry.id);
      const text = renderReceiptFile(entry);
      const path = join(out, `${entry.id}.md`);
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
        writeFileSync(path, text);
        changed++;
      }
    }
    const pending = stagedFiles(restoreDir);
    const problems: string[] = [];
    let removed = 0;
    for (const file of readdirSync(out).sort()) {
      const id = receiptId(file);
      if (!file.endsWith('.md') || (id !== null && wanted.has(id))) continue;
      if (id !== null && (exported.has(id) || restoredFrom(store, id))) {
        rmSync(join(out, file));
        removed++;
      } else if (pending.length === 0) {
        problems.push(
          `receipt file ${file} was not written from this memory.db; kept. Delete it once no longer needed`
        );
      }
    }
    if (pending.length > 0)
      problems.push(
        `a staged memory restore is pending (${pending.join(', ')}); files this memory.db did not write are kept until it is applied`
      );
    writeExported(store, wanted);
    return { changed, removed, problems };
  };
}

export interface MemoryRestoreReport {
  restored: number;
  skipped: number;
  problems: { file: string; detail: string }[];
  // Where the kept staging directory is and how to clear it; null once removed.
  pending: string | null;
}

// Dispatch itself proposes restored lessons: agent trust, so a human or
// policy decides each one.
const RESTORER: Principal = {
  address: SYSTEM_ADDRESS,
  canDecide: false,
  kind: 'agent',
};

type Outcome = 'restored' | 'skipped' | { problem: string };

// One staged file: the frontmatter only suggests the kind, and the rest goes
// through the proposal path's own validation, de-duplication and policy.
async function restoreFile(
  engine: MemoryEngine,
  shared: MemoryStore,
  restoreDir: string,
  file: string
): Promise<Outcome> {
  const id = receiptId(file);
  if (id === null) return { problem: 'not a memory receipt file name' };
  const path = join(restoreDir, file);
  const stat = lstatSync(path);
  if (!stat.isFile()) return { problem: 'not a regular file' };
  if (stat.size > MEMORY_RECEIPT_FILE_BYTES)
    return { problem: `over ${MEMORY_RECEIPT_FILE_BYTES} bytes` };
  if (shared.getEntry(id) !== null) return 'skipped';
  const parsed = parseReceiptFile(readFileSync(path, 'utf8'), file);
  // A retired lesson stays retired: only live ones come back.
  if (parsed.status?.startsWith('retired') === true) return 'skipped';
  if (parsed.truncated)
    return {
      problem: `body: over the ${MEMORY_LIMITS.bodyBytes}-byte limit`,
    };
  const origin = `receipts:${id}`;
  if (
    shared.entryByOrigin(origin) !== null ||
    shared.proposalByOrigin(origin) !== null
  )
    return 'skipped';
  try {
    await engine.submitProposal(RESTORER, {
      action: 'add',
      scope: 'team',
      content: {
        scope: 'team',
        kind: parsed.kind,
        title: parsed.title,
        body: parsed.body,
        refs: [],
        epic: null,
        appliesTo: [],
        projectKey: null,
      },
      origin,
    });
    return 'restored';
  } catch (err) {
    if (!(err instanceof MemoryError)) throw err;
    // An equal lesson already stands, waits or was recently rejected.
    if (err.code === 'conflict') return 'skipped';
    return { problem: err.message };
  }
}

// Applies the receipt files the CLI staged; the directory goes once every
// file is handled. Null when nothing is staged or memory is unavailable.
export async function applyStagedMemoryRestore(
  engine: MemoryEngine | null,
  shared: MemoryStore | null,
  restoreDir: string
): Promise<MemoryRestoreReport | null> {
  if (engine === null || shared === null || !existsSync(restoreDir))
    return null;
  const report: MemoryRestoreReport = {
    restored: 0,
    skipped: 0,
    problems: [],
    pending: null,
  };
  for (const file of stagedFiles(restoreDir)) {
    const outcome = await restoreFile(engine, shared, restoreDir, file);
    if (outcome === 'restored') report.restored++;
    else if (outcome === 'skipped') report.skipped++;
    else report.problems.push({ file, detail: outcome.problem });
  }
  if (report.problems.length === 0)
    rmSync(restoreDir, { recursive: true, force: true });
  else report.pending = clearHint(restoreDir);
  return report;
}
