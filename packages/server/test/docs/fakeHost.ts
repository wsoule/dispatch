import type {
  DocProposal,
  DocsConfig,
  LinkTarget,
  PolicyRuling,
  TaskRisk,
} from '@dispatch/core';
import type { Operator } from '@dispatch/memory';

import type {
  DocChange,
  DocsHost,
  DocsTaskFacts,
  PublishOutcome,
} from '../../src/docs/host.js';
import { DocsService } from '../../src/docs/service.js';
import { openDocsDb, SqliteDocStore } from '../../src/docs/store.js';
import type { Principal } from '../../src/messaging/principal.js';

export const OWNER: Principal = {
  address: 'human:wyat',
  canDecide: true,
  kind: 'human',
};
export const TEAMMATE: Principal = {
  address: 'human:alice',
  canDecide: false,
  kind: 'human',
};
export const DECIDER: Principal = {
  address: 'human:bob',
  canDecide: true,
  kind: 'human',
};
export const RUN: Principal = {
  address: 'run:r-1',
  canDecide: false,
  kind: 'run',
}; // execute run of t-1
export const RUN2: Principal = {
  address: 'run:r-2',
  canDecide: false,
  kind: 'run',
}; // execute run of t-2
export const REVIEW_RUN: Principal = {
  address: 'run:r-rev',
  canDecide: false,
  kind: 'run',
};
export const AGENT: Principal = {
  address: 'agent:wyat/claude-code.mac',
  canDecide: false,
  kind: 'agent',
};
export const A2A_AGENT: Principal = {
  address: 'agent:wyat/a2a.acme',
  canDecide: false,
  kind: 'agent',
};

// A recording DocsHost: tasks, runs, threads and memory scopes are set per test.
export class FakeDocsHost implements DocsHost {
  tasks = new Map<string, DocsTaskFacts>();
  runs = new Map<
    string,
    {
      kind: 'execute' | 'review' | 'verify';
      taskId: string | null;
      operator: Operator | null;
    }
  >([
    ['run:r-1', { kind: 'execute', taskId: 't-1', operator: null }],
    ['run:r-2', { kind: 'execute', taskId: 't-2', operator: null }],
    ['run:r-rev', { kind: 'review', taskId: 't-1', operator: null }],
  ]);
  existing = new Set<string>([
    'run:r-1',
    'run:r-2',
    'thread:m-1',
    'thread:m-2',
    'memory:mem-team',
    'memory:mem-mine',
  ]);
  threads = new Map<string, Set<string>>([
    ['m-1', new Set(['run:r-1'])],
    ['m-2', new Set(['run:r-2'])],
  ]);
  memoryScopes = new Map<string, 'personal' | 'project' | 'team'>([
    ['mem-team', 'team'],
    ['mem-mine', 'personal'],
  ]);
  // Who may see each personal memory entry (its owner's principals).
  memoryOwners = new Map<string, Set<string>>([
    ['mem-mine', new Set(['human:wyat'])],
  ]);
  operators = new Map<string, Operator>();
  // Tasks an A2A client asked for.
  a2aTasks = new Set<string>();
  changes: DocChange[] = [];
  // Called from `changed`, as DaemonDocsHost.onChange listeners are.
  listeners: ((change: DocChange) => void)[] = [];
  live: ReturnType<DocsHost['liveExecuteRuns']> = [];
  // Runs whose notifyRun throws, as one that is not live or cannot take input does.
  notifyThrows = new Set<string>();
  runLines: { runId: string; line: string }[] = [];
  clock = new Date('2026-09-26T10:00:00.000Z');
  // Overrides of DEFAULT_TEST_CONFIG, read on every use.
  config: Partial<DocsConfig> = {};
  // The doc gate's side: who may decide, the policy ruling, and what was raised, closed and told.
  deciders = new Set<string>(['human:wyat', 'human:bob']);
  ruling: (risk: TaskRisk | undefined) => PolicyRuling = () => ({
    mode: 'block',
  });
  risksAsked: (TaskRisk | undefined)[] = [];
  gatesRaised: string[] = [];
  gatesClosed: { gate: string; reason: string }[] = [];
  notices: { to: string; replyTo: string | null; body: string }[] = [];
  policyApprovals: DocProposal[] = [];
  openGates: { id: string; proposal: string }[] = [];
  onCloseGate: (() => void) | null = null;
  // Publish: the checkout, the tasks it created and how each ended.
  rootDir = '';
  createdTasks: (Parameters<DocsHost['createPublishTask']>[0] & {
    id: string;
  })[] = [];
  outcomes = new Map<string, NonNullable<PublishOutcome>>();
  closedTasks: { task: string; reason: string }[] = [];

  constructor() {
    for (const id of ['t-1', 't-2', 'e-1', 'e-root']) {
      this.tasks.set(id, {
        id,
        title: id,
        body: '',
        parent: null,
        risk: 'routine',
        labels: [],
      });
    }
    this.tasks.set('t-1', {
      id: 't-1',
      title: 'Task one',
      body: '',
      parent: 'e-1',
      risk: 'routine',
      labels: [],
    });
    this.tasks.set('e-1', {
      id: 'e-1',
      title: 'Epic',
      body: '',
      parent: 'e-root',
      risk: 'routine',
      labels: [],
    });
  }

  operatorOf(p: Principal): Operator | null {
    return (
      this.operators.get(p.address) ??
      this.runs.get(p.address)?.operator ??
      null
    );
  }
  taskOfPrincipal(p: Principal): string | null {
    const run = this.runs.get(p.address);
    return run?.kind === 'execute' ? run.taskId : null;
  }
  runTaskOf(p: Principal): string | null {
    return this.runs.get(p.address)?.taskId ?? null;
  }
  runKind(p: Principal): 'execute' | 'review' | 'verify' | null {
    return this.runs.get(p.address)?.kind ?? null;
  }
  task(id: string): DocsTaskFacts | null {
    return this.tasks.get(id) ?? null;
  }
  a2aOrigin(id: string): boolean {
    return this.a2aTasks.has(id);
  }
  exists(t: LinkTarget): boolean {
    return t.type === 'task'
      ? this.tasks.has(t.id)
      : this.existing.has(`${t.type}:${t.id}`);
  }
  inThread(threadId: string, p: Principal): boolean {
    return this.threads.get(threadId)?.has(p.address) ?? false;
  }
  memoryScope(id: string): 'personal' | 'project' | 'team' | null {
    return this.memoryScopes.get(id) ?? null;
  }
  memoryVisible(id: string, p: Principal): boolean {
    const scope = this.memoryScopes.get(id);
    return (
      scope !== undefined &&
      (scope !== 'personal' ||
        this.memoryOwners.get(id)?.has(p.address) === true)
    );
  }
  changed(change: DocChange): void {
    this.changes.push(change);
    for (const listener of this.listeners) listener(change);
  }
  liveExecuteRuns(): ReturnType<DocsHost['liveExecuteRuns']> {
    return this.live;
  }
  notifyRun(runId: string, line: string): void {
    if (this.notifyThrows.has(runId))
      throw new Error(`run ${runId} cannot take a notice`);
    this.runLines.push({ runId, line });
  }
  canDecide(address: string): boolean {
    return this.deciders.has(address);
  }
  rule(risk: TaskRisk | undefined): PolicyRuling {
    this.risksAsked.push(risk);
    return this.ruling(risk);
  }
  raiseGate(p: DocProposal): Promise<string> {
    const id = `m-gate-${this.gatesRaised.length + 1}`;
    this.gatesRaised.push(id);
    this.openGates.push({ id, proposal: p.rev });
    return Promise.resolve(id);
  }
  closeGate(gate: string, reason: string): boolean {
    this.onCloseGate?.();
    this.gatesClosed.push({ gate, reason });
    this.openGates = this.openGates.filter((g) => g.id !== gate);
    return true;
  }
  notice(to: string, replyTo: string | null, body: string): void {
    this.notices.push({ to, replyTo, body });
  }
  recordPolicyApproval(p: DocProposal): void {
    this.policyApprovals.push(p);
  }
  openDocGates(): { id: string; proposal: string }[] {
    return this.openGates;
  }
  // Simulated crash points around the task's creation.
  crashBeforeCreate = false;
  crashAfterCreate = false;
  createPublishTask(
    input: Parameters<DocsHost['createPublishTask']>[0]
  ): string {
    if (this.crashBeforeCreate) throw new Error('crash before the task');
    const id = `t-pub-${this.createdTasks.length + 1}`;
    this.createdTasks.push({ ...input, id });
    this.tasks.set(id, {
      id,
      title: input.title,
      body: input.body,
      parent: null,
      risk: input.risk,
      labels: [],
    });
    if (this.crashAfterCreate) throw new Error('crash after the task');
    return id;
  }
  findPublishTasks(title: string): string[] {
    return this.createdTasks
      .filter(
        (t) =>
          t.title === title && !this.closedTasks.some((c) => c.task === t.id)
      )
      .map((t) => t.id);
  }
  closePublishTask(task: string, reason: string): void {
    this.closedTasks.push({ task, reason });
  }
  publishOutcome(taskId: string): PublishOutcome {
    return this.outcomes.get(taskId) ?? null;
  }
  now(): Date {
    return this.clock;
  }
  advance(minutes: number): void {
    this.clock = new Date(this.clock.getTime() + minutes * 60_000);
  }
}

export const DEFAULT_TEST_CONFIG: DocsConfig = {
  indexTokens: 400,
  inlineSpecBytes: 16384,
  coalesceMinutes: 10,
  noticeMinutes: 10,
  createsPerHour: 20,
  proposalsPerHour: 10,
  maxOpenProposals: 50,
  proposalTtlDays: 14,
};

export function makeService(
  opts: {
    fts?: boolean;
    coalesceMinutes?: number;
    orphans?: string[];
    assetsDir?: string;
    assetLimits?: { files: number; bytes: number; projectBytes: number };
  } = {}
): {
  service: DocsService;
  host: FakeDocsHost;
  store: SqliteDocStore;
} {
  const { db, fts } = openDocsDb(':memory:', { fts: opts.fts });
  const store = new SqliteDocStore(db, fts);
  const host = new FakeDocsHost();
  const service = new DocsService({
    store,
    host,
    ownerRef: 'human:wyat',
    config: () => ({
      config: {
        ...DEFAULT_TEST_CONFIG,
        coalesceMinutes: opts.coalesceMinutes ?? 10,
        ...host.config,
      },
      warnings: [],
    }),
    ...(opts.orphans === undefined
      ? {}
      : { orphans: () => opts.orphans ?? [] }),
    ...(opts.assetsDir === undefined ? {} : { assetsDir: opts.assetsDir }),
    ...(opts.assetLimits === undefined
      ? {}
      : { assetLimits: opts.assetLimits }),
  });
  return { service, host, store };
}
