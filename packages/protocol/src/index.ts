export const PROTOCOL_VERSION = '0.1.0';
export { isAgentAuthored, parseAddress, SYSTEM_ADDRESS } from './address.js';
export type { Address, ParsedAddress } from './address.js';
export { DEFAULT_LIMITS, DeliveryEngine } from './engine.js';
export type {
  EngineEvent,
  EngineLimits,
  SendResult,
  Sender,
} from './engine.js';
export {
  BUILT_IN_KINDS,
  GATE_TYPES,
  gateOf,
  REF_TYPES,
  validateSendInput,
} from './envelope.js';
export type {
  GateData,
  JsonValue,
  Message,
  MessageKind,
  Ref,
  SendInput,
} from './envelope.js';
export { MessagingError } from './errors.js';
export type { MessagingErrorCode } from './errors.js';
export type {
  MessagingHost,
  PolicyRequest,
  PolicyRuling,
  WakeResult,
} from './host.js';
export { renderDigestLine, renderForAgent } from './render.js';
export {
  MESSAGES_DB_VERSION,
  openMessagesDb,
  SqliteMessageStore,
} from './sqliteStore.js';
export { DELIVERY_STATES } from './store.js';
export type {
  AgentRecord,
  AgentStatus,
  ChannelRecord,
  Delivery,
  DeliveryFilter,
  DeliveryState,
  DeliveryVia,
  MessageStore,
} from './store.js';
export { createUlidFactory } from './ulid.js';
