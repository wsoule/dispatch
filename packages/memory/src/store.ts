import type { Address } from '@dispatch/protocol';

import type { SearchMode } from './schema.js';
import type {
  DisplayState,
  MemoryEntry,
  MemoryKind,
  MemoryProposal,
  MemoryScope,
  ProposalState,
  RecallVia,
  Revision,
  RevisionCause,
} from './types.js';

export interface EntryFilter {
  scopes?: MemoryScope[];
  kinds?: MemoryKind[];
  states?: DisplayState[];
  projectKey?: string;
  ids?: string[];
}

export interface SearchHit {
  entry: MemoryEntry;
  score: number;
  snippet: string;
}

export interface RecallRow {
  memoryId: string;
  runId: string;
  via: RecallVia;
  at: string;
}

// One memory database: entries with their revisions, recalls and tombstones, plus proposals.
export interface MemoryStore {
  readonly search: SearchMode;
  /** Runs `fn` in BEGIN IMMEDIATE; a nested call joins the outer transaction. */
  transaction<T>(fn: () => T): T;
  getEntry(id: string): MemoryEntry | null;
  entriesByHandle(handle: string): MemoryEntry[];
  entryByOrigin(origin: string): MemoryEntry | null;
  listEntries(filter?: EntryFilter): MemoryEntry[];
  searchEntries(
    terms: readonly string[],
    match: 'all' | 'any',
    filter: EntryFilter,
    limit: number
  ): SearchHit[];
  insertEntry(entry: MemoryEntry, by: Address, cause: RevisionCause): void;
  /** Refuses unless `entry.rev === current.rev + 1`. */
  updateEntry(entry: MemoryEntry, by: Address, cause: RevisionCause): void;
  deleteEntry(id: string, by: Address, at: string): void;
  revisions(id: string): Revision[];
  recordRecall(
    memoryId: string,
    input: {
      runId: string | null;
      via: RecallVia;
      at: string;
      countsAsUse: boolean;
    }
  ): void;
  recallsForRun(runId: string): RecallRow[];
  isTombstoned(origin: string): boolean;
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
  countEntries(): number;
  insertProposal(p: MemoryProposal): void;
  updateProposal(p: MemoryProposal): void;
  getProposal(id: string): MemoryProposal | null;
  proposalByOrigin(origin: string): MemoryProposal | null;
  listProposals(filter?: { states?: ProposalState[] }): MemoryProposal[];
  countOpenProposals(): number;
  close(): void;
}
