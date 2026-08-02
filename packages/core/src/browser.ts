// The browser-safe entry point. Everything reachable from here is pure — no
// `node:*` import — so the desktop webview can import it in dev and in a build.

export * from './types.js';
export * from './configTypes.js';
export * from './linearMap.js';
export type { Finding, FindingSeverity, FindingVerdict } from './findings.js';
export type { LedgerEntry, LedgerKind } from './ledger.js';
export {
  computeStack,
  dispatchableTasks,
  findDependencyCycles,
  isDone,
  isSatisfiedForDispatch,
  PRIORITY_ORDER,
  readyTasks,
} from './graph.js';
export type { TaskStack } from './graph.js';
export { slugify } from './slug.js';
export type {
  CreateInput,
  ListFilter,
  ListSafeError,
  ListSafeResult,
  UpdatePatch,
} from './store.js';
