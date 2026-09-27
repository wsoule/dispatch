// The federation wire: canonical JSON, Ed25519, prev chains and HPKE
// sealing. Only this subpath imports node:crypto; the package root never does.
export { buildOp, verifyEntry } from './chain.js';
export type { ChainHead } from './chain.js';
export { b64u, crockford32, fromB64u, sha256Hex } from './encoding.js';
export { fingerprint } from './fingerprint.js';
export { compareHlc, hlcWallMs, MAX_HLC_COUNTER, parseOpHlc } from './hlc.js';
export type { ParsedHlc } from './hlc.js';
export { canonicalize, CanonicalizeError } from './jcs.js';
export {
  ed25519FromSeed,
  generateReplicaKeys,
  publicOfPrivate,
  signText,
  verifyText,
} from './keys.js';
export type { ReplicaKeys } from './keys.js';
export {
  contentHash,
  headerOf,
  isStub,
  MAX_OP_BYTES,
  MAX_SEALED_RECIPIENTS,
  MAX_STATE_ENTRIES,
  OP_TYPES,
  opHash,
  REPLICA_ID,
  SEALED_TYPES,
  STUBBABLE_TYPES,
  stubOf,
  TAG,
  ZERO_HASH,
} from './ops.js';
export type {
  AgentBody,
  ChannelBody,
  DocBody,
  FederatedOp,
  ForwardPayload,
  KeyBody,
  LegacyAttestation,
  LogEntry,
  MailPayload,
  MailTarget,
  MemoryBody,
  OpHeader,
  OpStub,
  OpType,
  PresenceBody,
  RosterBody,
  Sealed,
  StatePayload,
} from './ops.js';
export {
  canSealTo,
  openPayload,
  openWithKey,
  sealedAad,
  sealPayload,
  unwrapContentKey,
  wrapContentKey,
} from './seal.js';
