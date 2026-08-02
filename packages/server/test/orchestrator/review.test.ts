import { TaskStore } from '@dispatch/core';
import type { Finding, TaskDoc, TaskRisk } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FindingStore } from '../../src/findings.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import {
  buildDiffPackage,
  buildReviewPrompt,
  parseReviewOutput,
  reviewModelForRisk,
  ReviewRunner,
  scanDestructiveWrites,
  sharedSurfaceWrites,
} from '../../src/orchestrator/review.js';
import type { ReviewPromptInput } from '../../src/orchestrator/review.js';
import { Transcript } from '../../src/orchestrator/transcript.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../../src/orchestrator/types.js';
import { runKind } from '../../src/orchestrator/types.js';
import { initGitRepo, runGitSync } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-review-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function taskDoc(risk: TaskRisk, writes: string[] = []): TaskDoc {
  return {
    meta: {
      id: 't-abc123',
      title: 'harden the sync path',
      status: 'in-review',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'none',
      assignee: 'agent',
      created: '2026-08-02T00:00:00.000Z',
      updated: '2026-08-02T00:00:00.000Z',
      external: null,
      selfReview: true,
      writes,
      risk,
      model: null,
    },
    body: '## Description\n\nMake first-run sync non-destructive.\n',
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-000001',
    taskId: 't-abc123',
    runId: 'r-000001',
    severity: 'critical',
    verdict: 'open',
    title: 'first sync overwrites the external workspace',
    detail: 'seeds from empty local state\nsecond line',
    file: null,
    line: null,
    ruling: null,
    round: 0,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

function promptInput(
  overrides: Partial<ReviewPromptInput> = {}
): ReviewPromptInput {
  return {
    task: taskDoc('routine'),
    round: 0,
    scope: 'full',
    base: 'aaaa111',
    head: 'bbbb222',
    openFindings: [],
    extraRisks: [],
    packagePath: '/runs/r-1.review/diff-package.md',
    outputPath: '/runs/r-1.review/findings.json',
    worktreePath: '/worktrees/r-1',
    sharedSurfaces: [],
    destructive: [],
    ...overrides,
  };
}

describe('buildReviewPrompt risk tiers', () => {
  it('omits risk-derived checks entirely for a routine task', () => {
    const prompt = buildReviewPrompt(promptInput());
    expect(prompt).not.toContain('## Risk-derived checks');
    expect(prompt).not.toContain('blast radius');
    expect(prompt).toContain('## Spec compliance');
    expect(prompt).toContain('## Quality');
  });

  it('adds blast-radius checks for an elevated task and no empirical mandate', () => {
    const prompt = buildReviewPrompt(
      promptInput({ task: taskDoc('elevated') })
    );
    expect(prompt).toContain('## Risk-derived checks');
    expect(prompt).toContain('blast radius');
    expect(prompt).toContain('`elevated` risk');
    expect(prompt).not.toContain('is `critical`');
    expect(prompt).not.toContain('`recommendation` field');
  });

  it('requires a blocks-or-park recommendation and empirical proof for critical', () => {
    const prompt = buildReviewPrompt(
      promptInput({ task: taskDoc('critical') })
    );
    expect(prompt).toContain('## Risk-derived checks');
    expect(prompt).toContain('blast radius');
    expect(prompt).toContain('is `critical`');
    expect(prompt).toContain('`recommendation` field');
    expect(prompt).toContain('Verify each claim by running it');
    expect(prompt).toContain('could not verify');
  });

  it('requires checking every consumer when writes touch a shared surface', () => {
    const prompt = buildReviewPrompt(
      promptInput({
        task: taskDoc('elevated', ['packages/core/src/types.ts']),
        sharedSurfaces: ['packages/core/src/types.ts'],
      })
    );
    expect(prompt).toContain('shared surfaces: packages/core/src/types.ts');
    expect(prompt).toContain('EVERY consumer');
    expect(prompt).toContain('hand-mirrored copy');
  });

  it('requires probing the real tool when writes perform destructive work', () => {
    const prompt = buildReviewPrompt(
      promptInput({
        task: taskDoc('elevated', ['src/sync.ts']),
        destructive: [{ path: 'src/sync.ts', marker: 'git checkout' }],
      })
    );
    expect(prompt).toContain(
      'destructive operations: src/sync.ts (git checkout)'
    );
    expect(prompt).toContain('Do not review these by reading');
    expect(prompt).toContain('FIRST run against pre-existing state');
  });
});

describe('buildReviewPrompt framing and inputs', () => {
  it('names the diff package by path and never inlines the diff', () => {
    const prompt = buildReviewPrompt(promptInput());
    expect(prompt).toContain('/runs/r-1.review/diff-package.md');
    expect(prompt).toContain('/worktrees/r-1');
    expect(prompt).toContain('Read the diff package with your file tools');
    expect(prompt).not.toContain('@@');
  });

  it('says a stated rationale never downgrades a finding', () => {
    const prompt = buildReviewPrompt(promptInput());
    expect(prompt).toContain('are claims, not evidence');
    expect(prompt).toContain('A stated rationale never downgrades a finding');
  });

  it('appends extraRisks verbatim', () => {
    const prompt = buildReviewPrompt(
      promptInput({
        extraRisks: [
          'the header change touches twelve live endpoints — check each',
        ],
      })
    );
    expect(prompt).toContain('## Specific risks to check');
    expect(prompt).toContain(
      '- the header change touches twelve live endpoints — check each'
    );
  });

  it('names the open findings when the scope is a fix', () => {
    const prompt = buildReviewPrompt(
      promptInput({
        scope: 'fix',
        round: 1,
        openFindings: [
          finding(),
          finding({
            id: 'f-000002',
            severity: 'minor',
            title: 'unused import',
            detail: 'left behind',
          }),
        ],
      })
    );
    expect(prompt).toContain('## Scope: this is a re-review of a fix');
    expect(prompt).toContain(
      '- [f-000001] critical: first sync overwrites the external workspace'
    );
    expect(prompt).toContain('- [f-000002] minor: unused import');
    expect(prompt).toContain('Judge only the diff between aaaa111 and bbbb222');
  });

  it('leaves the fix section out of a full review', () => {
    const prompt = buildReviewPrompt(
      promptInput({ openFindings: [finding()] })
    );
    expect(prompt).not.toContain('re-review of a fix');
    expect(prompt).not.toContain('f-000001');
  });
});

describe('reviewModelForRisk', () => {
  const models = {
    execute: 'opus',
    plan: 'sonnet',
    draft: 'haiku',
    enrich: 'haiku',
    cluster: 'haiku',
    summarize: 'haiku',
  };

  it('reviews routine work on the planning tier and the rest on the coding tier', () => {
    expect(reviewModelForRisk('routine', models)).toBe('sonnet');
    expect(reviewModelForRisk('elevated', models)).toBe('opus');
    expect(reviewModelForRisk('critical', models)).toBe('opus');
  });
});

describe('write-set classification', () => {
  it('recognizes barrels, type modules and declaration files', () => {
    expect(
      sharedSurfaceWrites([
        'packages/core/src/index.ts',
        'packages/core/src/types.ts',
        'packages/core/src/configTypes.ts',
        'packages/server/src/global.d.ts',
        'apps/desktop/src/App.tsx',
      ])
    ).toEqual([
      'packages/core/src/index.ts',
      'packages/core/src/types.ts',
      'packages/core/src/configTypes.ts',
      'packages/server/src/global.d.ts',
    ]);
  });

  it('finds destructive markers inside the declared writes only', () => {
    writeFileSync(join(repo, 'danger.ts'), 'rmSync(dir, { recursive: true });');
    writeFileSync(
      join(repo, 'sync.ts'),
      "Bun.spawnSync(['git', 'checkout', '--', path]);\n"
    );
    writeFileSync(join(repo, 'safe.ts'), 'export const x = 1;\n');
    expect(scanDestructiveWrites(repo, ['sync.ts', 'safe.ts'])).toEqual([
      { path: 'sync.ts', marker: 'git checkout' },
    ]);
  });
});

describe('parseReviewOutput', () => {
  it('parses a bare findings object', () => {
    const result = parseReviewOutput(
      JSON.stringify({
        findings: [
          {
            severity: 'important',
            title: 'swallowed rejection',
            detail: 'the catch is dead code',
            file: 'src/a.ts',
            line: 12,
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toEqual([
      {
        severity: 'important',
        title: 'swallowed rejection',
        detail: 'the catch is dead code',
        file: 'src/a.ts',
        line: 12,
        recommendation: null,
      },
    ]);
  });

  it('parses a fenced block inside a longer message', () => {
    const result = parseReviewOutput(
      'Here is what I found.\n\n```json\n{"findings":[{"severity":"critical","title":"t","detail":"d","recommendation":"blocks"}]}\n```\n'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings[0].recommendation).toBe('blocks');
  });

  it('accepts an explicit empty findings array', () => {
    const result = parseReviewOutput('{"findings": []}');
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it('rejects an unknown severity rather than dropping the entry', () => {
    const result = parseReviewOutput(
      '{"findings":[{"severity":"blocker","title":"t","detail":"d"}]}'
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a finding missing its detail', () => {
    const result = parseReviewOutput(
      '{"findings":[{"severity":"minor","title":"t"}]}'
    );
    expect(result.ok).toBe(false);
  });

  it('rejects prose, a non-array findings field, and unparsable JSON', () => {
    expect(parseReviewOutput('looks fine to me').ok).toBe(false);
    expect(parseReviewOutput('{"findings": "none"}').ok).toBe(false);
    expect(parseReviewOutput('{"findings": [').ok).toBe(false);
  });
});

describe('buildDiffPackage', () => {
  it('carries the commit list, the stat and the full diff', () => {
    const base = runGitSync(repo, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(repo, 'added.txt'), 'hello\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'add a file']);
    const head = runGitSync(repo, ['rev-parse', 'HEAD']).trim();

    const pkg = buildDiffPackage(repo, base, head);
    expect(pkg).toContain('add a file');
    expect(pkg).toContain('added.txt');
    expect(pkg).toContain('+hello');
  });
});

// Writes `output` to the findings path the rubric named, then finishes — the
// smallest stand-in that still exercises the real prompt/file contract.
class ScriptedReviewer implements Executor {
  lastPrompt = '';

  constructor(private readonly output: string | null) {}

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    this.lastPrompt = opts.prompt;
    const match = /as one JSON object: (\S+)/.exec(opts.prompt);
    setTimeout(() => {
      if (this.output !== null && match !== null) {
        writeFileSync(match[1], this.output);
      }
      events.onFinish({ state: 'finished' });
    }, 0);
    return {
      interrupt: async () => {},
      send: () => {},
      approve: () => {},
    };
  }
}

function setupReview(reviewer: Executor): {
  orchestrator: Orchestrator;
  runner: ReviewRunner;
  findingStore: FindingStore;
  store: TaskStore;
} {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
  });
  orchestrator.registerExecutor('claude', reviewer);
  const findingStore = new FindingStore(repo);
  const runner = new ReviewRunner({
    rootDir: repo,
    store,
    findingStore,
    events,
    orchestrator,
  });
  return { orchestrator, runner, findingStore, store };
}

function commitRange(): { base: string; head: string } {
  const base = runGitSync(repo, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(repo, 'src.ts'), 'export const answer = 42;\n');
  runGitSync(repo, ['add', 'src.ts']);
  runGitSync(repo, ['commit', '-m', 'add src']);
  return { base, head: runGitSync(repo, ['rev-parse', 'HEAD']).trim() };
}

describe('ReviewRunner', () => {
  it('dispatches a review run and turns its structured output into findings', async () => {
    const reviewer = new ScriptedReviewer(
      JSON.stringify({
        findings: [
          {
            severity: 'critical',
            title: 'checkout discards uncommitted work',
            detail: 'probed against a scratch clone',
            file: 'src.ts',
            line: 1,
            recommendation: 'blocks',
          },
          { severity: 'minor', title: 'stray import', detail: 'unused' },
        ],
      })
    );
    const { orchestrator, runner, findingStore, store } = setupReview(reviewer);
    const task = store.create({ title: 'harden sync', risk: 'critical' });
    const { base, head } = commitRange();

    const meta = await runner.startReview({
      taskId: task.meta.id,
      base,
      head,
      round: 0,
      scope: 'full',
      openFindings: [],
    });
    expect(runKind(meta)).toBe('review');
    expect(meta.model).toBe('claude-opus-5');

    await waitFor(
      () => findingStore.list({ taskId: task.meta.id }).length === 2
    );
    const findings = findingStore.openFor(task.meta.id);
    const blocking = findings.find((f) => f.severity === 'critical');
    expect(blocking?.title).toBe('checkout discards uncommitted work');
    expect(blocking?.detail).toContain('Recommendation: blocks');
    expect(blocking?.file).toBe('src.ts');
    expect(blocking?.runId).toBe(meta.id);
    expect(orchestrator.getRun(meta.id)?.meta.state).toBe('finished');

    expect(reviewer.lastPrompt).toContain('Adversarial review');
    expect(reviewer.lastPrompt).toContain('## Risk-derived checks');
  });

  it('fails the review run when the structured output is malformed', async () => {
    const reviewer = new ScriptedReviewer(
      '{"findings":[{"severity":"showstopper","title":"t","detail":"d"}]}'
    );
    const { orchestrator, runner, findingStore, store } = setupReview(reviewer);
    const task = store.create({ title: 'harden sync', risk: 'elevated' });
    const { base, head } = commitRange();

    const meta = await runner.startReview({
      taskId: task.meta.id,
      base,
      head,
      round: 0,
      scope: 'full',
      openFindings: [],
    });

    await waitFor(() => orchestrator.getRun(meta.id)?.meta.state === 'failed');
    const run = orchestrator.getRun(meta.id);
    expect(run?.meta.error).toContain('unusable findings output');
    expect(findingStore.list({ taskId: task.meta.id })).toEqual([]);
  });

  it('fails the review run when no structured output is produced at all', async () => {
    const { orchestrator, runner, findingStore, store } = setupReview(
      new ScriptedReviewer(null)
    );
    const task = store.create({ title: 'harden sync', risk: 'routine' });
    const { base, head } = commitRange();

    const meta = await runner.startReview({
      taskId: task.meta.id,
      base,
      head,
      round: 0,
      scope: 'full',
      openFindings: [],
    });

    await waitFor(() => orchestrator.getRun(meta.id)?.meta.state === 'failed');
    expect(orchestrator.getRun(meta.id)?.meta.error).toContain(
      'no findings output was produced'
    );
    expect(findingStore.list({ taskId: task.meta.id })).toEqual([]);
  });
});

describe('RunMeta.kind', () => {
  it('reads a transcript header written before run kinds existed as execute', () => {
    const path = join(fakeHome, 'legacy.jsonl');
    const transcript = new Transcript(path);
    transcript.writeHeader({
      id: 'r-legacy',
      taskId: 't-legacy',
      taskTitle: 'old work',
      executor: 'claude',
      state: 'finished',
      branch: 'dispatch/old',
      baseBranch: 'main',
      worktreePath: '/tmp/old',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const replayed = new Transcript(path).read();
    expect(replayed).toHaveLength(1);
    const header = replayed[0];
    expect(header.type).toBe('header');
    if (header.type !== 'header') return;
    expect(header.meta.kind).toBeUndefined();
    expect(runKind(header.meta)).toBe('execute');
  });
});
