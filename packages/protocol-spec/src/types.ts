// The conformance kit's shared vocabulary: vector files, the adapter's JSON
// line messages, and the report the runner writes.

export const VECTOR_CLASSES = [
  'envelope',
  'host-core',
  'a2a-binding',
  'federation',
] as const;
export type VectorClass = (typeof VECTOR_CLASSES)[number];

export const LEVELS = ['MUST', 'SHOULD', 'MAY'] as const;
export type Level = (typeof LEVELS)[number];

export const PROFILES = ['core', 'dispatch'] as const;
export type Profile = (typeof PROFILES)[number];

export const CLAIMS = [
  'envelope',
  'core',
  'dispatch-profile',
  'a2a-binding',
] as const;
export type ClaimName = (typeof CLAIMS)[number];

export const OPS = [
  'send',
  'reply',
  'close',
  'markRead',
  'inbox',
  'thread',
  'canRead',
  'openBlocking',
  'join',
  'leave',
  'deliverHeld',
  'recover',
  'parseAddress',
  'validate',
  'render',
  'a2a.validate',
  'a2a.project',
  'a2a.inbound',
  'world',
] as const;
export type Op = (typeof OPS)[number];

// Steps whose successful result names a message, which `$sN` then refers to.
export const CREATING_OPS = ['send', 'reply', 'close', 'a2a.inbound'] as const;

export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

export interface SenderSpec {
  address: string;
  canDecide: boolean;
}

// The world an adapter scripts its host from before running a vector.
export interface Given {
  clock?: string;
  seed?: number;
  // Sessions are `run:` addresses.
  workItems?: { id: string; liveSession?: string; sessions?: string[] }[];
  auxSessions?: string[];
  agents?: {
    address: string;
    status: 'pending' | 'approved' | 'revoked';
    muted?: boolean;
  }[];
  channels?: { name: string; members: string[] }[];
  implicit?: Record<string, string[]>;
  owner?: string;
  rulings?: Record<string, 'allow' | 'ask' | 'deny'>;
  wakeResults?: Record<
    string,
    { ok: true; session: string } | { ok: false; reason: string }
  >;
  failPush?: string[];
  failOnAnswered?: boolean;
  limits?: { urgentPerHour?: number; agentTurnsPerThreadPerHour?: number };
  external?: Record<string, 'client' | 'peer'>;
  store?: {
    messages?: JsonObject[];
    deliveries?: JsonObject[];
    appliedGates?: string[];
  };
}

export type Step = { op: Op } & JsonObject;

export type StepResult =
  | { ok: true; result?: Json }
  | { ok: false; error: { code: string; field?: string } };

export interface Expectation {
  steps?: (StepResult | null)[];
  messages?: JsonObject[];
  noOtherMessages?: boolean;
  deliveries?: {
    message: string;
    recipient: string;
    via?: string;
    state?: string;
    session?: string | null;
  }[];
  noDeliveries?: string[];
  calls?: JsonObject[];
  callsInclude?: JsonObject[];
  gateEffects?: string[];
  voided?: string[];
  channels?: { name: string; members: string[] }[];
  render?: { step: number; text: string }[];
}

export interface Vector {
  id: string;
  title: string;
  class: VectorClass;
  level: Level;
  profile: Profile;
  sections: string[];
  capability?: string;
  tags?: string[];
  given: Given;
  when: Step[];
  then: Expectation;
}

// What crosses the pipe: the adapter never sees the expectation.
export type RunnableVector = Omit<Vector, 'then'>;

export interface VectorFile {
  kit: string;
  class: VectorClass;
  area: string;
  vectors: Vector[];
}

// Regular expressions (as strings) describing how the adapter renders a push,
// and `digestLead`, the host's own text that opens a digest.
export interface RenderForms {
  quotePrefix: string;
  header: string;
  hostLines: string[];
  digestLead: string;
}

export interface Hello {
  dmp: 'hello';
  implementation: { name: string; version: string };
  classes: VectorClass[];
  profiles: Profile[];
  capabilities: string[];
  systemAddress: string;
  gateTypes: string[];
  render: RenderForms;
}

export interface ObservedMessage {
  id: string;
  thread: string;
  replyTo: string | null;
  from: string;
  to: string[];
  kind: string;
  body: string;
  refs: JsonObject[];
  data?: Json;
  urgent: boolean;
  blocking: boolean;
  choices?: string[];
  choice?: string;
  wake: string;
  createdAt: string;
}

export interface ObservedDelivery {
  id: string;
  message: string;
  recipient: string;
  session: string | null;
  via: string;
  state: string;
}

export type HookName =
  | 'push'
  | 'notify'
  | 'notifyHuman'
  | 'wake'
  | 'decide'
  | 'onAnswered'
  | 'published'
  | 'admitExternal';
export type CallRecord = { hook: HookName } & {
  [field: string]: string | null;
};

export interface Observation {
  dmp: 'observation';
  id: string;
  steps: StepResult[];
  messages: ObservedMessage[];
  deliveries: ObservedDelivery[];
  calls: CallRecord[];
  gateEffects: string[];
  voided: string[];
  channels: { name: string; members: string[] }[];
  render: { step: number; text: string }[];
}

export interface Unsupported {
  dmp: 'unsupported';
  id: string;
  reason: string;
}

export type Outcome =
  | 'pass'
  | 'fail'
  | 'skipped'
  | 'not-applicable'
  | 'adapter-error';

export interface VectorResult {
  id: string;
  class: VectorClass;
  level: Level;
  profile: Profile;
  outcome: Outcome;
  reasons: string[];
}

export interface ClassTally {
  pass: number;
  fail: number;
  skipped: number;
  notApplicable: number;
  shouldFailures: number;
}

export interface Deviation {
  section: string;
  summary: string;
}

export interface TckAttestation {
  commit: string;
  transport: string;
  level: 'must' | 'should' | 'may';
  result: 'pass' | 'fail';
  deviations: string[];
}

export interface Report {
  dmp: string;
  kit: string;
  implementation: { name: string; version: string };
  claims: Partial<Record<ClaimName, 'pass' | 'fail' | 'vectors-only'>>;
  classes: Partial<Record<VectorClass, ClassTally>>;
  vectors: VectorResult[];
  declaredDeviations: Deviation[];
  a2a?: {
    tck: (Omit<TckAttestation, 'deviations'> & { attested: true }) | null;
    deviations: string[];
  };
  runner: string;
  date: string;
}
