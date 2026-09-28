// Full MemoryProposalView and MemoryEntryView values for memory tests.
import type { MemoryEntryView, MemoryProposalView } from '@dispatch/client';

export type Content = NonNullable<MemoryProposalView['content']>;

export function content(over: Partial<Content> = {}): Content {
  return {
    kind: 'hazard',
    title: 'pnpm 11 ignores onlyBuiltDependencies',
    body: 'Use allowBuilds.',
    refs: [],
    epic: null,
    appliesTo: [],
    ...over,
  };
}

export function proposal(
  over: Partial<MemoryProposalView> = {}
): MemoryProposalView {
  return {
    id: 'mp-000001',
    action: 'add',
    scope: 'team',
    target: null,
    baseRev: null,
    content: content(),
    reason: null,
    author: 'run:r-9f2c01',
    authorTrust: 'agent',
    operator: 'human:wyat',
    runId: 'r-9f2c01',
    taskId: 't-1a2b3c',
    origin: null,
    contentHash: null,
    gate: 'm-000001',
    state: 'open',
    matchedPersonal: false,
    decidedBy: null,
    decidedByPolicy: null,
    decisionReason: null,
    result: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    decidedAt: null,
    ...over,
  };
}

export function entry(over: Partial<MemoryEntryView> = {}): MemoryEntryView {
  return {
    id: 'mem-000001',
    handle: 'pnpm-builds',
    scope: 'team',
    kind: 'hazard',
    title: 'pnpm builds',
    body: 'old',
    refs: [],
    epic: null,
    appliesTo: [],
    projectKey: null,
    author: 'human:wyat',
    trust: 'human',
    status: 'active',
    statusReason: null,
    decay: 'fresh',
    pinned: false,
    supersedes: null,
    supersededBy: null,
    origin: null,
    proposal: null,
    decidedBy: null,
    decidedByPolicy: null,
    rev: 1,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    lastRecalledAt: null,
    recallCount: 0,
    state: 'active',
    ...over,
  };
}
