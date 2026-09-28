import type { Address, Ref } from '@dispatch/protocol';

export const MEMORY_KINDS = [
  'preference',
  'convention',
  'constraint',
  'hazard',
  'decision',
  'fact',
  'reference',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

// The same three words in storage, routes, tools and events.
export const MEMORY_SCOPES = ['personal', 'project', 'team'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type SharedScope = Exclude<MemoryScope, 'personal'>;

export type MemoryTrust = 'human' | 'confirmed' | 'agent';
export type MemoryStatus = 'active' | 'retired';
export type MemoryStatusReason = 'forgotten' | 'superseded' | 'undone';
export type MemoryDecay = 'fresh' | 'stale' | 'expired';
export type DisplayState = 'active' | 'stale' | 'retired';

export interface PolicyDecision {
  rung: number;
  authorizedBy: 'rung' | 'override';
}

export interface MemoryEntry {
  id: string;
  handle: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  body: string;
  refs: Ref[];
  epic: string | null;
  appliesTo: string[];
  projectKey: string | null;
  author: Address;
  trust: MemoryTrust;
  status: MemoryStatus;
  statusReason: MemoryStatusReason | null;
  decay: MemoryDecay;
  pinned: boolean;
  supersedes: string | null;
  supersededBy: string | null;
  origin: string | null;
  proposal: string | null;
  decidedBy: Address | null;
  decidedByPolicy: PolicyDecision | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
}

export interface ProposalContent {
  kind: MemoryKind;
  title: string;
  body: string;
  refs: Ref[];
  epic: string | null;
  appliesTo: string[];
}

export type ProposalAction = 'add' | 'supersede' | 'retire';
export type ProposalState = 'open' | 'approved' | 'rejected' | 'expired';

export interface MemoryProposal {
  id: string;
  action: ProposalAction;
  scope: SharedScope;
  target: string | null;
  baseRev: number | null;
  content: ProposalContent | null;
  reason: string | null;
  author: Address;
  // 'human' only for a human principal: a shared-agentToken write is
  // attributed to the owner yet must never earn human trust.
  authorTrust: 'human' | 'agent';
  operator: Address | null;
  runId: string | null;
  taskId: string | null;
  origin: string | null;
  contentHash: string | null;
  gate: string | null;
  state: ProposalState;
  // Matched a personal entry of the author's operator, so policy never approves it.
  matchedPersonal: boolean;
  decidedBy: Address | null;
  decidedByPolicy: PolicyDecision | null;
  decisionReason: string | null;
  result: string | null;
  createdAt: string;
  decidedAt: string | null;
}

// Messaging's principal shape (packages/server/src/messaging/principal.ts:9-13).
export interface Principal {
  address: Address;
  canDecide: boolean;
  kind: 'human' | 'run' | 'agent';
}

export interface Operator {
  human: Address;
  identity: string;
}

export interface IndexContext {
  taskId: string;
  title: string;
  body: string;
  writes: string[];
  epic: string | null;
  risk: 'routine' | 'elevated' | 'critical' | undefined;
  a2a: boolean;
}

export interface MemoryChange {
  scope: MemoryScope;
  id?: string;
}

export type RecallVia = 'index' | 'search' | 'read' | 'claude-recall';

export type RevisionCause =
  | 'save'
  | 'edit'
  | 'retire'
  | 'undo'
  | 'gate'
  | 'import'
  | 'ingest'
  | 'decay'
  | 'sync';

export interface Revision {
  memoryId: string;
  rev: number;
  snapshot: MemoryEntry;
  by: Address;
  cause: RevisionCause;
  at: string;
}

/** The one state agents and the UI see: retired when retired or expired. */
export function displayState(
  entry: Pick<MemoryEntry, 'status' | 'decay'>
): DisplayState {
  if (entry.status === 'retired' || entry.decay === 'expired') return 'retired';
  return entry.decay === 'stale' ? 'stale' : 'active';
}
