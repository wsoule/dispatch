import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectHotspots } from '../../src/orchestrator/hotspots.js';
import { runsDir } from '../../src/orchestrator/paths.js';

// Every path helper resolves under DISPATCH_HOME, so tests that skip this
// redirect write into the developer's real ~/.dispatch, one hash-keyed
// directory per temp rootDir, forever (see task t-9e0f00).
const originalDispatchHome = process.env.DISPATCH_HOME;
let fakeHome: string;
let rootDir: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-hotspots-home-'));
  rootDir = mkdtempSync(join(tmpdir(), 'dispatch-hotspots-root-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

// Writes a transcript shaped like a real one: a header carrying the run's
// worktree path (which is what makes absolute tool paths rebasable onto the
// repo root) followed by one `tool` entry per file the run touched.
function writeTranscript(
  runId: string,
  files: { path: string; tool?: string }[]
): void {
  const dir = runsDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const worktreePath = `/tmp/worktrees/${runId}`;
  const lines = [
    JSON.stringify({
      type: 'header',
      meta: { id: runId, worktreePath },
    }),
    ...files.map((f) =>
      JSON.stringify({
        type: 'entry',
        entry: {
          ts: '2026-08-03T00:00:00.000Z',
          kind: 'tool',
          toolName: f.tool ?? 'Read',
          toolInput: { file_path: `${worktreePath}/${f.path}` },
        },
      })
    ),
  ];
  writeFileSync(join(dir, `${runId}.jsonl`), `${lines.join('\n')}\n`);
}

describe('collectHotspots', () => {
  it('returns nothing when the project has no transcripts at all', () => {
    expect(collectHotspots(rootDir)).toEqual([]);
  });

  it('reports a file touched by enough distinct runs, as a repo-relative path', () => {
    for (const runId of ['r-aaa111', 'r-bbb222', 'r-ccc333']) {
      writeTranscript(runId, [{ path: 'packages/server/src/api.ts' }]);
    }
    expect(collectHotspots(rootDir, { minRuns: 3 })).toEqual([
      { path: 'packages/server/src/api.ts', runs: 3 },
    ]);
  });

  it('ignores a file only one run ever touched', () => {
    writeTranscript('r-aaa111', [
      { path: 'packages/server/src/api.ts' },
      { path: 'packages/server/src/lonely.ts' },
    ]);
    writeTranscript('r-bbb222', [{ path: 'packages/server/src/api.ts' }]);
    const hotspots = collectHotspots(rootDir, { minRuns: 2 });
    expect(hotspots.map((h) => h.path)).toEqual(['packages/server/src/api.ts']);
  });

  it('counts distinct runs, not raw touches, so one busy run cannot manufacture a hotspot', () => {
    // 20 touches from a single run must not outrank a file two runs share.
    writeTranscript(
      'r-busy11',
      Array.from({ length: 20 }, () => ({ path: 'packages/web/src/grind.ts' }))
    );
    writeTranscript('r-aaa111', [{ path: 'packages/server/src/api.ts' }]);
    writeTranscript('r-bbb222', [{ path: 'packages/server/src/api.ts' }]);
    expect(collectHotspots(rootDir, { minRuns: 2 })).toEqual([
      { path: 'packages/server/src/api.ts', runs: 2 },
    ]);
  });

  it('counts Edit and Write alongside Read', () => {
    writeTranscript('r-aaa111', [
      { path: 'packages/core/src/types.ts', tool: 'Edit' },
    ]);
    writeTranscript('r-bbb222', [
      { path: 'packages/core/src/types.ts', tool: 'Write' },
    ]);
    expect(collectHotspots(rootDir, { minRuns: 2 })).toEqual([
      { path: 'packages/core/src/types.ts', runs: 2 },
    ]);
  });

  it('drops skills, build output, and vendored paths as noise', () => {
    const noisy = [
      { path: '.agents/skills/testing-and-verification/SKILL.md' },
      { path: 'node_modules/react/index.js' },
      { path: 'packages/server/dist/index.js' },
      { path: 'dist/bundle.js' },
    ];
    writeTranscript('r-aaa111', noisy);
    writeTranscript('r-bbb222', noisy);
    expect(collectHotspots(rootDir, { minRuns: 2 })).toEqual([]);
  });

  it('ignores tool calls whose paths lie outside the run worktree', () => {
    const dir = runsDir(rootDir);
    mkdirSync(dir, { recursive: true });
    const line = (runId: string) =>
      [
        JSON.stringify({
          type: 'header',
          meta: { id: runId, worktreePath: `/tmp/worktrees/${runId}` },
        }),
        JSON.stringify({
          type: 'entry',
          entry: {
            ts: '2026-08-03T00:00:00.000Z',
            kind: 'tool',
            toolName: 'Read',
            toolInput: { file_path: '/etc/hosts' },
          },
        }),
      ].join('\n');
    writeFileSync(join(dir, 'r-aaa111.jsonl'), `${line('r-aaa111')}\n`);
    writeFileSync(join(dir, 'r-bbb222.jsonl'), `${line('r-bbb222')}\n`);
    expect(collectHotspots(rootDir, { minRuns: 2 })).toEqual([]);
  });

  it('survives a corrupt transcript, keeping the evidence from the good ones', () => {
    const dir = runsDir(rootDir);
    mkdirSync(dir, { recursive: true });
    writeTranscript('r-aaa111', [{ path: 'packages/server/src/api.ts' }]);
    writeTranscript('r-bbb222', [{ path: 'packages/server/src/api.ts' }]);
    writeFileSync(join(dir, 'r-broken.jsonl'), '{not json at all\n');
    expect(collectHotspots(rootDir, { minRuns: 2 })).toEqual([
      { path: 'packages/server/src/api.ts', runs: 2 },
    ]);
  });

  it('ranks by run count and caps the list at `limit`', () => {
    writeTranscript('r-aaa111', [{ path: 'a.ts' }, { path: 'b.ts' }]);
    writeTranscript('r-bbb222', [{ path: 'a.ts' }, { path: 'b.ts' }]);
    writeTranscript('r-ccc333', [{ path: 'a.ts' }]);
    const hotspots = collectHotspots(rootDir, { minRuns: 2, limit: 1 });
    expect(hotspots).toEqual([{ path: 'a.ts', runs: 3 }]);
  });
});
