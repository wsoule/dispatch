import { describe, expect, it } from 'bun:test';

import type {
  DiffFile,
  EpicProgress,
  EpicProgressChild,
  EpicSession,
  EpicSpend,
  Message,
  NormalizedEntry,
  PlanProposal,
  PlanRecord,
  RunMeta,
} from '../src/apiClient.js';
import {
  exitCodeForRunState,
  formatApprovalRequest,
  formatDiffFiles,
  formatEntry,
  formatEpicProgress,
  formatPlanNeedsReply,
  formatProposal,
  formatRunsTable,
  toolApprovalOf,
} from '../src/orchestrateFormat.js';

// An open tool-approval gate, as `message.new` and decisions/open carry it.
const GATE: Message = {
  id: 'm-gate01',
  thread: 'm-gate01',
  replyTo: null,
  from: 'agent:dispatch',
  to: ['human:wyat'],
  kind: 'question',
  body: 'Checkout wants to run run_shell',
  refs: [],
  urgent: false,
  blocking: true,
  choices: ['approve', 'approve-session', 'deny'],
  wake: 'none',
  createdAt: '2026-09-25T10:00:00Z',
  data: {
    type: 'tool-approval',
    requestId: 'fake-approval-1',
    runId: 'r-1',
    tool: 'run_shell',
    input: {},
  },
};

describe('formatEntry', () => {
  it('renders an assistant entry', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'assistant',
      text: 'Looking at the task.',
    };
    expect(formatEntry(entry)).toBe('[assistant] Looking at the task.');
  });

  it('renders a running tool entry with the in-flight glyph', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'tool',
      toolName: 'run_shell',
      status: 'running',
    };
    expect(formatEntry(entry)).toBe('[tool …] run_shell');
  });

  it('renders a sub-agent spawn and finish, and skips its progress ticks', () => {
    const started: NormalizedEntry = {
      ts: 't',
      kind: 'agent',
      agent: {
        id: 'tu-1',
        phase: 'started',
        status: 'running',
        label: 'Map the routes',
        type: 'Explore',
      },
    };
    expect(formatEntry(started)).toBe('[agent ↳] Map the routes (Explore)');
    const progress: NormalizedEntry = {
      ts: 't',
      kind: 'agent',
      agent: { id: 'tu-1', phase: 'progress', status: 'running' },
    };
    expect(formatEntry(progress)).toBeNull();
    const failed: NormalizedEntry = {
      ts: 't',
      kind: 'agent',
      agent: {
        id: 'tu-1',
        phase: 'finished',
        status: 'failed',
        label: 'Map the routes',
        summary: 'ran out of budget',
      },
    };
    expect(formatEntry(failed)).toBe(
      '[agent ✗] Map the routes — ran out of budget'
    );
  });

  it('renders a done tool entry with a checkmark', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'tool',
      toolName: 'write_file',
      status: 'done',
    };
    expect(formatEntry(entry)).toBe('[tool ✓] write_file');
  });

  it('renders an error tool entry with an X', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'tool',
      toolName: 'run_shell',
      status: 'error',
    };
    expect(formatEntry(entry)).toBe('[tool ✗] run_shell');
  });

  it('skips a thinking entry by default', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'thinking',
      text: 'internal reasoning',
    };
    expect(formatEntry(entry)).toBeNull();
  });

  it('renders a thinking entry when verbose is set', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'thinking',
      text: 'internal reasoning',
    };
    expect(formatEntry(entry, { verbose: true })).toBe(
      '[thinking] internal reasoning'
    );
  });

  it('renders a system entry', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'system',
      text: 'user: please fix the typo',
    };
    expect(formatEntry(entry)).toBe('[system] user: please fix the typo');
  });

  it('renders an inbound agent message with its sender label', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'message',
      text: 'heads up, I own auth.ts',
      from: 'agent',
      fromLabel: 'Fix login (r-abc123)',
    };
    expect(formatEntry(entry)).toBe(
      '[message from Fix login (r-abc123)] heads up, I own auth.ts'
    );
  });

  it('renders an unlabelled agent message with the generic sender', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'message',
      text: 'ping',
      from: 'agent',
    };
    expect(formatEntry(entry)).toBe('[message from another agent] ping');
  });

  it('renders this run\'s own message to the human as "to you"', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'message',
      text: 'the migration looks risky',
      from: 'agent',
      toUser: true,
    };
    expect(formatEntry(entry)).toBe(
      '[message to you] the migration looks risky'
    );
  });

  it('renders a human message from the Session composer', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'message',
      text: 'use the v2 endpoint',
      from: 'user',
    };
    expect(formatEntry(entry)).toBe('[message from user] use the v2 endpoint');
  });

  it('returns null for an entry with no text and no special handling', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'usage',
    };
    expect(formatEntry(entry)).toBeNull();
  });
});

describe('formatApprovalRequest', () => {
  it('prints the commands that answer the gate', () => {
    const text = formatApprovalRequest({
      runId: 'r-1',
      requestId: 'fake-approval-1',
      tool: 'run_shell',
    });
    expect(text).toContain('tool:    run_shell');
    expect(text).toContain('approve: dispatch approve r-1 fake-approval-1');
    expect(text).toContain(
      'deny:    dispatch approve r-1 fake-approval-1 --deny'
    );
  });

  it('without the gate, prints the commands that find it by run', () => {
    const text = formatApprovalRequest({ runId: 'r-1' });
    expect(text).toContain('=== approval requested ===');
    expect(text).not.toContain('tool:');
    expect(text).toContain('approve: dispatch approve r-1\n');
    expect(text).toContain('deny:    dispatch approve r-1 --deny');
  });

  it('toolApprovalOf reads the run, request and tool off a run gate', () => {
    expect(toolApprovalOf(GATE)).toEqual({
      runId: 'r-1',
      requestId: 'fake-approval-1',
      tool: 'run_shell',
    });
  });

  it('toolApprovalOf ignores anything that is not a tool-approval gate', () => {
    expect(
      toolApprovalOf({
        ...GATE,
        data: { type: 'scope', paths: ['a'], reason: 'r' },
      })
    ).toBeNull();
    expect(toolApprovalOf({ ...GATE, data: undefined })).toBeNull();
  });

  it("toolApprovalOf ignores an overseer conversation's approval, which has no run", () => {
    expect(
      toolApprovalOf({
        ...GATE,
        data: {
          type: 'tool-approval',
          requestId: 'oa-1',
          conversation: 'o-1',
          tool: 'run_shell',
          input: {},
        },
      })
    ).toBeNull();
  });
});

describe('formatRunsTable', () => {
  const run: RunMeta = {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Some task',
    executor: 'fake',
    state: 'finished',
    branch: 'dispatch/t-1-x',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
    costUsd: 0.05,
  };

  it('renders a header and one row per run', () => {
    const table = formatRunsTable([run]);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/RUN\s+TASK\s+STATE\s+BRANCH\s+COST/);
    expect(lines[1]).toContain('r-1');
    expect(lines[1]).toContain('t-1');
    expect(lines[1]).toContain('finished');
    expect(lines[1]).toContain('$0.05');
  });

  it('defaults a missing cost to $0.00', () => {
    const table = formatRunsTable([{ ...run, costUsd: undefined }]);
    expect(table).toContain('$0.00');
  });

  it('renders (none) for an empty list', () => {
    expect(formatRunsTable([])).toBe('(none)');
  });
});

describe('formatDiffFiles', () => {
  it('renders (no changes) for an empty diff', () => {
    expect(formatDiffFiles([])).toBe('(no changes)');
  });

  it('renders one row per changed file', () => {
    const files: DiffFile[] = [
      { path: 'a.txt', status: 'M' },
      { path: 'b.txt', status: 'A' },
    ];
    const table = formatDiffFiles(files);
    expect(table).toContain('M');
    expect(table).toContain('a.txt');
    expect(table).toContain('A');
    expect(table).toContain('b.txt');
  });
});

describe('formatProposal', () => {
  it('numbers tasks and renders a dependency arrow for blocked ones', () => {
    const proposal: PlanProposal = {
      epic: { title: 'Ship the widget', description: '...' },
      tasks: [
        {
          title: 'Design',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'high',
        },
        {
          title: 'Implement',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [0],
          priority: 'medium',
        },
      ],
    };
    const text = formatProposal(proposal);
    expect(text).toContain('Epic: Ship the widget');
    expect(text).toContain('0. Design [high]');
    expect(text).toContain('1. Implement [medium]');
    expect(text).toContain('blocked by 0');
  });

  it('omits the epic line for a flat proposal with no epic', () => {
    const proposal: PlanProposal = {
      tasks: [
        {
          title: 'Solo task',
          description: '',
          acceptanceCriteria: [],
          blockedByIndices: [],
          priority: 'none',
        },
      ],
    };
    expect(formatProposal(proposal)).not.toContain('Epic:');
  });
});

describe('formatEpicProgress', () => {
  const run: RunMeta = {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Child',
    executor: 'fake',
    state: 'running',
    branch: 'b',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
  };

  function session(overrides: Partial<EpicSession> = {}): EpicSession {
    return {
      epicId: 'e-1',
      concurrency: 4,
      executor: 'fake',
      state: 'active',
      maxSpendUsd: 60,
      maxRuns: 20,
      startedAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
      active: true,
      ...overrides,
    };
  }

  function spend(overrides: Partial<EpicSpend> = {}): EpicSpend {
    return {
      settledUsd: 41.2,
      liveCount: 3,
      estimatedLiveUsd: 30,
      runsStarted: 7,
      maxSpendUsd: 60,
      maxRuns: 20,
      ...overrides,
    };
  }

  function child(
    overrides: Partial<EpicProgressChild> = {}
  ): EpicProgressChild {
    return {
      id: 't-1',
      title: 'Child',
      status: 'in-progress',
      phase: 'working',
      wave: 1,
      openFindings: 0,
      ...overrides,
    };
  }

  function progress(overrides: Partial<EpicProgress> = {}): EpicProgress {
    return {
      epicId: 'e-1',
      active: true,
      concurrency: 4,
      session: session(),
      spend: spend(),
      children: [child()],
      waves: [{ index: 1, total: 1, byPhase: { working: 1 } }],
      liveRuns: [run],
      ...overrides,
    };
  }

  it('renders the session state, concurrency, children, and live runs', () => {
    const text = formatEpicProgress(progress());
    expect(text).toContain('epic e-1: active (concurrency 4)');
    expect(text).toContain('t-1');
    expect(text).toContain('live runs:');
    expect(text).toContain('r-1');
  });

  it('renders the spend line with both ceilings', () => {
    const text = formatEpicProgress(progress());
    expect(text).toContain(
      'spend $41.20 settled + ~$30.00 in flight of $60.00 · 7/20 runs'
    );
  });

  it('drops the ceiling halves of the spend line when neither is set', () => {
    const text = formatEpicProgress(
      progress({
        session: session({ maxSpendUsd: null, maxRuns: null }),
        spend: spend({ maxSpendUsd: null, maxRuns: null }),
      })
    );
    expect(text).toContain('spend $41.20 settled + ~$30.00 in flight · 7 runs');
    expect(text).not.toContain(' of $');
  });

  it('prints wave and phase per child', () => {
    const text = formatEpicProgress(
      progress({
        children: [
          child(),
          child({ id: 't-2', title: 'Later', phase: 'waiting', wave: 2 }),
        ],
      })
    );
    const lines = text.split('\n');
    const header = lines.find((l) => l.startsWith('ID'));
    expect(header).toMatch(/ID\s+WAVE\s+PHASE\s+STATUS\s+TITLE$/);
    expect(lines.find((l) => l.startsWith('t-1'))).toMatch(
      /t-1\s+1\s+working\s+in-progress\s+Child/
    );
    expect(lines.find((l) => l.startsWith('t-2'))).toMatch(
      /t-2\s+2\s+waiting\s+in-progress\s+Later/
    );
  });

  it('adds a REASON column only when some child carries one', () => {
    const text = formatEpicProgress(
      progress({
        children: [
          child(),
          child({
            id: 't-2',
            phase: 'blocked',
            reason: 'blocked by t-9 (failed)',
          }),
        ],
      })
    );
    const lines = text.split('\n');
    expect(lines.find((l) => l.startsWith('ID'))).toMatch(/REASON$/);
    expect(lines.find((l) => l.startsWith('t-2'))).toContain(
      'blocked by t-9 (failed)'
    );
    expect(formatEpicProgress(progress())).not.toContain('REASON');
  });

  it('prints the paused reason under the header', () => {
    const text = formatEpicProgress(
      progress({
        active: false,
        session: session({
          state: 'paused',
          pausedReason: 'budget',
          active: false,
        }),
      })
    );
    expect(text).toContain('epic e-1: paused (concurrency 4)');
    expect(text).toContain('paused — spend ceiling reached');
  });

  it('carries the fill failure detail into the paused line', () => {
    const text = formatEpicProgress(
      progress({
        active: false,
        session: session({
          state: 'paused',
          pausedReason: 'fill-failed',
          pausedDetail: 'worktree add failed',
          active: false,
        }),
      })
    );
    expect(text).toContain(
      'paused — auto-dispatch failed: worktree add failed'
    );
  });

  it('falls back to active/inactive for an epic that was never dispatched', () => {
    const text = formatEpicProgress(
      progress({
        active: false,
        concurrency: undefined,
        session: null,
        spend: spend({
          settledUsd: 0,
          liveCount: 0,
          estimatedLiveUsd: 0,
          runsStarted: 0,
          maxSpendUsd: null,
          maxRuns: null,
        }),
        children: [],
        waves: [],
        liveRuns: [],
      })
    );
    expect(text).toContain('epic e-1: inactive');
    expect(text).not.toContain('concurrency');
    expect(text).not.toContain('paused');
    expect(text).not.toContain('live runs:');
  });
});

describe('formatPlanNeedsReply', () => {
  function record(overrides: Partial<PlanRecord> = {}): PlanRecord {
    return {
      id: 'plan-1',
      prompt: 'add search',
      state: 'ready',
      messages: [],
      questions: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  it('lists the questions, their options, and the reply command', () => {
    const text = formatPlanNeedsReply(
      record({
        messages: [
          { role: 'user', text: 'add search', at: '2026-01-01T00:00:00Z' },
          {
            role: 'assistant',
            text: 'A couple of things first.',
            at: '2026-01-01T00:00:01Z',
          },
        ],
        questions: [
          { id: 'q1', question: 'Which backend?', options: ['sqlite', 'pg'] },
        ],
      })
    );
    expect(text).toContain('A couple of things first.');
    expect(text).toContain('1. Which backend?');
    expect(text).toContain('sqlite | pg');
    expect(text).toContain('dispatch plan reply plan-1');
  });

  it('still points at the reply command when there are no questions', () => {
    const text = formatPlanNeedsReply(record());
    expect(text).toContain('did not propose any tasks');
    expect(text).toContain('dispatch plan reply plan-1');
  });
});

describe('exitCodeForRunState', () => {
  it('maps finished to 0', () => {
    expect(exitCodeForRunState('finished')).toBe(0);
  });
  it('maps failed to 1', () => {
    expect(exitCodeForRunState('failed')).toBe(1);
  });
  it('maps cancelled to 130', () => {
    expect(exitCodeForRunState('cancelled')).toBe(130);
  });
  // Without this, --watch reads the state as "still running" and waits for an
  // exit that already happened.
  it('maps interrupted-dirty to 1, like the failed run it came from', () => {
    expect(exitCodeForRunState('interrupted-dirty')).toBe(1);
  });
  it('returns null for a non-terminal state', () => {
    expect(exitCodeForRunState('running')).toBeNull();
    expect(exitCodeForRunState('provisioning')).toBeNull();
    expect(exitCodeForRunState('awaiting-approval')).toBeNull();
  });
});
