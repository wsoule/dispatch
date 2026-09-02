export const CORE_VERSION = '0.24.0';
export * from './status.js';
export * from './types.js';
export {
  generateDraftId,
  generateFindingId,
  generateLedgerId,
  generateRunId,
  generateTaskId,
  isTaskId,
  TASK_ID_PATTERN,
} from './ids.js';
export {
  FINDING_RECOMMENDATIONS,
  FINDING_SEVERITIES,
  FINDING_VERDICTS,
} from './findings.js';
export { LEDGER_KINDS } from './ledger.js';
export type {
  AddFindingInput,
  Finding,
  FindingListFilter,
  FindingRecommendation,
  FindingSeverity,
  FindingUpdatePatch,
  FindingVerdict,
} from './findings.js';
export type {
  AddLedgerInput,
  LedgerEntry,
  LedgerKind,
  LedgerListFilter,
} from './ledger.js';
export type { CommandEvidence, MutationEvidence } from './evidence.js';
export {
  claimConflictsWithWrites,
  schedulableBatch,
  tasksConflict,
} from './conflicts.js';
export {
  ActorRefError,
  formatActorRef,
  isValidAssignee,
  parseActorRef,
  UNASSIGNED,
} from './actor.js';
export type { ActorKind, ActorRef } from './actor.js';
export { slugify } from './slug.js';
export { describeValue } from './describe.js';
export { isOutstanding } from './timeline.js';
export {
  untrustedBlock,
  untrustedFenced,
  untrustedInline,
} from './untrusted.js';
export {
  parseTaskFile,
  serializeTaskFile,
  TaskParseError,
  appendActivity,
  appendAmendment,
  getSection,
  removeSection,
  setSection,
} from './taskfile.js';
export type { Amendment } from './taskfile.js';
export {
  applyUpdatePatch,
  DISPATCH_DIR,
  ensureProjectConfig,
  ensureProjectGitignore,
  newTaskDoc,
  TaskStore,
} from './store.js';
export type { TaskStorePort } from './store.js';
export {
  attachDispatchDb,
  dbVersion,
  DISPATCH_DB_VERSION,
  dispatchDbPath,
  openDispatchDb,
  sqliteDriver,
  SqliteRowError,
} from './sqliteDb.js';
export type {
  SqliteDatabase,
  SqliteDriver,
  SqliteStatement,
  SqlValue,
} from './sqliteDb.js';
export { SqliteTaskStore } from './sqliteTaskStore.js';
export {
  SqliteEvidenceStore,
  SqliteFindingStore,
  SqliteLedgerStore,
} from './sqliteRecords.js';
export { initProjectStores, openProjectStores } from './storeBackend.js';
export type {
  OpenStoresOptions,
  ProjectStores,
  SqliteRecordStores,
  TaskStoreBackend,
} from './storeBackend.js';
export {
  formatMigrationReport,
  hasLegacyState,
  importLegacyProject,
  LEGACY_SOURCES,
  totalImported,
} from './migrate.js';
export type {
  MigrationProblem,
  MigrationReport,
  MigrationTally,
  RetainedSource,
  RowCounts,
} from './migrate.js';
export {
  formatRetireReport,
  receiptLogDir,
  retireLegacySources,
} from './retire.js';
export type { RetiredSource, RetireOptions, RetireReport } from './retire.js';
export { materializeReceipts, restoreReceipts } from './receipts.js';
export type {
  ReceiptsExport,
  ReceiptsProblem,
  ReceiptsRestore,
  ReceiptsTally,
} from './receipts.js';
export { scanFindingsJsonl, scanLedgerJsonl } from './jsonlRecords.js';
export type { JsonlScan } from './jsonlRecords.js';
export { readProjectBackend, writeProjectBackend } from './storage.js';
export { mergeTaskFile } from './mergeTask.js';
export { mergeTeamFile } from './mergeTeam.js';
export type {
  CreateInput,
  UpdatePatch,
  ListFilter,
  ListSafeError,
  ListSafeResult,
} from './store.js';
export {
  readyTasks,
  dispatchableTasks,
  isDone,
  isSatisfiedForDispatch,
  PRIORITY_ORDER,
  findDependencyCycles,
  computeStack,
} from './graph.js';
export type { TaskStack } from './graph.js';
export {
  AGE_HORIZON_DAYS,
  DEFAULT_QUEUE_WEIGHTS,
  isQueueWeight,
  QUEUE_FACTOR_KEYS,
  QUEUE_FACTORS,
  rankTasks,
  UNBLOCKING_HALF_VALUE,
} from './scoring.js';
export type {
  QueueFactorInfo,
  QueueWeights,
  RankOptions,
  ScoredTask,
  ScoreFactor,
  ScoreFactorKey,
} from './scoring.js';
export {
  loadConfig,
  updateConfig,
  ConfigError,
  DEFAULT_FIX_LOOP,
  DEFAULT_MODELS,
  DEFAULT_LINEAR,
  DEFAULT_RECEIPTS,
  DEFAULT_REPO_DIGEST,
  FIX_MODEL_TIERS,
  FIX_STRATEGIES,
  LINEAR_DIRECTIONS,
  MODEL_ROLES,
  queueWeights,
} from './config.js';
export type {
  CartoConfig,
  CartoMode,
  ConfigPatch,
  DispatchConfig,
  EscalationStep,
  FixLoopConfig,
  LinearConfig,
  ModelConfig,
  OrchestratorConfig,
  ReceiptsConfig,
  QueueConfig,
  QueueWeightsResult,
  RepoDigestConfig,
  VerifyConfig,
  VerifyStep,
} from './config.js';
export {
  clearCredential,
  clearProjectCredential,
  credentialsPath,
  readCredentials,
  resolveLinearApiKey,
  writeCredential,
  writeProjectCredential,
} from './credentials.js';
export type {
  CredentialName,
  CredentialSource,
  CredentialsFile,
  ProjectCredentials,
} from './credentials.js';
export {
  DEFAULT_STATUS_MAP,
  externalId,
  issueFromTask,
  LINEAR_EXTERNAL_PREFIX,
  parseExternal,
  priorityFromLinear,
  priorityToLinear,
  resolveConflict,
  resolveWorkflowState,
  statusFromState,
  taskCreateFromIssue,
  taskPatchFromIssue,
} from './linearMap.js';
export type {
  IssueMapContext,
  LinearIssue,
  LinearIssueInput,
  LinearLabel,
  LinearWorkflowState,
  TaskMapContext,
} from './linearMap.js';
export { normalizeProjectPath } from './projectPath.js';
export {
  readRegistry,
  registryPath,
  upsertRegisteredProject,
} from './registry.js';
export type { RegisteredProject } from './registry.js';
export {
  handleFromEmail,
  parseTeam,
  serializeTeam,
  TeamParseError,
  upsertMember,
} from './team.js';
export type { TeamMember } from './team.js';
export { ActorContext } from './actorContext.js';
export type { GitReader } from './actorContext.js';
export {
  checkMergeDriverSetup,
  checkTeamMergeDriverSetup,
  GITATTRIBUTES_LINE,
  isMergeDriverResolvable,
  mergeGitAttributes,
  registerMergeDriverGitConfig,
  registerTeamMergeDriverGitConfig,
  TEAM_GITATTRIBUTES_LINE,
  writeGitAttributes,
} from './mergeDriverSetup.js';
