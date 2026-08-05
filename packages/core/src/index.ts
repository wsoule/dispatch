export const CORE_VERSION = '0.0.1';
export * from './types.js';
export {
  generateDraftId,
  generateFindingId,
  generateLedgerId,
  generateRunId,
  generateTaskId,
} from './ids.js';
export type {
  Finding,
  FindingRecommendation,
  FindingSeverity,
  FindingVerdict,
} from './findings.js';
export type { LedgerEntry, LedgerKind } from './ledger.js';
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
export { TaskStore, DISPATCH_DIR } from './store.js';
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
  loadConfig,
  updateConfig,
  ConfigError,
  DEFAULT_FIX_LOOP,
  DEFAULT_MODELS,
  DEFAULT_LINEAR,
  FIX_MODEL_TIERS,
  FIX_STRATEGIES,
  LINEAR_DIRECTIONS,
  MODEL_ROLES,
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
