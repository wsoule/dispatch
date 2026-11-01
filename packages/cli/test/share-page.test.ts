import { describe, expect, test } from 'bun:test';

import type { RunMeta } from '../src/apiClient.js';
import { buildPacket } from '../src/commands/share.js';
import type { RunPacket } from '../src/sharePage.js';
import { renderSharePage } from '../src/sharePage.js';

const run: RunMeta = {
  id: 'r-abc123',
  taskId: 't-def456',
  taskTitle: 'Add the widget',
  executor: 'claude',
  state: 'finished',
  branch: 'dispatch/t-def456',
  baseBranch: 'main',
  worktreePath: '/tmp/wt',
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:20:00.000Z',
};

function packet(over: Partial<RunPacket> = {}): RunPacket {
  return {
    generatedAt: '2026-09-22T12:00:00.000Z',
    run,
    diff: { patch: '', files: [] },
    entries: [],
    evidence: [],
    findings: [],
    ledger: [],
    ...over,
  };
}

// One ledger row, varying only the field buildPacket filters on.
function entry(id: string, appliesTo: string[]) {
  return {
    id,
    milestoneId: null,
    sourceTaskId: null,
    kind: 'decision' as const,
    title: id,
    detail: '',
    appliesTo,
    createdAt: '2026-09-22T10:00:00.000Z',
    authoredBy: 'human:wyat',
  };
}

describe('renderSharePage', () => {
  test('stands on its own with no network', () => {
    const html = renderSharePage(packet());

    // The whole promise of `dispatch share` is a file you can hand to anyone.
    // A remote stylesheet, font or script would break it on a plane or behind
    // a firewall, and would leak that the page was opened.
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('<script');
    expect(html).toContain('<style>');
  });

  test('leads with the facts someone checks first', () => {
    const html = renderSharePage(
      packet({ run: { ...run, costUsd: 1.234, turns: 12, model: 'opus' } })
    );

    expect(html).toContain('Add the widget');
    expect(html).toContain('r-abc123');
    expect(html).toContain('dispatch/t-def456 → main');
    expect(html).toContain('$1.23');
    expect(html).toContain('claude · opus');
  });

  test('escapes repo content instead of trusting it as markup', () => {
    // Every value on this page is agent output, a commit message or a file
    // path. A run whose task title closes a tag must not be able to rewrite
    // the page for whoever opens it.
    const html = renderSharePage(
      packet({
        run: { ...run, taskTitle: '</title><script>alert(1)</script>' },
      })
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes a diff that contains markup', () => {
    const html = renderSharePage(
      packet({
        diff: {
          patch: '+const html = "<img onerror=alert(1)>";',
          files: [{ path: 'src/a.ts', status: 'M' }],
        },
      })
    );

    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;img onerror');
  });

  test('colours the patch by line so a diff reads as a diff', () => {
    const html = renderSharePage(
      packet({
        diff: {
          patch: '@@ -1,2 +1,2 @@\n-old line\n+new line\n context',
          files: [{ path: 'src/a.ts', status: 'M' }],
        },
      })
    );

    expect(html).toContain('<span class="hunk">@@ -1,2 +1,2 @@</span>');
    expect(html).toContain('<span class="del">-old line</span>');
    expect(html).toContain('<span class="add">+new line</span>');
    expect(html).toContain('src/a.ts');
  });

  test('omits a section with nothing in it rather than printing an empty heading', () => {
    const html = renderSharePage(packet());

    // A page of empty headings reads as broken; a shorter page reads as a run
    // that simply had no findings.
    expect(html).not.toContain('>Findings<');
    expect(html).not.toContain('>Diff<');
    expect(html).not.toContain('>Transcript<');
    expect(html).toContain('>Summary<');
  });

  test('renders findings with their ruling', () => {
    const html = renderSharePage(
      packet({
        findings: [
          {
            id: 'f-111111',
            taskId: 't-def456',
            runId: 'r-abc123',
            severity: 'critical',
            verdict: 'open',
            title: 'Unbounded loop',
            detail: 'The retry never stops.',
            file: 'src/retry.ts',
            line: 42,
            ruling: 'Fix before merge',
            round: 0,
            createdAt: '2026-09-22T10:10:00.000Z',
            updatedAt: '2026-09-22T10:10:00.000Z',
            raisedBy: 'agent:wyat/claude',
          },
        ],
      })
    );

    expect(html).toContain('Unbounded loop');
    expect(html).toContain('src/retry.ts:42');
    expect(html).toContain('Ruling: Fix before merge');
    expect(html).toContain('sev-critical');
  });

  test('keeps the transcript but drops thinking and usage entries', () => {
    const html = renderSharePage(
      packet({
        entries: [
          {
            ts: '2026-09-22T10:01:00.000Z',
            kind: 'assistant',
            text: 'Doing the thing',
          },
          {
            ts: '2026-09-22T10:02:00.000Z',
            kind: 'thinking',
            text: 'SECRET SCRATCH',
          },
          {
            ts: '2026-09-22T10:03:00.000Z',
            kind: 'usage',
            text: '1000 tokens',
          },
          { ts: '2026-09-22T10:04:00.000Z', kind: 'tool', toolName: 'Edit' },
        ],
      })
    );

    expect(html).toContain('Doing the thing');
    expect(html).toContain('tool · Edit');
    // Scratch work is not a record of what happened, and accounting is
    // already in the header.
    expect(html).not.toContain('SECRET SCRATCH');
    expect(html).not.toContain('1000 tokens');
  });

  test("leaves out a tool call's result and its raw output", () => {
    const html = renderSharePage(
      packet({
        entries: [
          {
            ts: '2026-09-22T10:04:00.000Z',
            kind: 'tool',
            toolName: 'Bash',
            status: 'running',
          },
          {
            ts: '2026-09-22T10:05:00.000Z',
            kind: 'tool',
            status: 'done',
            text: 'GITHUB_TOKEN=ghp_secret',
          },
        ],
      })
    );

    expect(html).toContain('tool · Bash');
    expect(html).not.toContain('ghp_secret');
    expect(html).not.toContain('10:05:00');
  });

  test('marks a failed command distinctly from a passing one', () => {
    const html = renderSharePage(
      packet({
        evidence: [
          {
            command: 'bun test',
            exitCode: 1,
            durationMs: 500,
            summary: '3 failed',
            at: '2026-09-22T10:15:00.000Z',
          },
        ],
      })
    );

    expect(html).toContain('bun test');
    expect(html).toContain('class="bad"');
  });

  test('records the preview command rather than pretending to embed one', () => {
    const html = renderSharePage(packet({ previewCommand: 'pnpm run dev' }));

    // A static page cannot carry a live dev server; naming the command is
    // what makes the preview reproducible from the page.
    expect(html).toContain('Preview command');
    expect(html).toContain('pnpm run dev');
    expect(html).not.toContain('<iframe');
  });
});

describe('buildPacket', () => {
  test('keeps the decisions that govern this task and drops the rest', async () => {
    // The ledger is project-wide. A run's page should carry what governed
    // this work — entries naming its task, plus the project-wide ones — and
    // not every decision the project ever made.
    const client = {
      getRun: () =>
        Promise.resolve({
          meta: run,
          entries: [],
          evidence: [],
          mutations: [],
        }),
      getRunDiff: () => Promise.resolve({ patch: '', files: [] }),
      getTaskFindings: () => Promise.resolve([]),
      getLedger: () =>
        Promise.resolve([
          entry('l-000001', []),
          entry('l-000002', ['t-def456']),
          entry('l-000003', ['t-other']),
        ]),
    } as unknown as Parameters<typeof buildPacket>[0];

    const built = await buildPacket(client, 'r-abc123', () => new Date(0));

    expect(built.ledger.map((l) => l.id)).toEqual(['l-000001', 'l-000002']);
    expect(built.generatedAt).toBe('1970-01-01T00:00:00.000Z');
  });
});
