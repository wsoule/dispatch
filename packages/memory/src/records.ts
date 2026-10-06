import type { Address, Ref } from '@dispatch-foo/protocol';
import { createUlidFactory } from '@dispatch-foo/protocol';

import { memoryContentHash } from './contentHash.js';
import { memoryHandle } from './handle.js';
import type { MemoryStore } from './store.js';
import type {
  MemoryEntry,
  MemoryKind,
  MemoryProposal,
  MemoryScope,
  MemoryTrust,
  PolicyDecision,
  ProposalAction,
  ProposalContent,
  RevisionCause,
  SharedScope,
} from './types.js';

export interface MemoryIds {
  entry(nowMs: number): string;
  proposal(nowMs: number): string;
  activity(nowMs: number): string;
}

// Entry, proposal and activity ids share one ULID clock, so each sorts by creation.
export function createMemoryIds(
  ulid: (nowMs: number) => string = createUlidFactory()
): MemoryIds {
  return {
    entry: (ms) => `mem-${ulid(ms)}`,
    proposal: (ms) => `mp-${ulid(ms)}`,
    activity: (ms) => `ma-${ulid(ms)}`,
  };
}

export interface NewEntryInput {
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  body: string;
  refs?: Ref[];
  epic?: string | null;
  appliesTo?: string[];
  projectKey?: string | null;
  author: Address;
  trust: MemoryTrust;
  origin?: string | null;
  proposal?: string | null;
  decidedBy?: Address | null;
  decidedByPolicy?: PolicyDecision | null;
  supersedes?: string | null;
  pinned?: boolean;
  createdAt?: string;
  lastRecalledAt?: string | null;
}

// A new active, fresh entry at rev 1; its handle derives from `id`.
export function newMemoryEntry(
  input: NewEntryInput,
  id: string,
  now: string
): MemoryEntry {
  const createdAt = input.createdAt ?? now;
  return {
    id,
    handle: memoryHandle(id),
    scope: input.scope,
    kind: input.kind,
    title: input.title,
    body: input.body,
    refs: input.refs ?? [],
    epic: input.epic ?? null,
    appliesTo: input.appliesTo ?? [],
    projectKey: input.projectKey ?? null,
    author: input.author,
    trust: input.trust,
    status: 'active',
    statusReason: null,
    decay: 'fresh',
    pinned: input.pinned ?? false,
    supersedes: input.supersedes ?? null,
    supersededBy: null,
    origin: input.origin ?? null,
    proposal: input.proposal ?? null,
    decidedBy: input.decidedBy ?? null,
    decidedByPolicy: input.decidedByPolicy ?? null,
    rev: 1,
    createdAt,
    updatedAt: createdAt,
    lastRecalledAt: input.lastRecalledAt ?? null,
    recallCount: 0,
  };
}

export interface NewProposalInput {
  action: ProposalAction;
  scope: SharedScope;
  target?: string | null;
  baseRev?: number | null;
  content?: ProposalContent | null;
  reason?: string | null;
  author: Address;
  authorTrust: 'human' | 'agent';
  operator?: Address | null;
  runId?: string | null;
  taskId?: string | null;
  origin?: string | null;
}

// A new open proposal, hashed by its content so duplicates can be found.
export function newProposal(
  input: NewProposalInput,
  id: string,
  now: string
): MemoryProposal {
  const content = input.content ?? null;
  return {
    id,
    action: input.action,
    scope: input.scope,
    target: input.target ?? null,
    baseRev: input.baseRev ?? null,
    content,
    reason: input.reason ?? null,
    author: input.author,
    authorTrust: input.authorTrust,
    operator: input.operator ?? null,
    runId: input.runId ?? null,
    taskId: input.taskId ?? null,
    origin: input.origin ?? null,
    contentHash: content === null ? null : memoryContentHash(content),
    gate: null,
    state: 'open',
    matchedPersonal: false,
    decidedBy: null,
    decidedByPolicy: null,
    decisionReason: null,
    result: null,
    createdAt: now,
    decidedAt: null,
  };
}

// Inserts a freshly minted entry, re-minting on the rare 40-bit handle collision.
export function insertFresh(
  store: MemoryStore,
  ids: MemoryIds,
  nowMs: number,
  build: (id: string) => MemoryEntry,
  by: Address,
  cause: RevisionCause
): MemoryEntry {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = build(ids.entry(nowMs));
    if (store.entriesByHandle(entry.handle).length > 0) continue;
    store.insertEntry(entry, by, cause);
    return entry;
  }
  throw new Error('could not mint a memory handle in 5 attempts');
}
