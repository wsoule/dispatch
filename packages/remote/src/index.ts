// @dispatch/remote: reaching a daemon from a phone through a relay, with no
// VPN and no open port. The daemon and the phone each dial out to the relay;
// everything between them is end-to-end encrypted (handshake.ts).
export { fromBase64Url, toBase64Url, toHex } from './bytes.js';
export { DaemonLink } from './daemon.js';
export type {
  DaemonLinkStatus,
  DeviceDirectory,
  LocalApi,
  LocalRequest,
  LocalResponse,
  PairedDevice,
} from './daemon.js';
export { generateKeyPair, publicKeyOf } from './handshake.js';
export type { KeyPair, RandomBytes } from './handshake.js';
export { isAllowedRelay, pairingUrl, parsePairingUrl } from './pairing.js';
export type { PairingOffer } from './pairing.js';
export { RemoteConnection } from './phone.js';
export type { RelaySocket, RemoteStatus, TunnelSocket } from './phone.js';
export {
  CLOSE,
  daemonIdFor,
  isDaemonId,
  MAX_FRAME_BYTES,
  prefixSid,
  SID_BYTES,
  sidFromBytes,
} from './wire.js';
export type { DaemonControl } from './wire.js';
