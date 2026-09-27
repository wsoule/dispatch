// The federation code every daemon and the relay share: the license check and
// the log verification pipeline.
export {
  FREE_SEATS,
  LICENSE_PUBLIC_KEY,
  readLicenseKey,
  signLicense,
} from './license.js';
export type { License, LicenseState } from './license.js';
export { verifyLog } from './verify.js';
export type { LogCursor, LogResult, PinnedKey } from './verify.js';
