import { generateLedgerId, scanLedgerJsonl } from '@dispatch/core';
import type {
  AddLedgerInput,
  LedgerEntry,
  LedgerListFilter,
} from '@dispatch/core';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Findings and decisions carried forward between tasks, one JSON line per
// write in `.dispatch/ledger.jsonl`. Entries are never edited in place.

// Re-exported rather than re-declared, same as findings.ts — core owns these
// shapes so both backends take identical inputs.
export type { AddLedgerInput, LedgerListFilter } from '@dispatch/core';

/**
 * The ledger surface every backend answers — same seam as `FindingStorePort`
 * in findings.ts, and satisfied structurally by core's `SqliteLedgerStore`
 * for the same reasons. Deliberately the intersection of the two backends:
 * `SqliteLedgerStore` also has a `get(id)`, which nothing in the daemon calls
 * and the JSONL store never grew.
 */
export interface LedgerStorePort {
  add(input: AddLedgerInput): LedgerEntry;
  list(filter?: LedgerListFilter): LedgerEntry[];
  entriesFor(taskId: string, epicId: string | null): LedgerEntry[];
}

// How many times add() will re-roll an id before giving up. Far beyond what
// randomness needs; it only bounds a generator that keeps returning a taken id.
const MINT_ATTEMPTS = 32;

export class LedgerStore implements LedgerStorePort {
  private readonly file: string;
  private readonly generateId: (now: string) => string;
  // Ids already reported as colliding, so a damaged file logs once, not on
  // every read.
  private readonly reportedCollisions = new Set<string>();
  // Same idea for lines that parse but are not entries, keyed by the line
  // itself.
  private readonly reportedInvalidLines = new Set<string>();

  constructor(
    rootDir: string,
    generateId: (now: string) => string = generateLedgerId
  ) {
    this.file = join(rootDir, '.dispatch', 'ledger.jsonl');
    this.generateId = generateId;
  }

  // Same compaction contract as FindingStore.read(), and for the same reason
  // the same shared implementation: keyed by id + createdAt, so a duplicated
  // line collapses but two entries sharing one id both survive. See the note
  // on FindingStore.read() about why the rule lives in `@dispatch/core`.
  private read(): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    const scan = scanLedgerJsonl(readFileSync(this.file, 'utf8'));
    for (const line of scan.invalidLines) this.reportInvalidLine(line);
    for (const id of scan.duplicateIds) this.reportCollision(id);
    return scan.records;
  }

  // A repeated id with a different createdAt is two entries, not a duplicate
  // line — both are kept, since a lost entry is a lost constraint or hazard.
  private reportCollision(id: string): void {
    if (this.reportedCollisions.has(id)) return;
    this.reportedCollisions.add(id);
    console.error(
      `dispatchd: ledger id ${id} belongs to more than one entry in ${this.file}. ` +
        'Both are kept; edit the file to give the newer one a distinct id.'
    );
  }

  // Dropped rather than served: entriesFor() injects entries into task prompts,
  // where a shapeless one either throws or reads as `undefined`.
  private reportInvalidLine(line: string): void {
    if (this.reportedInvalidLines.has(line)) return;
    this.reportedInvalidLines.add(line);
    console.error(
      `dispatchd: skipping a ledger line missing required fields in ${this.file}: ${line.slice(0, 200)}`
    );
  }

  // Mirrors ScopeRequestRegistry.mintId: re-roll until the id is one no entry
  // in the file already uses, since a 6-hex-char space collides in practice.
  private mintId(now: string): string {
    const taken = new Set(this.read().map((e) => e.id));
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
      const id = this.generateId(now);
      if (!taken.has(id)) return id;
    }
    throw new Error(
      `could not mint an unused ledger id in ${MINT_ATTEMPTS} attempts`
    );
  }

  private append(record: LedgerEntry): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  add(input: AddLedgerInput): LedgerEntry {
    const now = new Date().toISOString();
    const record: LedgerEntry = {
      id: this.mintId(now),
      epicId: input.epicId ?? null,
      sourceTaskId: input.sourceTaskId ?? null,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      appliesTo: input.appliesTo ?? [],
      createdAt: now,
      authoredBy: input.authoredBy,
    };
    this.append(record);
    return record;
  }

  list(filter: LedgerListFilter = {}): LedgerEntry[] {
    if (filter.epicId === undefined) return this.read();
    return this.read().filter((e) => e.epicId === filter.epicId);
  }

  // What a dispatched task should see: entries aimed at it directly, plus
  // untargeted entries scoped to its epic or project-wide (epicId null).
  entriesFor(taskId: string, epicId: string | null): LedgerEntry[] {
    return this.read().filter(
      (e) =>
        e.appliesTo.includes(taskId) ||
        (e.appliesTo.length === 0 && (e.epicId === null || e.epicId === epicId))
    );
  }
}
