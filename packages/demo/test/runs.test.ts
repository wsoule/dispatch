import { DEFAULT_FIX_LOOP, loadConfig } from '@dispatch/core';
import type { CommandEvidence, MutationEvidence } from '@dispatch/core';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { writeBoard } from '../src/board.js';
import { git } from '../src/git.js';
import { actorFile, runsDir } from '../src/paths.js';
import { FINDINGS } from '../src/records.js';
import { BRANCH_FIXES, buildRepo } from '../src/repo.js';
import {
  clearRunHistory,
  RUN_STATES,
  TERMINAL_STATES,
  writeRuns,
} from '../src/runs.js';

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
    createdAt: string;
    updatedAt: string;
    model?: string;
    sessionId?: string;
    reviewedAt?: string;
    reviewAction?: string;
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
    sessionId?: string;
    reviewedAt?: string;
    reviewAction?: string;
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
        sessionId: line.sessionId ?? meta.sessionId,
        reviewedAt: line.reviewedAt ?? meta.reviewedAt,
        reviewAction: line.reviewAction ?? meta.reviewAction,
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
// dedup by task. A fix loop's superseded rounds drop out of that queue via a
// bare `reviewedAt` (no `reviewAction`) rather than `archivedAt` — see
// RunSpec's own doc comment in runs.ts — so the same task doesn't show up
// once per round, which is exactly the "meaningless noise" a blanket-unset
// reviewedAt would produce, while every round still stays visible in the
// default Runs view. This is a trimmed copy of that file's
// `needsHumanLook`/`buildReviewQueue` filter (apps/desktop isn't importable
// from here either), verifying the seeded fixture never produces two rows
// for one task.
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

test("a fix round's injected prompt matches requestChanges's real shape — {kind:'message', from:'user', text}, not an agent-to-user broadcast", () => {
  // orchestrator.ts's requestChanges records the fix loop's prompt as
  // `{ ts, kind: 'message', from: 'user', text }` — no `fromLabel`, no
  // `toUser`. RunLogView.tsx renders that pair (`from:'agent', toUser:true`)
  // as a "TO YOU" megaphone callout reserved for an agent's own
  // messageUser() calls; using that shape here would make a fix round look
  // like it is broadcasting instructions to the human instead of receiving
  // them from the loop.
  const { root, home } = build();
  const dir = runsDir(root, home);
  for (const id of ['r-9d3c81', 'r-2a77f0']) {
    const run = replay(join(dir, `${id}.jsonl`));
    const first = run.entries[0];
    expect(first?.kind).toBe('message');
    expect(first?.from).toBe('user');
    expect(first?.fromLabel).toBeUndefined();
    expect(first?.toUser).toBeUndefined();
  }
});

test("every seeded run's timeline is internally consistent: createdAt <= updatedAt, archivedAt (when present) >= createdAt, and a resume dispatches after its parent finished", () => {
  const { root, home } = build();
  const dir = runsDir(root, home);
  const runs = allTranscripts(dir);
  const byId = new Map(runs.map((r) => [r.meta.id, r]));
  expect(runs.length).toBeGreaterThan(0);

  for (const run of runs) {
    expect(run.meta.createdAt <= run.meta.updatedAt).toBe(true);
    if (run.meta.archivedAt !== undefined) {
      expect(run.meta.archivedAt >= run.meta.createdAt).toBe(true);
    }
    if (run.meta.resumedFrom !== undefined) {
      const parent = byId.get(run.meta.resumedFrom);
      expect(parent).toBeDefined();
      expect(run.meta.createdAt > parent!.meta.updatedAt).toBe(true);
    }
  }
});

test("the fix loop's superseded rounds drop out of the review queue via a bare reviewedAt, not archivedAt, so all four rounds stay visible in the default Runs view", () => {
  // archiveFilter.ts's hideArchivedRuns hides any run with `archivedAt` set
  // when "show archived" is off (the default) — archiving r-58cc03/round
  // 1/round 2 would leave only round 4 visible on screen, hiding the very
  // fix loop the demo wants to show. A bare `reviewedAt` (no `reviewAction`)
  // dedups the review queue instead (needsHumanLook returns false on
  // `reviewedAt` alone) without going through archivedAt at all.
  const { root, home } = build();
  const dir = runsDir(root, home);
  for (const id of ['r-58cc03', 'r-9d3c81', 'r-2a77f0']) {
    const run = replay(join(dir, `${id}.jsonl`));
    expect(run.meta.reviewedAt).toBeDefined();
    expect(run.meta.reviewAction).toBeUndefined();
    expect(run.meta.archivedAt).toBeUndefined();
  }
  // Round 4 is the chain's current HEAD — still owed a human look.
  const head = replay(join(dir, 'r-c05e19.jsonl'));
  expect(head.meta.reviewedAt).toBeUndefined();
  expect(head.meta.archivedAt).toBeUndefined();
});

test("the fix loop's resumed rounds inherit r-58cc03's model and session id rather than minting their own", () => {
  // requestChanges (orchestrator.ts) sets `model: oldMeta.model` and
  // `sessionId: oldMeta.sessionId` on every resumed round — a follow-up must
  // answer on the model/session the conversation started on.
  const { root, home } = build();
  const dir = runsDir(root, home);
  const parent = replay(join(dir, 'r-58cc03.jsonl'));
  expect(parent.meta.model).toBe('claude-opus-5');
  expect(parent.meta.sessionId).toBeDefined();

  for (const id of ['r-9d3c81', 'r-2a77f0']) {
    const run = replay(join(dir, `${id}.jsonl`));
    expect(run.meta.model).toBe(parent.meta.model);
    expect(run.meta.sessionId).toBe(parent.meta.sessionId);
  }
});

test("fix round 4's model matches what dispatchFix really selects for modelTier: 'high', and the round's own narration names it", () => {
  // fixLoop.ts's dispatchFix() uses `models.execute` from config,
  // unconditionally, for a `high` step — not necessarily a "bigger" model
  // than whatever a resumed round is on. Resolve it through the real config
  // loader against the project's actual generated config.yml rather than
  // hardcoding the value here, so this test breaks (not the fixture,
  // silently) if board.ts's config or core's model resolution ever drifts.
  const configRoot = mkdtempSync(join(tmpdir(), 'demo-runs-config-'));
  writeBoard(configRoot);
  const config = loadConfig(configRoot);
  const highStep = config.fixLoop.escalation.find(
    (s) => s.modelTier === 'high'
  );
  // Confirms round 4 really is the escalation ladder's high-tier round —
  // otherwise the assertions below would be checking the wrong round.
  expect(highStep?.round).toBe(4);

  const { root, home } = build();
  const dir = runsDir(root, home);
  const round4 = replay(join(dir, 'r-c05e19.jsonl'));
  expect(round4.meta.model).toBe(config.models.execute);

  const text = round4.entries.map((e) => e.text ?? '').join('\n');
  expect(text).toContain(config.models.execute);
});

test("branchFor uses the run's real taskTitle, collapsing runs of non-alphanumerics into a single hyphen", () => {
  // branchFor was previously fed the doctored title 'Add a health endpoint'
  // to dodge a double hyphen from 'Add a /health endpoint' — the real title
  // must be passed, with slug() collapsing the space+slash run itself.
  const { root, home } = build();
  const dir = runsDir(root, home);
  const run = replay(join(dir, 'r-71ff03.jsonl'));
  expect(run.meta.taskTitle).toBe('Add a /health endpoint');
  expect(run.meta.branch).toBe('dispatch/t-71ff03-add-a-health-endpoint');
  expect(run.meta.branch).not.toContain('--');
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

// ---------------------------------------------------------------------------
// C1: reset must actually clear a clone's prior run history, not just leave
// writeRuns to overwrite its own known filenames on top of whatever was
// already there.
// ---------------------------------------------------------------------------

test('clearRunHistory deletes a stray file writeRuns would never know to overwrite', () => {
  const { root, home } = build();
  const dir = runsDir(root, home);

  // Plant a file with a name writeRuns never writes — a run killed mid-demo
  // or a leftover `<runId>.review.json` would look exactly like this: not
  // one of writeRuns's own filenames, so a plain re-run of writeRuns leaves
  // it untouched.
  const strayFile = join(dir, 'r-deadbeef.review.json');
  writeFileSync(strayFile, '{"stray": true}\n');
  expect(existsSync(strayFile)).toBe(true);
  expect(existsSync(actorFile(root, home))).toBe(true);

  clearRunHistory(root, home);

  expect(existsSync(strayFile)).toBe(false);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(actorFile(root, home))).toBe(false);
});

test('clearRunHistory leaves a fresh writeRuns call with no stray survivors', () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-runs-root-'));
  const home = mkdtempSync(join(tmpdir(), 'demo-runs-home-'));
  writeRuns(root, home, 'wsoule679');
  const dir = runsDir(root, home);
  const strayFile = join(dir, 'r-deadbeef.jsonl');
  writeFileSync(strayFile, 'not a real transcript\n');

  clearRunHistory(root, home);
  writeRuns(root, home, 'wsoule679');

  expect(existsSync(strayFile)).toBe(false);
  expect(readdirSync(dir)).not.toContain('r-deadbeef.jsonl');
});

// ---------------------------------------------------------------------------
// I4: writeReviewDiffs's real-git path (computeFixDiff, resolveRef, the
// merge-base and --name-status parsing) is never reached by any other test
// in this file, since `build()` above seeds against a bare mkdtempSync root
// with no `.git` — the existsSync guard at the top of writeReviewDiffs
// always fires. Build a real repo with buildRepo first so this test is the
// one place that guard is actually false.
// ---------------------------------------------------------------------------

test('writeReviewDiffs computes and persists a real diff when rootDir has a real git history', () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-runs-repo-'));
  buildRepo({ root, push: false });
  const home = mkdtempSync(join(tmpdir(), 'demo-runs-home-'));
  writeRuns(root, home, 'wsoule679');

  const dir = runsDir(root, home);
  for (const runId of ['r-2e91aa', 'r-7f4a2b', 'r-4b91de']) {
    const raw = readFileSync(join(dir, `${runId}.diff.json`), 'utf8');
    const snapshot = JSON.parse(raw) as {
      patch: string;
      files: { path: string; status: string }[];
    };
    expect(typeof snapshot.patch).toBe('string');
    expect(snapshot.patch.length).toBeGreaterThan(0);
    expect(snapshot.patch).toContain('CartProvider.ts');
    expect(Array.isArray(snapshot.files)).toBe(true);
    expect(snapshot.files.length).toBeGreaterThan(0);
    expect(snapshot.files.some((f) => f.path.includes('CartProvider.ts'))).toBe(
      true
    );
  }
});

// Reproduces the real `demo reset` crash: a teammate clone whose local
// `main` never got created. `git clone` only checks out the remote's
// default branch locally — every other branch, including `main` itself
// when the remote's default is something else, exists solely as
// `origin/<branch>`. This bit a real run when the storefront remote's
// default branch was briefly a stray `__authtest`: computeFixDiff's
// `git merge-base main ref` failed with "Not a valid object name main"
// because no local `main` existed in the clone. Simulate that exact shape
// here (rather than against the happy-path buildRepo root the test above
// uses, which creates `main` locally and never exercises this) by cloning
// from a local bare repo (never DEMO.remote) and then deleting the clone's
// local `main`, leaving only `origin/main`.
test('writeReviewDiffs still produces non-empty diffs when the clone has no local main, only origin/main', () => {
  const owner = mkdtempSync(join(tmpdir(), 'demo-runs-repo-'));
  buildRepo({ root: owner, push: false });

  const bare = mkdtempSync(join(tmpdir(), 'demo-runs-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(owner, 'remote', 'add', 'origin', bare);
  git(owner, 'push', '-q', '--all', 'origin');

  const clone = mkdtempSync(join(tmpdir(), 'demo-runs-clone-'));
  git(dirname(clone), 'clone', '-q', bare, clone);

  const fixBranch = BRANCH_FIXES[0].branch;
  git(clone, 'checkout', '-q', fixBranch);
  git(clone, 'branch', '-D', 'main');
  expect(() =>
    git(clone, 'rev-parse', '--verify', '--quiet', 'main')
  ).toThrow();
  expect(git(clone, 'rev-parse', '--verify', 'origin/main').trim()).not.toBe(
    ''
  );

  const home = mkdtempSync(join(tmpdir(), 'demo-runs-home-'));
  writeRuns(clone, home, 'wsoule679');

  const dir = runsDir(clone, home);
  for (const runId of ['r-2e91aa', 'r-7f4a2b', 'r-4b91de']) {
    const raw = readFileSync(join(dir, `${runId}.diff.json`), 'utf8');
    const snapshot = JSON.parse(raw) as {
      patch: string;
      files: { path: string; status: string }[];
    };
    expect(snapshot.patch.length).toBeGreaterThan(0);
    expect(snapshot.files.length).toBeGreaterThan(0);
    expect(snapshot.files.some((f) => f.path.includes('CartProvider.ts'))).toBe(
      true
    );
  }
});
