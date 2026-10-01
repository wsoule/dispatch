// Full memory view values (proposals, entries, health, the ledger import
// report) for memory tests.
import type {
  LedgerImportReport,
  MemoryEntryView,
  MemoryHealth,
  MemoryProposalView,
} from '@dispatch/client';

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

export function report(
  over: Partial<LedgerImportReport> = {}
): LedgerImportReport {
  return {
    outcome: 'ok',
    read: 330,
    byKind: { constraint: 0, hazard: 319, decision: 11, handoff: 0 },
    memory: {
      total: 15,
      imported: 15,
      proposed: 0,
      truncated: 0,
      alreadyImported: 0,
      alreadyDeleted: 0,
    },
    audit: {
      total: 315,
      policy: 0,
      floor: 0,
      scope: 1,
      'undeclared-writes': 300,
      'dep-map': 14,
      handoff: 0,
    },
    damaged: 0,
    memoryRows: { before: 0, after: 15 },
    openProposals: { before: 0, after: 0 },
    mismatches: [],
    at: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}

export function health(over: Partial<MemoryHealth> = {}): MemoryHealth {
  return {
    available: true,
    reason: null,
    search: 'fts5',
    entries: 15,
    openProposals: 2,
    ledgerImport: null,
    ledgerImportText: null,
    configWarnings: [],
    lastDecayAt: null,
    personal: { available: true, reason: null },
    pinnedOverflow: false,
    exportBlocked: null,
    claudeImport: {
      state: 'complete',
      source: '/Users/x/.claude/projects/-a/memory',
      candidates: [],
      problems: [],
    },
    ...over,
  };
}
