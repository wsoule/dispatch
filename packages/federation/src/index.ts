// The federation code every daemon and the relay share: the license check,
// the log verification pipeline and the roster fold.
export {
  FREE_SEATS,
  LICENSE_PUBLIC_KEY,
  readLicenseKey,
  signLicense,
} from './license.js';
export type { License, LicenseState } from './license.js';
export { comparePositions } from './position.js';
export type { Position } from './position.js';
export {
  foldRoster,
  isCovered,
  KNOWN_ROSTER_PAIRS,
  LEGACY_WINDOW_MS,
  speaksForHandle,
} from './roster.js';
export type {
  Dismissal,
  FoldInput,
  KeyInfo,
  Paused,
  RevokedReplica,
  RosterMember,
  RosterOpRef,
  RosterView,
} from './roster.js';
export { verifyLog } from './verify.js';
export type { LogCursor, LogResult, PinnedKey } from './verify.js';
