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
}

export interface LedgerListFilter {
  epicId?: string | null;
}

export class LedgerStore {
  private readonly file: string;

  constructor(rootDir: string) {
    this.file = join(rootDir, '.dispatch', 'ledger.jsonl');
  }

  // Same compaction contract as FindingStore.read(): last write per id wins.
  private read(): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    const byId = new Map<string, LedgerEntry>();
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const record = JSON.parse(line) as LedgerEntry;
        byId.set(record.id, record);
      } catch {
        // A hand-corrupted line costs itself, not the rest of the ledger.
      }
    }
    return [...byId.values()];
  }

  private append(record: LedgerEntry): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  add(input: AddLedgerInput): LedgerEntry {
    const now = new Date().toISOString();
    const record: LedgerEntry = {
      id: generateLedgerId(now),
      epicId: input.epicId ?? null,
      sourceTaskId: input.sourceTaskId ?? null,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      appliesTo: input.appliesTo ?? [],
      createdAt: now,
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
