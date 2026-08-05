import { DEFAULT_FIX_LOOP } from '@dispatch/core';
import type { CommandEvidence, MutationEvidence } from '@dispatch/core';
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { actorFile, runsDir } from '../src/paths.js';
import { FINDINGS } from '../src/records.js';
import { RUN_STATES, TERMINAL_STATES, writeRuns } from '../src/runs.js';

function build(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'demo-runs-root-'));
  const home = mkdtempSync(join(tmpdir(), 'demo-runs-home-'));
  writeRuns(root, home, 'wsoule679');
  return { root, home };
}

// ---------------------------------------------------------------------------
// A real parser, not a regex: packages/server's package.json exports nothing
// but its own package.json, so `Transcript`/`replayTranscript` in
// packages/server/src/orchestrator/transcript.ts can't be imported from here
// (see runs.ts's own top-of-file comment on this boundary). This is a trimmed
// copy of that file's header-then-fold-state-lines replay logic — the same
// "copying the validator verbatim into a test is acceptable when the
// function is module-private" allowance the task brief gives, extended to
// "unreachable across a deliberate package boundary" for the same reason.
// ---------------------------------------------------------------------------

interface ReplayedRun {
  meta: {
    id: string;
    taskId: string;
    taskTitle: string;
    branch: string;
    baseBranch: string;
    kind?: string;
    resumedFrom?: string;
    reviewedAt?: string;
    archivedAt?: string;
    stopRequestedAt?: string;
  };
  state: string;
  entries: { kind: string; text?: string; [k: string]: unknown }[];
  evidence: CommandEvidence[];
  mutations: MutationEvidence[];
}

function readTranscript(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown);
}

// Mirrors replayTranscript(): the header supplies the base meta, then each
// later `state` line overrides state/updatedAt and folds in whatever finish
// fields it carried, exactly like the real reader.
function replay(path: string): ReplayedRun {
  const lines = readTranscript(path) as {
    type: string;
    meta?: ReplayedRun['meta'];
    entry?: ReplayedRun['entries'][number];
    evidence?: CommandEvidence;
    mutation?: MutationEvidence;
    state?: string;
    reviewedAt?: string;
    archivedAt?: string;
    stopRequestedAt?: string;
  }[];
  const header = lines.find((l) => l.type === 'header');
  if (header?.meta === undefined) {
    throw new Error(`${path}: no header line`);
  }
  let meta = header.meta;
  let state = 'provisioning';
  const entries: ReplayedRun['entries'] = [];
  const evidence: CommandEvidence[] = [];
  const mutations: MutationEvidence[] = [];
  for (const line of lines) {
    if (line.type === 'entry' && line.entry !== undefined) {
      entries.push(line.entry);
    } else if (line.type === 'evidence' && line.evidence !== undefined) {
      evidence.push(line.evidence);
    } else if (line.type === 'mutation' && line.mutation !== undefined) {
      mutations.push(line.mutation);
    } else if (line.type === 'state' && line.state !== undefined) {
      state = line.state;
      meta = {
        ...meta,
        reviewedAt: line.reviewedAt ?? meta.reviewedAt,
        archivedAt: line.archivedAt ?? meta.archivedAt,
        stopRequestedAt: line.stopRequestedAt ?? meta.stopRequestedAt,
      };
    }
  }
  return { meta, state, entries, evidence, mutations };
}

function allTranscripts(dir: string): ReplayedRun[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => replay(join(dir, f)));
}

// ---------------------------------------------------------------------------
// RunState mirror: same technique as packages/cli/test/run-state-mirror.test.ts
// (which hits the identical package-boundary problem for the CLI). Nothing in
// the type system notices when the server grows a run state runs.ts's
// hand-kept mirror never hears about, so this reads the server's own source.
// ---------------------------------------------------------------------------

function readOrchestratorTypesSource(): string {
  const pkgJsonPath = createRequire(import.meta.url).resolve(
    '@dispatch/server/package.json'
  );
  const source = readFileSync(
    join(dirname(pkgJsonPath), 'src', 'orchestrator', 'types.ts'),
    'utf8'
  );
  return source.replace(/\/\/.*$/gm, '');
}

function quotedStrings(block: string): string[] {
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

function serverRunStates(): string[] {
  const match = /export type RunState =([\s\S]*?);/.exec(
    readOrchestratorTypesSource()
  );
  if (match === null) throw new Error('no RunState union in server source');
  return quotedStrings(match[1] ?? '');
}

function serverTerminalRunStates(): string[] {
  const match =
    /export const TERMINAL_RUN_STATES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(
      readOrchestratorTypesSource()
    );
  if (match === null) {
    throw new Error('no TERMINAL_RUN_STATES set in server source');
  }
  return quotedStrings(match[1] ?? '');
}

test('RUN_STATES carries exactly the server RunState union', () => {
  const mirrored: string[] = [...RUN_STATES];
  expect(mirrored.sort()).toEqual(serverRunStates().sort());
});

test('TERMINAL_STATES carries exactly the server TERMINAL_RUN_STATES set', () => {
  const mirrored: string[] = [...TERMINAL_STATES];
  expect(mirrored.sort()).toEqual(serverTerminalRunStates().sort());
});

test("TERMINAL_STATES does not contain 'stopped' — there is no such run state", () => {
  expect(TERMINAL_STATES).not.toContain('stopped');
});

// ---------------------------------------------------------------------------
// The fixture itself, read back through the real replay logic above.
// ---------------------------------------------------------------------------

test('every seeded run replays to a terminal state', () => {
  const { root, home } = build();
  for (const run of allTranscripts(runsDir(root, home))) {
    expect(TERMINAL_STATES).toContain(
      run.state as (typeof TERMINAL_STATES)[number]
    );
  }
});

test('every transcript opens with a header whose meta.id matches its filename', () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  for (const file of readdirSync(dir)) {
    const run = replay(join(dir, file));
    expect(run.meta.id).toBe(file.replace('.jsonl', ''));
    expect(run.meta.taskId).toMatch(/^t-/);
  }
});

test('a gracefully stopped run is terminal and carries stopRequestedAt on its state line', () => {
  // The task brief's own scaffold asserts `states).toContain('stopped')` —
  // there is no such RunState (see TERMINAL_STATES's comment and the two
  // tests above). The real signal a graceful stop leaves behind is
  // `stopRequestedAt` riding on an otherwise-ordinary terminal state line.
  const { root, home } = build();
  const runs = allTranscripts(runsDir(root, home));
  const stopped = runs.filter((r) => r.meta.stopRequestedAt !== undefined);
  expect(stopped.length).toBe(1);
  for (const run of stopped) {
    expect(TERMINAL_STATES).toContain(
      run.state as (typeof TERMINAL_STATES)[number]
    );
  }
});

test('the actor identity file parses the way ActorContext.readKnownHandle reads it', () => {
  const { root, home } = build();
  // Mirrors packages/core/src/actorContext.ts's readKnownHandle: JSON.parse,
  // then trust only a string `handle` field.
  const parsed = JSON.parse(readFileSync(actorFile(root, home), 'utf8')) as
    | { handle?: unknown }
    | undefined;
  expect(typeof parsed?.handle).toBe('string');
  expect(parsed?.handle).toBe('wsoule679');
});

test('the review run against t-2e91aa cites real Task 5 finding ids with matching file/line', () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  const reviewFile = readdirSync(dir).find((f) => f.startsWith('r-7f4a2b'));
  expect(reviewFile).toBeDefined();
  const run = replay(join(dir, reviewFile!));
  expect(run.meta.kind).toBe('review');
  const text = run.entries.map((e) => e.text ?? '').join('\n');

  const findings = FINDINGS.filter((f) => f.taskId === 't-2e91aa');
  expect(findings.length).toBeGreaterThan(0);
  for (const finding of findings) {
    expect(text).toContain(finding.id);
    expect(text).toContain(`${finding.file}:${finding.line}`);
  }
});

test('the verify run carries a CommandEvidence and a MutationEvidence record shaped per core/evidence.ts', () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  const verifyFile = readdirSync(dir).find((f) => f.startsWith('r-4b91de'));
  expect(verifyFile).toBeDefined();
  const run = replay(join(dir, verifyFile!));
  expect(run.meta.kind).toBe('verify');

  expect(run.evidence.length).toBe(1);
  const [ev] = run.evidence;
  expect(typeof ev?.command).toBe('string');
  expect(typeof ev?.exitCode).toBe('number');
  expect(typeof ev?.durationMs).toBe('number');
  expect(typeof ev?.summary).toBe('string');
  expect(typeof ev?.at).toBe('string');

  expect(run.mutations.length).toBe(1);
  const [mut] = run.mutations;
  expect(typeof mut?.guard).toBe('string');
  expect(typeof mut?.file).toBe('string');
  expect(typeof mut?.testsFailed).toBe('number');
  // testsFailed: 0 would mean the guard is dead code (see evidence.ts) —
  // this fixture's whole point is a guard that IS load-bearing.
  expect(mut?.testsFailed).toBeGreaterThan(0);
});

test("the fix loop's three rounds on t-58cc03 resume twice then escalate fresh on the third, per DEFAULT_FIX_LOOP", () => {
  // Confirms the assumption runs.ts's fix-loop comment leans on: rounds 1-3
  // resume, round 4+ is fresh/high — read straight from core's own default
  // rather than hardcoded here a second time.
  expect(DEFAULT_FIX_LOOP.cap).toBe(5);
  const rungs = [...DEFAULT_FIX_LOOP.escalation].sort(
    (a, b) => a.round - b.round
  );
  expect(rungs[0]).toEqual({
    round: 1,
    strategy: 'resume',
    modelTier: 'standard',
  });
  expect(rungs[1]).toEqual({ round: 4, strategy: 'fresh', modelTier: 'high' });

  const { root, home } = build();
  const dir = runsDir(root, home);
  const round1 = replay(join(dir, 'r-9d3c81.jsonl'));
  const round2 = replay(join(dir, 'r-2a77f0.jsonl'));
  const round4 = replay(join(dir, 'r-c05e19.jsonl'));

  expect(round1.meta.resumedFrom).toBe('r-58cc03');
  expect(round2.meta.resumedFrom).toBe('r-9d3c81');
  // The fresh round starts a brand new session with no session to resume,
  // and gets its own throwaway branch rather than the resumed one.
  expect(round4.meta.resumedFrom).toBeUndefined();
  expect(round4.meta.branch).not.toBe(round1.meta.branch);
  expect(round4.meta.baseBranch).toBe(round1.meta.branch);
});

// buildReviewQueue in apps/desktop/src/components/runs/ReviewQueue.tsx shows
// one row per unreviewed, unarchived, terminal 'execute' run — with no
// dedup by task. A fix loop's superseded rounds must be archived or the same
// task would show up once per round, which is exactly the "meaningless
// noise" the task brief warns a blanket-unset reviewedAt produces. This is a
// trimmed copy of that file's `needsHumanLook`/`buildReviewQueue` filter
// (apps/desktop isn't importable from here either), verifying the seeded
// fixture never produces two rows for one task.
function needsHumanLook(run: {
  state: string;
  reviewedAt?: string;
  sessionId?: string;
}): boolean {
  if (run.reviewedAt !== undefined) return false;
  if (run.state === 'finished' || run.state === 'interrupted-dirty')
    return true;
  return run.state === 'failed' && (run.sessionId ?? '') !== '';
}

test('the review queue never shows the same task twice across the fixture', () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  const queueTaskIds: string[] = [];
  for (const file of readdirSync(dir)) {
    const raw = readTranscript(join(dir, file)) as {
      type: string;
      meta?: { taskId: string; kind?: string; sessionId?: string };
      state?: string;
      reviewedAt?: string;
      archivedAt?: string;
      sessionId?: string;
    }[];
    const header = raw.find((l) => l.type === 'header');
    const lastState = [...raw].reverse().find((l) => l.type === 'state');
    if (header?.meta === undefined || lastState?.state === undefined) continue;
    if ((header.meta.kind ?? 'execute') !== 'execute') continue;
    if (lastState.archivedAt !== undefined) continue;
    if (
      needsHumanLook({
        state: lastState.state,
        reviewedAt: lastState.reviewedAt,
        sessionId: lastState.sessionId,
      })
    ) {
      queueTaskIds.push(header.meta.taskId);
    }
  }
  expect(new Set(queueTaskIds).size).toBe(queueTaskIds.length);
  // The two tasks the demo narrative reviews live must both be present.
  expect(queueTaskIds).toContain('t-2e91aa');
  expect(queueTaskIds).toContain('t-58cc03');
});

test('the already-merged done-task runs carry reviewedAt; the two in-review anchors do not', () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  const reviewed = ['r-0c9b88', 'r-71ff03', 'r-4e01af'];
  for (const id of reviewed) {
    const run = replay(join(dir, `${id}.jsonl`));
    expect(run.meta.reviewedAt).toBeDefined();
  }
  const notReviewed = ['r-2e91aa', 'r-c05e19'];
  for (const id of notReviewed) {
    const run = replay(join(dir, `${id}.jsonl`));
    expect(run.meta.reviewedAt).toBeUndefined();
  }
});

test('regenerating writes byte-identical transcripts', () => {
  // Same root for both writes: worktreePath is derived from runKey(rootDir)
  // (see worktreePathFor), so two DIFFERENT temp roots would legitimately
  // produce different text — that's the fixture correctly tracking which
  // project it's for, not a determinism bug. Holding root fixed and varying
  // only DISPATCH_HOME isolates the thing this test actually checks.
  const root = mkdtempSync(join(tmpdir(), 'demo-runs-root-'));
  const homeA = mkdtempSync(join(tmpdir(), 'demo-runs-home-'));
  const homeB = mkdtempSync(join(tmpdir(), 'demo-runs-home-'));
  writeRuns(root, homeA, 'wsoule679');
  writeRuns(root, homeB, 'wsoule679');
  const dirA = runsDir(root, homeA);
  const dirB = runsDir(root, homeB);
  const filesA = readdirSync(dirA).sort();
  expect(filesA).toEqual(readdirSync(dirB).sort());
  for (const file of filesA) {
    expect(readFileSync(join(dirA, file), 'utf8')).toBe(
      readFileSync(join(dirB, file), 'utf8')
    );
  }
  expect(readFileSync(actorFile(root, homeA), 'utf8')).toBe(
    readFileSync(actorFile(root, homeB), 'utf8')
  );
});

test('every transcript file ends with a trailing newline', () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  for (const file of readdirSync(dir)) {
    expect(readFileSync(join(dir, file), 'utf8').endsWith('\n')).toBe(true);
  }
  expect(readFileSync(actorFile(root, home), 'utf8').endsWith('\n')).toBe(true);
});
