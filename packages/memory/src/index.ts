export const MEMORY_PACKAGE_VERSION = '0.1.0';
export { memoryContentHash, normalizeTitle } from './contentHash.js';
export { MEMORY_ERROR_STATUS, MemoryError } from './errors.js';
export type { MemoryErrorCode } from './errors.js';
export {
  HANDLE_PATTERN,
  MEMORY_ID_PATTERN,
  memoryHandle,
  parseMemoryRef,
  PROPOSAL_ID_PATTERN,
} from './handle.js';
export type { MemoryRef } from './handle.js';
export { cutUtf8, MEMORY_LIMITS, utf8Bytes } from './limits.js';
export { displayState, MEMORY_KINDS, MEMORY_SCOPES } from './types.js';
export type {
  DisplayState,
  IndexContext,
  MemoryChange,
  MemoryDecay,
  MemoryEntry,
  MemoryKind,
  MemoryProposal,
  MemoryScope,
  MemoryStatus,
  MemoryStatusReason,
  MemoryTrust,
  Operator,
  PolicyDecision,
  Principal,
  ProposalAction,
  ProposalContent,
  ProposalState,
  RecallVia,
  Revision,
  RevisionCause,
  SharedScope,
} from './types.js';
export {
  checkTarget,
  validateMemoryInput,
  validateQuery,
  validateReason,
} from './validate.js';
export type { MemoryWriteInput, ValidMemoryInput } from './validate.js';
export {
  createMemoryIds,
  insertFresh,
  newMemoryEntry,
  newProposal,
} from './records.js';
export type { MemoryIds, NewEntryInput, NewProposalInput } from './records.js';
export {
  MEMORY_DB_VERSION,
  MEMORY_MIN_READER_VERSION,
  openMemoryDb,
} from './schema.js';
export type { SearchMode } from './schema.js';
export { SqliteMemoryStore } from './sqliteStore.js';
export type {
  EntryFilter,
  IngestProblem,
  IngestProblemRow,
  MemoryStore,
  RecallRow,
  SearchHit,
} from './store.js';
export { queryTerms, relevanceTerms, STOPWORDS } from './query.js';
export {
  compareRank,
  KIND_CLASS,
  rankEntries,
  reaches,
  specificity,
} from './rank.js';
export type { RankContext, Ranked } from './rank.js';
export { estimateTokens, indexLine, reachTags, renderIndex } from './render.js';
export type {
  IndexVariant,
  RenderedIndex,
  RenderIndexOptions,
} from './render.js';
export {
  isA2AAgent,
  personalIdentityFor,
  proposalVisible,
  refuseA2A,
  sharedScopesFor,
} from './visibility.js';
export type { Viewer } from './visibility.js';
export type { MemoryHost, MemoryStores } from './host.js';
export { MemoryEngine } from './engine.js';
export type {
  EntryView,
  IndexRequest,
  ListQuery,
  RankedIndex,
  ReadResult,
  SearchQuery,
  SearchResult,
} from './engine.js';
export {
  CLAUDE_INDEX_HEADER,
  CLAUDE_TYPE_FOR_KIND,
  diffExport,
  kindFromClaudeType,
  newIndexLines,
  parsedHash,
  parseMemoryFile,
  projectOnlyForClaudeType,
  renderClaudeIndex,
  renderTopicFile,
  topicFileName,
} from './claudeFiles.js';
export type {
  ExportChange,
  ManifestRow,
  ParsedMemoryFile,
  ScannedFile,
} from './claudeFiles.js';
