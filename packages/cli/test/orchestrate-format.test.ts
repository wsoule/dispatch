import { describe, expect, it } from 'bun:test';

import type {
  DiffFile,
  EpicProgress,
  NormalizedEntry,
  PlanProposal,
  RunMeta,
} from '../src/apiClient.js';
import {
  exitCodeForRunState,
  formatApprovalRequest,
  formatDiffFiles,
  formatEntry,
  formatEpicProgress,
  formatProposal,
  formatRunsTable,
} from '../src/orchestrateFormat.js';

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

  it('returns null for an entry with no text and no special handling', () => {
    const entry: NormalizedEntry = {
      ts: '2026-07-20T00:00:00Z',
      kind: 'usage',
    };
    expect(formatEntry(entry)).toBeNull();
  });
});

describe('formatApprovalRequest', () => {
  it('renders the exact approve/deny commands to copy', () => {
    const text = formatApprovalRequest('r-abc123', 'req-1', 'run_shell');
    expect(text).toContain('tool:    run_shell');
    expect(text).toContain('approve: dispatch approve r-abc123 req-1');
    expect(text).toContain('deny:    dispatch approve r-abc123 req-1 --deny');
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
  it('renders active state, concurrency, children, and live runs', () => {
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
    const progress: EpicProgress = {
      epicId: 'e-1',
      active: true,
      concurrency: 2,
      children: [{ id: 't-1', title: 'Child', status: 'in-progress' }],
      liveRuns: [run],
    };
    const text = formatEpicProgress(progress);
    expect(text).toContain('epic e-1: active');
    expect(text).toContain('concurrency 2');
    expect(text).toContain('t-1');
    expect(text).toContain('live runs:');
    expect(text).toContain('r-1');
  });

  it('omits the live-runs section when nothing is live', () => {
    const progress: EpicProgress = {
      epicId: 'e-1',
      active: false,
      children: [],
      liveRuns: [],
    };
    expect(formatEpicProgress(progress)).not.toContain('live runs:');
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
  it('returns null for a non-terminal state', () => {
    expect(exitCodeForRunState('running')).toBeNull();
    expect(exitCodeForRunState('provisioning')).toBeNull();
    expect(exitCodeForRunState('awaiting-approval')).toBeNull();
  });
});
