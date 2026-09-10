import type { AddLedgerInput, LedgerEntry, TaskRisk } from '@dispatch/core';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../src/events.js';
import type { FixLoopState } from '../src/orchestrator/fixLoop.js';
import type { RunMeta, RunState } from '../src/orchestrator/types.js';
import { OrchestratorConflictError } from '../src/orchestrator/types.js';
import type { VerificationResult } from '../src/orchestrator/verify.js';
import type { ApprovalFloor } from '../src/policyEngine.js';
import {
  consultProjectPolicy,
  policyDecisionClassifier,
  PolicyEngine,
} from '../src/policyEngine.js';

function runMeta(id: string, patch: Partial<RunMeta> = {}): RunMeta {
  return {
    id,
    taskId: 't-000001',
    taskTitle: `Task ${id}`,
    executor: 'fake',
    state: 'finished' as RunState,
    branch: `dispatch/${id}`,
    baseBranch: 'main',
    worktreePath: `/tmp/${id}`,
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
    ...patch,
  };
}

function verifyResult(
  pass: boolean,
  patch: Partial<VerificationResult> = {}
): VerificationResult {
  return {
    runId: 'r-verify1',
    taskId: 't-000001',
    pass,
    checks: [{ check: 'c', expected: 'e', actual: 'a', pass }],
    artifacts: [],
    createdAt: '2026-09-03T12:05:00.000Z',
    ...patch,
  };
}

function completeLoop(taskId: string): FixLoopState {
  return {
    taskId,
    round: 2,
    cap: 5,
    state: 'complete',
    baseSha: 'abc123',
    lastReviewedSha: 'def456',
    updatedAt: '2026-09-03T12:10:00.000Z',
  };
}

// The engine stood up over in-memory stand-ins for every peer, plus a real
// temp .dispatch/config.yml — policy is read fresh from disk on each consult,
// and these tests rely on that to flip rungs mid-test.
interface Harness {
  engine: PolicyEngine;
  events: EventBus;
  root: string;
  runs: RunMeta[];
  loops: Map<string, FixLoopState>;
  ignited: string[];
  verifyResults: Map<string, VerificationResult>;
  verifyStarts: { taskId: string; head: string }[];
  enqueued: string[];
  /** Per-run diff the engine's delete-outside-writes hold reads. */
  diffs: Map<string, { path: string; status: string }[]>;
  ledger: AddLedgerInput[];
  activity: { taskId: string; text: string }[];
  approved: { runId: string; requestId: string }[];
  fireTerminal(meta: RunMeta): void;
  setPolicy(yaml: string): void;
  stop(): void;
}

const roots: string[] = [];

interface PendingApproval {
  runId: string;
  taskId: string;
  requestId: string;
  toolName: string;
  input: unknown;
}

function harness(
  opts: {
    enqueueThrows?: Error;
    /** The declared risk every task in this harness carries. */
    risk?: TaskRisk;
    approvalFloor?: ApprovalFloor;
    pending?: PendingApproval[];
    diffThrows?: Error;
    writes?: string[];
  } = {}
): Harness {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-policy-engine-'));
  roots.push(root);
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  const events = new EventBus();
  const runs: RunMeta[] = [];
  const loops = new Map<string, FixLoopState>();
  const ignited: string[] = [];
  const verifyResults = new Map<string, VerificationResult>();
  const verifyStarts: { taskId: string; head: string }[] = [];
  const enqueued: string[] = [];
  const diffs = new Map<string, { path: string; status: string }[]>();
  const ledger: AddLedgerInput[] = [];
  const activity: { taskId: string; text: string }[] = [];
  const approved: { runId: string; requestId: string }[] = [];
  const terminalCallbacks: ((meta: RunMeta) => void)[] = [];
  const engine = new PolicyEngine({
    rootDir: root,
    store: {
      get: () => ({
        meta: {
          parent: 'e-000001',
          risk: opts.risk ?? 'routine',
          writes: opts.writes ?? [],
        },
      }),
    },
    events,
    orchestrator: {
      list: () => runs,
      onRunTerminal: (cb) => {
        terminalCallbacks.push(cb);
        return () => {};
      },
      pendingApprovals: () => opts.pending ?? [],
      approve: (runId, requestId) => {
        approved.push({ runId, requestId });
      },
      diff: (runId) => {
        if (opts.diffThrows !== undefined) throw opts.diffThrows;
        return { files: diffs.get(runId) ?? [] };
      },
    },
    fixLoop: {
      get: (taskId) => loops.get(taskId) ?? null,
      ignite: (taskId) => {
        ignited.push(taskId);
        return Promise.resolve(completeLoop(taskId));
      },
    },
    verificationRunner: {
      getLatestResult: (taskId) => verifyResults.get(taskId) ?? null,
      startVerification: ({ taskId, head }) => {
        verifyStarts.push({ taskId, head });
        return Promise.resolve({
          skipped: false as const,
          meta: runMeta('r-reverify', { taskId }),
        });
      },
    },
    mergeQueue: {
      enqueue: (runId) => {
        if (opts.enqueueThrows !== undefined) throw opts.enqueueThrows;
        enqueued.push(runId);
        return {};
      },
    },
    ledgerStore: {
      add: (input) => {
        ledger.push(input);
        return { ...input, id: 'l-000001' } as unknown as LedgerEntry;
      },
      list: () => [],
      entriesFor: () => [],
    },
    actorContext: { humanRef: 'human:test' },
    approvalFloor: opts.approvalFloor,
    appendActivity: (taskId, text) => {
      activity.push({ taskId, text });
    },
  });
  const stop = engine.start();
  return {
    engine,
    events,
    root,
    runs,
    loops,
    ignited,
    verifyResults,
    verifyStarts,
    enqueued,
    diffs,
    ledger,
    activity,
    approved,
    fireTerminal: (meta) => {
      for (const cb of terminalCallbacks) cb(meta);
    },
    setPolicy: (yaml) => {
      writeFileSync(join(root, '.dispatch', 'config.yml'), yaml);
    },
    stop,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// Event handlers run async work; one macrotask turn lets them settle.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('consultProjectPolicy', () => {
  it('blocks at the default rung, auto-decides at the gate rung', () => {
    const h = harness();
    expect(consultProjectPolicy(h.root, 'scope').mode).toBe('block');
    h.setPolicy('policy:\n  rung: 2\n');
    expect(consultProjectPolicy(h.root, 'scope')).toEqual({
      mode: 'auto',
      gate: 'scope',
      rung: 2,
      authorizedBy: 'rung',
    });
    // Rung 2 covers scope only — the other gates still block.
    expect(consultProjectPolicy(h.root, 'verify-retry').mode).toBe('block');
    expect(consultProjectPolicy(h.root, 'merge').mode).toBe('block');
    h.stop();
  });

  it('fails closed on a config that does not parse', () => {
    const h = harness();
    h.setPolicy('policy: [broken\n');
    expect(consultProjectPolicy(h.root, 'scope')).toEqual({ mode: 'block' });
    h.stop();
  });
});

describe('policyDecisionClassifier', () => {
  it('records scope requests at rung 2 and keeps everything else blocking', () => {
    const h = harness();
    const classify = policyDecisionClassifier(h.root);
    const item = (kind: string, state: 'open' | 'resolved' = 'resolved') =>
      ({ kind, state }) as Parameters<typeof classify>[0];
    expect(classify(item('scope-request'))).toBe('blocking');
    h.setPolicy('policy:\n  rung: 2\n');
    expect(classify(item('scope-request'))).toBe('recorded');
    // Still open under a demoted gate means policy declined it: a human
    // really is needed, so it blocks.
    expect(classify(item('scope-request', 'open'))).toBe('blocking');
    // The cap and every other human gate stay blocking at any rung.
    h.setPolicy('policy:\n  rung: 4\n');
    for (const kind of [
      'approval',
      'question',
      'fix-loop-capped',
      'run-stalled',
    ]) {
      expect(classify(item(kind))).toBe('blocking');
    }
    h.stop();
  });
});

describe('the verify-retry gate', () => {
  it('ignites the fix loop off a failed verification and records the rung', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 3\n');
    h.verifyResults.set('t-000001', verifyResult(false));
    h.events.broadcast({ type: 'verification.changed', taskId: 't-000001' });
    await settle();
    expect(h.ignited).toEqual(['t-000001']);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0].kind).toBe('decision');
    expect(h.ledger[0].sourceTaskId).toBe('t-000001');
    expect(h.ledger[0].epicId).toBe('e-000001');
    expect(h.ledger[0].detail).toContain('policy rung 3');
    h.stop();
  });

  it('leaves a failed verification blocking below the rung', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 2\n');
    h.verifyResults.set('t-000001', verifyResult(false));
    h.events.broadcast({ type: 'verification.changed', taskId: 't-000001' });
    await settle();
    expect(h.ignited).toEqual([]);
    expect(h.ledger).toEqual([]);
    h.stop();
  });

  it('never ignites for a passing result or over an existing loop', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 3\n');
    h.verifyResults.set('t-000001', verifyResult(true));
    h.events.broadcast({ type: 'verification.changed', taskId: 't-000001' });
    await settle();
    expect(h.ignited).toEqual([]);

    h.verifyResults.set('t-000001', verifyResult(false));
    h.loops.set('t-000001', { ...completeLoop('t-000001'), state: 'capped' });
    h.events.broadcast({ type: 'verification.changed', taskId: 't-000001' });
    await settle();
    expect(h.ignited).toEqual([]);
    h.stop();
  });

  it('re-verifies once when the loop completes after a red verification', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 3\n');
    h.runs.push(runMeta('r-impl1'));
    h.verifyResults.set('t-000001', verifyResult(false));
    h.loops.set('t-000001', completeLoop('t-000001'));
    h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
    await settle();
    expect(h.verifyStarts).toEqual([
      { taskId: 't-000001', head: 'dispatch/r-impl1' },
    ]);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0].title).toContain('auto-retried');
    // A second broadcast of the same completed loop buys no second retry.
    h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
    await settle();
    expect(h.verifyStarts).toHaveLength(1);
    h.stop();
  });
});

describe('the verify-retry gate on implementer finish', () => {
  it('ignites the fix loop when an implementer finishes at rung 3, recording the rung', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 3\n');
    h.fireTerminal(runMeta('r-impl1'));
    await settle();
    expect(h.ignited).toEqual(['t-000001']);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0].title).toContain('Review & fix loop auto-started');
    expect(h.ledger[0].detail).toContain('policy rung 3');
    expect(h.activity[0].text).toContain('[policy] Review & fix loop');
    h.stop();
  });

  it('leaves a finished implementer alone below rung 3, and for failed or non-execute runs', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 2\n');
    h.fireTerminal(runMeta('r-impl1'));
    h.setPolicy('policy:\n  rung: 4\n');
    h.fireTerminal(runMeta('r-failed', { state: 'failed' as RunState }));
    h.fireTerminal(runMeta('r-verify1', { kind: 'verify' }));
    await settle();
    expect(h.ignited).toEqual([]);
    expect(h.ledger).toEqual([]);
    h.stop();
  });

  it('records nothing when fixLoop.auto already ignites the loop', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 3\nfixLoop:\n  auto: true\n');
    h.fireTerminal(runMeta('r-impl1'));
    await settle();
    // The fix loop engine owns that ignition; no policy decision was made.
    expect(h.ignited).toEqual([]);
    expect(h.ledger).toEqual([]);
    h.stop();
  });
});

describe('the merge gate', () => {
  // A green fix loop: settled `complete` over a finished implementer.
  function greenLoop(h: Harness, ...runIds: string[]): void {
    for (const id of runIds) h.runs.push(runMeta(id));
    h.loops.set('t-000001', completeLoop('t-000001'));
    h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
  }

  it('enqueues the implementer at rung 4 when its loop completes green, recording both receipts', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 4\n');
    greenLoop(h, 'r-impl1');
    await settle();
    expect(h.enqueued).toEqual(['r-impl1']);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0].detail).toContain('policy rung 4');
    // The Activity half of the receipt carries the same authorization.
    expect(h.activity).toEqual([
      {
        taskId: 't-000001',
        text: expect.stringContaining('[policy] Run r-impl1 auto-enqueued'),
      },
    ]);
    expect(h.activity[0].text).toContain('policy rung 4');
    // A second broadcast of the same completed loop enqueues nothing more.
    h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
    await settle();
    expect(h.enqueued).toEqual(['r-impl1']);
    expect(h.ledger).toHaveLength(1);
    h.stop();
  });

  it('stays blocking below rung 4, and a bare finished run is never green', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 3\n');
    greenLoop(h, 'r-impl1');
    await settle();
    expect(h.enqueued).toEqual([]);

    // Rung 4, but no loop at all: a finished implementer on its own is not
    // green, so it waits for the loop the rung-3 hook opens.
    const bare = harness();
    bare.setPolicy('policy:\n  rung: 4\n');
    bare.fireTerminal(runMeta('r-impl1'));
    await settle();
    expect(bare.enqueued).toEqual([]);
    bare.stop();
    h.stop();
  });

  it('a per-gate auto pin demotes merge without raising the rung', async () => {
    const h = harness();
    h.setPolicy('policy:\n  gates:\n    merge: auto\n');
    greenLoop(h, 'r-impl1');
    await settle();
    expect(h.enqueued).toEqual(['r-impl1']);
    expect(h.ledger[0].detail).toContain('per-gate override');
    h.stop();
  });

  it('a loop still open or capped is not green', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 4\n');
    h.runs.push(runMeta('r-impl1'));
    for (const state of ['reviewing', 'capped'] as const) {
      h.loops.set('t-000001', { ...completeLoop('t-000001'), state });
      h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
    }
    await settle();
    expect(h.enqueued).toEqual([]);
    expect(h.ledger).toEqual([]);
    h.stop();
  });

  it('rides the queue admission: a conflict declines quietly, nothing records', async () => {
    const h = harness({
      enqueueThrows: new OrchestratorConflictError('already queued'),
    });
    h.setPolicy('policy:\n  rung: 4\n');
    greenLoop(h, 'r-impl1');
    await settle();
    expect(h.ledger).toEqual([]);
    h.stop();
  });

  it('enqueues the latest implementer when a clean loop settles complete', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 4\n');
    greenLoop(h, 'r-impl2', 'r-impl1');
    await settle();
    expect(h.enqueued).toEqual(['r-impl2']);
    h.stop();
  });
});

describe('the per-task risk cap through the engine', () => {
  it('a critical task never auto-decides, whatever the project rung', async () => {
    const h = harness({ risk: 'critical' });
    h.setPolicy('policy:\n  rung: 4\n');
    h.verifyResults.set('t-000001', verifyResult(false));
    h.events.broadcast({ type: 'verification.changed', taskId: 't-000001' });
    h.fireTerminal(runMeta('r-impl1'));
    await settle();
    expect(h.ignited).toEqual([]);
    expect(h.enqueued).toEqual([]);
    expect(h.ledger).toEqual([]);
    h.stop();
  });

  it('a human always merges elevated work, while its fix loop still auto-ignites', async () => {
    const h = harness({ risk: 'elevated' });
    h.setPolicy('policy:\n  rung: 4\n');
    h.verifyResults.set('t-000001', verifyResult(false));
    h.events.broadcast({ type: 'verification.changed', taskId: 't-000001' });
    await settle();
    expect(h.ignited).toEqual(['t-000001']);
    // The recorded rung is the effective one, capped to 3 by the risk.
    expect(h.ledger[0].detail).toContain('policy rung 3');

    h.loops.set('t-000001', completeLoop('t-000001'));
    h.runs.push(runMeta('r-impl1'));
    h.verifyResults.set('t-000001', verifyResult(true));
    h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
    await settle();
    expect(h.enqueued).toEqual([]);
    h.stop();
  });
});

describe('the approval gate', () => {
  const pending = [
    {
      runId: 'r-impl1',
      taskId: 't-000001',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'pnpm install' },
    },
  ];

  it('auto-allows a referred tool call at rung 3 and records both receipts', async () => {
    const h = harness({ pending, approvalFloor: () => false });
    h.setPolicy('policy:\n  rung: 3\n');
    h.events.broadcast({
      type: 'approval.requested',
      runId: 'r-impl1',
      requestId: 'req-1',
      toolName: 'Bash',
    });
    await settle();
    expect(h.approved).toEqual([{ runId: 'r-impl1', requestId: 'req-1' }]);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0].detail).toContain('Bash: pnpm install');
    expect(h.ledger[0].detail).toContain('policy rung 3');
    expect(h.activity[0].text).toContain('[policy] Tool approval auto-allowed');
    h.stop();
  });

  it('a floor action stays parked at every rung', async () => {
    const h = harness({ pending, approvalFloor: () => true });
    h.setPolicy('policy:\n  rung: 4\n');
    h.events.broadcast({
      type: 'approval.requested',
      runId: 'r-impl1',
      requestId: 'req-1',
      toolName: 'Bash',
    });
    await settle();
    expect(h.approved).toEqual([]);
    expect(h.ledger).toEqual([]);
    h.stop();
  });

  it('never auto-allows below rung 3, or with no floor detector wired', async () => {
    const below = harness({ pending, approvalFloor: () => false });
    below.setPolicy('policy:\n  rung: 2\n');
    below.events.broadcast({
      type: 'approval.requested',
      runId: 'r-impl1',
      requestId: 'req-1',
      toolName: 'Bash',
    });
    await settle();
    expect(below.approved).toEqual([]);
    below.stop();

    const unwired = harness({ pending });
    unwired.setPolicy('policy:\n  rung: 4\n');
    unwired.events.broadcast({
      type: 'approval.requested',
      runId: 'r-impl1',
      requestId: 'req-1',
      toolName: 'Bash',
    });
    await settle();
    expect(unwired.approved).toEqual([]);
    expect(unwired.ledger).toEqual([]);
    unwired.stop();
  });
});

// The floor at the top of the ladder: rung 4 demotes every gate, and each
// of these still blocks. A hold writes one ledger receipt per (check, run),
// however many times the signal that would have auto-decided fires.
describe('the irreversibility floor at the maximum rung', () => {
  const budgetFailed = (id: string) =>
    runMeta(id, {
      state: 'failed' as RunState,
      error: 'run hit its cost budget before the agent finished',
    });

  it('never auto-ignites the fix loop while a budget-exhausted run is unreviewed', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 4\n');
    h.runs.push(budgetFailed('r-broke'));
    h.verifyResults.set('t-000001', verifyResult(false));
    h.events.broadcast({ type: 'verification.changed', taskId: 't-000001' });
    h.events.broadcast({ type: 'verification.changed', taskId: 't-000001' });
    await settle();
    expect(h.ignited).toEqual([]);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0].detail).toContain('irreversibility floor');
    expect(h.ledger[0].detail).toContain('Spend above the budget cap');

    // A human resumed the run: that is the spend decision, and the hold lifts.
    h.runs.unshift(runMeta('r-again', { resumedFrom: 'r-broke' }));
    h.events.broadcast({ type: 'verification.changed', taskId: 't-000001' });
    await settle();
    expect(h.ignited).toEqual(['t-000001']);
    h.stop();
  });

  it('never auto-retries verification while a budget-exhausted run is unreviewed', async () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 4\n');
    h.runs.push(runMeta('r-impl1'), budgetFailed('r-broke'));
    h.verifyResults.set('t-000001', verifyResult(false));
    h.loops.set('t-000001', completeLoop('t-000001'));
    h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
    await settle();
    expect(h.verifyStarts).toEqual([]);
    // The clean loop's auto-enqueue does not spend and is not held by the
    // budget member; the receipt written is the budget hold, once.
    expect(
      h.ledger.filter((e) => e.detail.includes('Spend above the budget cap'))
    ).toHaveLength(1);
    h.stop();
  });

  it('never auto-enqueues a run whose diff deletes outside the declared writes', async () => {
    const h = harness({ writes: ['packages/server/src/**'] });
    h.setPolicy('policy:\n  rung: 4\n');
    h.diffs.set('r-impl1', [
      { path: 'packages/server/src/new.ts', status: 'A' },
      { path: 'packages/core/src/types.ts', status: 'D' },
    ]);
    // The merge gate fires when a fix loop settles `complete` over a finished
    // implementer; a repeat broadcast must not re-record the hold.
    h.runs.push(runMeta('r-impl1'));
    h.loops.set('t-000001', completeLoop('t-000001'));
    h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
    h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
    await settle();
    expect(h.enqueued).toEqual([]);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0].title).toBe('Run r-impl1 held from auto-merge');
    expect(h.ledger[0].detail).toContain('packages/core/src/types.ts');
    expect(h.ledger[0].detail).toContain('Deletes outside declared writes');

    // A deletion inside the fence is ordinary work and enqueues as before.
    h.diffs.set('r-impl2', [
      { path: 'packages/server/src/old.ts', status: 'D' },
    ]);
    h.runs.unshift(runMeta('r-impl2'));
    h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
    await settle();
    expect(h.enqueued).toEqual(['r-impl2']);
    h.stop();
  });

  it('holds auto-enqueue when the diff cannot be read at all', async () => {
    const h = harness({ diffThrows: new Error('no worktree') });
    h.setPolicy('policy:\n  rung: 4\n');
    h.runs.push(runMeta('r-impl1'));
    h.loops.set('t-000001', completeLoop('t-000001'));
    h.events.broadcast({ type: 'fixloop.changed', taskId: 't-000001' });
    await settle();
    expect(h.enqueued).toEqual([]);
    h.stop();
  });

  it('keeps a floor-held feed item blocking whatever gate its kind maps to', () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 4\n');
    const classify = policyDecisionClassifier(h.root);
    const item = (kind: string, floor?: string) =>
      ({ kind, floor }) as unknown as Parameters<typeof classify>[0];
    // scope-request is the one kind rung 4 records — unless the floor holds it.
    expect(classify(item('scope-request'))).toBe('recorded');
    expect(classify(item('scope-request', 'delete-outside-writes'))).toBe(
      'blocking'
    );
    expect(classify(item('approval', 'force-push'))).toBe('blocking');
    expect(classify(item('fix-loop-capped', 'finding-ruling'))).toBe(
      'blocking'
    );
    expect(classify(item('run-stalled', 'budget-cap'))).toBe('blocking');
    h.stop();
  });

  it('keeps a scope request outside the repo or into .git blocking', () => {
    const h = harness();
    h.setPolicy('policy:\n  rung: 4\n');
    const classify = policyDecisionClassifier(h.root);
    const scope = (paths: string[]) =>
      ({ kind: 'scope-request', paths }) as unknown as Parameters<
        typeof classify
      >[0];
    expect(classify(scope(['packages/core/src/index.ts']))).toBe('recorded');
    expect(classify(scope(['packages/core/src/index.ts', '.git/HEAD']))).toBe(
      'blocking'
    );
    expect(classify(scope(['../other-repo/src/index.ts']))).toBe('blocking');
    h.stop();
  });
});
