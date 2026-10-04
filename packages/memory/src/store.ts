import type { Address } from '@dispatch/protocol';

import type { ManifestRow } from './claudeFiles.js';
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

// A file a Claude memory scan refused; `content` keeps what the owner may accept.
export interface IngestProblemRow {
  id: string;
  lineage: string;
  file: string;
  reason: string;
  size: number;
  sha256: string;
  content: string | null;
  at: string;
}

export type IngestProblem = Omit<IngestProblemRow, 'sha256' | 'content'>;

// One line of a human's personal activity: what their runs and agents did to
// their memory, which the Inbox lists with an Undo.
export interface ActivityRow {
  id: string;
  at: string;
  kind:
    | 'saved'
    | 'edited'
    | 'retired'
    | 'ingested'
    | 'throttled'
    | 'ingest-problem';
  memoryId: string | null;
  runId: string | null;
  summary: string;
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
  /** `at` stamps the revision; now by default (decay passes its sweep's time). */
  updateEntry(
    entry: MemoryEntry,
    by: Address,
    cause: RevisionCause,
    at?: string
  ): void;
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
  /** Deletes recall rows from before `beforeIso`; returns how many went. */
  pruneRecalls(beforeIso: string): number;
  /** Pulls entry and revision stamps later than `nowIso` back to it. */
  clampFutureStamps(nowIso: string): void;
  isTombstoned(origin: string): boolean;
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
  countEntries(): number;
  appendActivity(row: ActivityRow): void;
  /** Rows after `sinceIso`, newest first. */
  activitySince(sinceIso: string, limit: number): ActivityRow[];
  hasActivitySince(kind: ActivityRow['kind'], sinceIso: string): boolean;
  /** Revisions `by` wrote after `sinceIso` with one of `causes`. */
  countRevisionsBy(
    by: Address,
    sinceIso: string,
    causes: readonly RevisionCause[]
  ): number;
  insertProposal(p: MemoryProposal): void;
  updateProposal(p: MemoryProposal): void;
  getProposal(id: string): MemoryProposal | null;
  proposalByOrigin(origin: string): MemoryProposal | null;
  listProposals(filter?: { states?: ProposalState[] }): MemoryProposal[];
  countOpenProposals(): number;
  /** Entries of `scopes` whose content hash is `hash`, in any state. */
  entriesByContentHash(
    hash: string,
    scopes: readonly MemoryScope[]
  ): MemoryEntry[];
  /** Proposals whose content hash is `hash`, in any state. */
  proposalsByContentHash(hash: string): MemoryProposal[];
  openRetireFor(target: string): MemoryProposal | null;
  /** Proposals `author` made after `sinceIso`, except `ledger:`, `sync:` and `receipts:` origins. */
  countProposalsBy(author: Address, sinceIso: string): number;
  manifest(lineage: string): ManifestRow[];
  /** Replaces every row of `lineage` in one transaction. */
  replaceManifest(lineage: string, rows: readonly ManifestRow[]): void;
  putManifestRow(row: ManifestRow): void;
  deleteManifestRow(lineage: string, file: string): void;
  manifestLineages(): string[];
  addIngestProblem(row: IngestProblemRow): void;
  /** Newest first, without the kept content. */
  ingestProblems(limit: number): IngestProblem[];
  /** Removes the problem and returns it whole, so a failed accept can put it back. */
  takeIngestProblem(id: string): IngestProblemRow | null;
  /** Writes a 0600 copy to `path`, replacing the previous one; not inside a transaction. */
  backup(path: string): void;
  close(): void;
}
