import { generateLedgerId } from '@dispatch/core';
import type { LedgerEntry, LedgerKind } from '@dispatch/core';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Findings and decisions carried forward between tasks, one JSON line per
// write in `.dispatch/ledger.jsonl`. Entries are never edited in place.

export interface AddLedgerInput {
  epicId?: string | null;
  sourceTaskId?: string | null;
  kind: LedgerKind;
  title: string;
  detail: string;
  appliesTo?: string[];
  /** Serialized ActorRef of whoever wrote it. */
  authoredBy: string;
}

export interface LedgerListFilter {
  epicId?: string | null;
}

// How many times add() will re-roll an id before giving up. Far beyond what
// randomness needs; it only bounds a generator that keeps returning a taken id.
const MINT_ATTEMPTS = 32;

export class LedgerStore {
  private readonly file: string;
  private readonly generateId: (now: string) => string;
  // Ids already reported as colliding, so a damaged file logs once, not on
  // every read.
  private readonly reportedCollisions = new Set<string>();

  constructor(
    rootDir: string,
    generateId: (now: string) => string = generateLedgerId
  ) {
    this.file = join(rootDir, '.dispatch', 'ledger.jsonl');
    this.generateId = generateId;
  }

  // Same compaction contract as FindingStore.read(): keyed by id + createdAt, so
  // a duplicated line collapses but two entries sharing one id both survive.
  private read(): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    const byRecord = new Map<string, LedgerEntry>();
    const firstKeyForId = new Map<string, string>();
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as LedgerEntry;
        // Older lines pre-date authoredBy; default it so they stay loadable.
        const record: LedgerEntry = {
          ...parsed,
          authoredBy: parsed.authoredBy ?? '',
        };
        const key = `${record.id}\n${record.createdAt}`;
        const first = firstKeyForId.get(record.id);
        if (first === undefined) firstKeyForId.set(record.id, key);
        else if (first !== key) this.reportCollision(record.id);
        byRecord.set(key, record);
      } catch {
        // A hand-corrupted line costs itself, not the rest of the ledger.
      }
    }
    return [...byRecord.values()];
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
