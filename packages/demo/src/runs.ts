import type { CommandEvidence, MutationEvidence } from '@dispatch/core';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { actorFile, runKey, runsDir } from './paths.js';
import { FINDINGS } from './records.js';
import { assertSafeToDelete, BRANCH_FIXES, computeFixDiff } from './repo.js';

// ---------------------------------------------------------------------------
// Hand-kept mirrors of @dispatch/server's orchestrator types.
//
// packages/server's package.json has no root export — only its own
// package.json plus two deliberately narrow subpaths, `./testing` (fake
// executor/planner doubles) and `./embed` (startServer, for apps/demo's
// daemon) — so nothing outside that package can import its modules
// generally. Not a Bun/Node runtime limitation (this package is Bun-only
// too), but a deliberate boundary: server is a daemon, not a library.
// packages/cli and packages/mcp hit the same wall and hand-mirror these same
// types (see packages/cli/src/apiClient.ts and packages/mcp/src/tools.ts)
// with a source-comparison test to catch drift; test/runs.test.ts does the
// same thing here (see "RunState mirror").
// ---------------------------------------------------------------------------

export const RUN_STATES = [
  'provisioning',
  'running',
  'awaiting-approval',
  'finished',
  'failed',
  'cancelled',
  'interrupted-dirty',
] as const;

export type RunState = (typeof RUN_STATES)[number];

// Mirrors packages/server/src/orchestrator/types.ts's TERMINAL_RUN_STATES.
// `reconcileOnBoot` force-fails any run whose transcript's last state isn't
// one of these, so every run this module seeds MUST end on one of them.
//
// 'stopped' is NOT a real run state, despite being the obvious first guess
// for "the Stop button was pressed" — read Orchestrator.requestStop's doc
// comment. A graceful stop asks the agent to wind down and still finishes
// through the normal path, so it persists as 'finished' (or 'failed' if the
// agent errored on the way out); the only durable trace of the stop request
// is the `stopRequestedAt` marker on that same terminal state line.
export const TERMINAL_STATES: readonly RunState[] = [
  'finished',
  'failed',
  'cancelled',
  'interrupted-dirty',
];

type RunKind = 'execute' | 'review' | 'verify';

interface NormalizedEntry {
  ts: string;
  kind: 'assistant' | 'tool' | 'thinking' | 'system' | 'usage' | 'message';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: 'running' | 'done' | 'error';
  from?: 'user' | 'agent';
  fromLabel?: string;
  toUser?: boolean;
}

interface RunMeta {
  id: string;
  taskId: string;
  taskTitle: string;
  executor: string;
  state: RunState;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  createdAt: string;
  updatedAt: string;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  model?: string;
  reviewedAt?: string;
  reviewAction?: 'merge' | 'discard' | 'pr';
  kind?: RunKind;
  resumedFrom?: string;
  stopRequestedAt?: string;
}

// Same fixed instant board.ts/records.ts anchor on, so every seeded fixture
// across the whole demo shares one clock and regenerating stays byte-identical.
const BASE_MS = Date.parse('2026-07-28T14:00:00.000Z');

function ago(days: number, hours = 0): string {
  return new Date(BASE_MS - days * 86400000 - hours * 3600000).toISOString();
}

// A run's own opaque resume handle, derived from its id the same way the
// marketing-screenshot fixture did (`'s-' + rid[2:]`) — good enough for a
// static fixture, since nothing ever actually resumes it against a real SDK.
// A resumed round must NOT get its own fresh id here — the real orchestrator
// carries `oldMeta.sessionId` forward unchanged across a resume chain (see
// requestChanges/recordSession in orchestrator.ts), so a resumed RunSpec
// passes the parent's id via `RunSpec.sessionId` to override this default.
function sessionIdFor(id: string): string {
  return `s-${id.slice(2)}`;
}

// Same slugging rule as board.ts's task-file slug: lowercase title, runs of
// non-alphanumerics collapsed to a single `-`, capped and trimmed. Collapsing
// the run (rather than mapping each character 1:1) matters for a title like
// "Add a /health endpoint": a lone char-by-char mapping turns the space+slash
// into TWO separate hyphens ("add-a--health-endpoint").
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '');
}

function branchFor(taskId: string, title: string): string {
  return `dispatch/${taskId}-${slug(title)}`;
}

function branchFixFor(taskId: string): string {
  const fix = BRANCH_FIXES.find((f) => f.task === taskId);
  if (fix === undefined) {
    throw new Error(`no BRANCH_FIXES entry for ${taskId}`);
  }
  return fix.branch;
}

function worktreePathFor(rootDir: string, id: string): string {
  return `/tmp/dispatch/worktrees/${runKey(rootDir)}/${id}`;
}

// One assistant narration line.
function A(text: string): NormalizedEntry {
  return { ts: '', kind: 'assistant', text };
}

// One tool-call line. `status` defaults to 'done' — the common case for a
// tool call that already completed by the time this transcript was written.
function T(
  toolName: string,
  toolInput: unknown,
  status: 'running' | 'done' | 'error' = 'done'
): NormalizedEntry {
  return { ts: '', kind: 'tool', toolName, toolInput, status };
}

// One agent-to-user message — the shape `messageUser()` writes for both
// `ask_user` questions and `request_scope` asks (see api.ts's
// questionEntryText/scopeRequestEntryText). `fromLabel` mirrors
// `"${taskTitle} (${runId})"`, the label resolveSenderLabel would produce.
function Msg(taskTitle: string, id: string, text: string): NormalizedEntry {
  return {
    ts: '',
    kind: 'message',
    from: 'agent',
    fromLabel: `${taskTitle} (${id})`,
    toUser: true,
    text,
  };
}

// One fix-loop prompt, injected as the next conversation turn on a resumed
// run — the shape Orchestrator.requestChanges actually records for
// `sendMessage(runId, prompt, { resume: true })`: `{ ts, kind: 'message',
// from: 'user', text }`, with no `fromLabel`/`toUser`. That pair is reserved
// for an agent's own `messageUser()` calls (Msg, above) — a fix round's
// prompt is not the agent broadcasting to the human, it is the loop's
// automated feedback arriving the same way a human's own "request changes"
// text would. RunLogView.tsx renders `toUser: true` as a "TO YOU" megaphone
// callout; using Msg() here would make a fix round look like it is talking
// TO the human instead of receiving instructions FROM the loop.
function FixMsg(text: string): NormalizedEntry {
  return { ts: '', kind: 'message', from: 'user', text };
}

// One system-authored note — the shape Orchestrator.requestStop appends to
// record why a run wrapped up when it did.
function Sys(text: string): NormalizedEntry {
  return { ts: '', kind: 'system', text };
}

interface RunSpec {
  id: string;
  taskId: string;
  taskTitle: string;
  kind?: RunKind;
  branch: string;
  baseBranch: string;
  model: string;
  resumedFrom?: string;
  // Overrides the derived `sessionIdFor(spec.id)`. A resumed round must set
  // this to its parent's session id — a real resume keeps the SAME session
  // across the whole chain (see sessionIdFor's comment above).
  sessionId?: string;
  worktreePath: string;
  // A single timestamp anchors the whole run (header, every entry, and the
  // final state line) — the same simplification the ported fixture used,
  // rather than incrementing per entry.
  daysAgo: number;
  hoursAgo?: number;
  entries: NormalizedEntry[];
  evidence?: CommandEvidence[];
  mutations?: MutationEvidence[];
  state: RunState;
  costUsd: number;
  turns: number;
  // `reviewed` alone (no `reviewAction`) writes a bare `reviewedAt` — the
  // lever a fix loop's superseded round uses to drop out of the review
  // queue (needsHumanLook in ReviewQueue.tsx returns false on `reviewedAt`
  // alone) while staying OUT of archiveFilter.ts's hidden set, which keys
  // only on `archivedAt`. `reviewAction` on top additionally records how a
  // run was actually closed out (e.g. 'merge').
  reviewed?: boolean;
  reviewAction?: 'merge' | 'discard' | 'pr';
  stopped?: boolean;
  // Set when a run's task/branch is done and should disappear from the
  // default Runs view entirely (archiveFilter.ts hides anything with
  // `archivedAt`). NOT used for a fix loop's superseded rounds — see
  // `reviewed` above — since those need to stay visible as history.
  archivedDaysAgo?: number;
  archivedHoursAgo?: number;
}

// Writes one run's on-disk JSONL transcript: a header line carrying the run's
// meta, one entry line per log line, any evidence/mutation records, and a
// final state line — the shape Transcript/replayTranscript in
// packages/server/src/orchestrator/transcript.ts read back.
function writeRun(dir: string, spec: RunSpec): void {
  const ts = ago(spec.daysAgo, spec.hoursAgo);
  const sessionId = spec.sessionId ?? sessionIdFor(spec.id);
  const meta: RunMeta = {
    id: spec.id,
    taskId: spec.taskId,
    taskTitle: spec.taskTitle,
    executor: 'claude',
    // The header always records the run as `running` — a transcript's header
    // is written the moment a run starts, before its outcome is known; the
    // final state line below is what actually determines the replayed state.
    state: 'running',
    branch: spec.branch,
    baseBranch: spec.baseBranch,
    worktreePath: spec.worktreePath,
    createdAt: ago(spec.daysAgo, (spec.hoursAgo ?? 0) + 1),
    updatedAt: ts,
    model: spec.model,
    ...(spec.kind !== undefined ? { kind: spec.kind } : {}),
    ...(spec.resumedFrom !== undefined
      ? { resumedFrom: spec.resumedFrom }
      : {}),
  };

  const lines: string[] = [JSON.stringify({ type: 'header', meta })];
  for (const entry of spec.entries) {
    lines.push(JSON.stringify({ type: 'entry', entry: { ...entry, ts } }));
  }
  for (const evidence of spec.evidence ?? []) {
    lines.push(JSON.stringify({ type: 'evidence', evidence }));
  }
  for (const mutation of spec.mutations ?? []) {
    lines.push(JSON.stringify({ type: 'mutation', mutation }));
  }

  const finish: Record<string, unknown> = {
    costUsd: spec.costUsd,
    turns: spec.turns,
    sessionId,
  };
  if (spec.reviewed === true) {
    finish.reviewedAt = ts;
    // Bare `reviewedAt` (no `reviewAction`) is deliberate for a superseded
    // fix-loop round — it was never literally merged or discarded, just
    // dedup'd out of the review queue. Only write the field when a caller
    // states what actually happened.
    if (spec.reviewAction !== undefined) {
      finish.reviewAction = spec.reviewAction;
    }
  }
  if (spec.stopped === true) {
    finish.stopRequestedAt = ts;
  }
  if (spec.archivedDaysAgo !== undefined) {
    finish.archivedAt = ago(spec.archivedDaysAgo, spec.archivedHoursAgo);
  }
  lines.push(
    JSON.stringify({ type: 'state', state: spec.state, ts, ...finish })
  );

  writeFileSync(join(dir, `${spec.id}.jsonl`), `${lines.join('\n')}\n`);
}

// The six runs from the marketing-screenshot fixture
// (.agents/ignore/gen-demo.py lines 92-143), ported to this JSONL writer.
// `CartProvider.tsx` in that script is corrected to `CartProvider.ts` here —
// the real storefront-src template (and BRANCH_FIXES) never had a `.tsx`
// file; the fix branches are all plain `.ts`.
function writePortedRuns(dir: string, rootDir: string): void {
  writeRun(dir, {
    id: 'r-2e91aa',
    taskId: 't-2e91aa',
    taskTitle: 'Move cart state to the session store',
    branch: branchFixFor('t-2e91aa'),
    baseBranch: 'main',
    model: 'claude-opus-5',
    worktreePath: worktreePathFor(rootDir, 'r-2e91aa'),
    // Oldest run in this task's chain: the review below (writeReviewRun) and
    // the verify after it (writeVerifyRun) both have to read as happening
    // AFTER this execute run finished, not before it.
    daysAgo: 3,
    entries: [
      A('Reading how the cart is stored today before moving it.'),
      T('Read', { file_path: 'src/cart/CartProvider.ts' }),
      T('Grep', { pattern: 'useCart\\(', path: 'src' }),
      A(
        'The cart is React state with a localStorage mirror. I will move it behind the session store and keep the hook signature.'
      ),
      T('Edit', { file_path: 'src/cart/CartProvider.ts' }),
      T('Bash', { command: 'bun test src/cart' }),
      A(
        'Done. The cart now round-trips through the session store and the hook signature is unchanged.'
      ),
    ],
    state: 'finished',
    costUsd: 2.11,
    turns: 14,
  });

  writeRun(dir, {
    id: 'r-58cc03',
    taskId: 't-58cc03',
    taskTitle: 'Rank exact SKU matches above fuzzy',
    branch: branchFixFor('t-58cc03'),
    baseBranch: 'main',
    model: 'claude-opus-5',
    worktreePath: worktreePathFor(rootDir, 'r-58cc03'),
    // The oldest run in the fix loop's chain (writeFixLoopRuns) — round 1
    // resumes this run's own session and must be dispatched (createdAt)
    // strictly after this run finishes (updatedAt).
    daysAgo: 4,
    entries: [
      A('Looking at how results are scored now.'),
      T('Read', { file_path: 'src/search/rank.ts' }),
      A(
        'Exact SKU hits are scored the same as trigram matches. Adding an exact-match boost ahead of the fuzzy pass.'
      ),
      T('Edit', { file_path: 'src/search/rank.ts' }),
      T('Bash', { command: 'bun test src/search' }),
      A(
        'Done. An exact SKU now sorts first, and the fuzzy ordering below it is unchanged.'
      ),
    ],
    state: 'finished',
    costUsd: 4.83,
    turns: 28,
    // Superseded once the fix loop's round 1 resumes this run's own session
    // (see writeFixLoopRuns) — a bare `reviewedAt` (no `reviewAction`) so it
    // drops out of the review queue without also disappearing from the
    // default Runs view (see RunSpec's `reviewed` doc comment).
    reviewed: true,
  });

  writeRun(dir, {
    id: 'r-0c9b88',
    taskId: 't-0c9b88',
    taskTitle: 'Fix hyphenated SKU search',
    branch: branchFor('t-0c9b88', 'Fix hyphenated SKU search'),
    baseBranch: 'main',
    model: 'claude-opus-5',
    worktreePath: worktreePathFor(rootDir, 'r-0c9b88'),
    daysAgo: 6,
    entries: [
      A('Hyphens are stripped by the tokeniser before indexing.'),
      T('Edit', { file_path: 'src/search/tokenize.ts' }),
      T('Bash', { command: 'bun test src/search' }),
      A('Fixed — "AB-1200" now matches.'),
    ],
    state: 'finished',
    costUsd: 3.01,
    turns: 17,
    reviewed: true,
    reviewAction: 'merge',
  });

  writeRun(dir, {
    id: 'r-71ff03',
    taskId: 't-71ff03',
    taskTitle: 'Add a /health endpoint',
    branch: branchFor('t-71ff03', 'Add a /health endpoint'),
    baseBranch: 'main',
    model: 'claude-opus-5',
    worktreePath: worktreePathFor(rootDir, 'r-71ff03'),
    daysAgo: 8,
    entries: [
      T('Edit', { file_path: 'src/server/routes.ts' }),
      A('Added GET /health returning 200 with the build sha.'),
    ],
    state: 'finished',
    costUsd: 1.5,
    turns: 9,
    reviewed: true,
    reviewAction: 'merge',
  });

  writeRun(dir, {
    id: 'r-4e01af',
    taskId: 't-4e01af',
    taskTitle: 'Log slow queries over 200ms',
    branch: branchFor('t-4e01af', 'Log slow queries over 200ms'),
    baseBranch: 'main',
    model: 'claude-opus-5',
    worktreePath: worktreePathFor(rootDir, 'r-4e01af'),
    daysAgo: 7,
    entries: [
      T('Edit', { file_path: 'src/db/client.ts' }),
      A('Queries over 200ms now log with their statement and duration.'),
    ],
    state: 'finished',
    costUsd: 2.44,
    turns: 12,
    reviewed: true,
    reviewAction: 'merge',
  });

  writeRun(dir, {
    id: 'r-3d90c1',
    taskId: 't-8ac410',
    taskTitle: 'Rate limit the search endpoint',
    branch: branchFor('t-8ac410', 'Rate limit the search endpoint'),
    baseBranch: 'main',
    model: 'claude-opus-5',
    worktreePath: worktreePathFor(rootDir, 'r-3d90c1'),
    daysAgo: 3,
    entries: [
      A('Starting on the rate limiter.'),
      T('Bash', { command: 'bun install @upstash/ratelimit' }, 'error'),
    ],
    state: 'failed',
    costUsd: 0.62,
    turns: 4,
  });
}

// A review run against t-2e91aa. Its entries reference the real Task 5
// findings by id (imported from records.ts, not re-typed here) so `file`/
// `line` can never silently drift from what the findings themselves carry.
function writeReviewRun(dir: string, rootDir: string): void {
  const taskId = 't-2e91aa';
  const taskTitle = 'Move cart state to the session store';
  const id = 'r-7f4a2b';
  const findings = FINDINGS.filter((f) => f.taskId === taskId);

  const entries: NormalizedEntry[] = [
    A(`Reviewing ${branchFixFor(taskId)} against main.`),
    T('Read', { file_path: 'src/cart/CartProvider.ts' }),
  ];
  for (const finding of findings) {
    entries.push(
      A(
        `${finding.id} (${finding.severity}, ${finding.verdict}) — ${finding.title} [${finding.file}:${finding.line}]`
      )
    );
  }
  entries.push(
    A(
      `Filed ${findings.length} findings: ${findings.map((f) => f.id).join(', ')}.`
    )
  );

  writeRun(dir, {
    id,
    taskId,
    taskTitle,
    kind: 'review',
    branch: `dispatch/review-${taskId}-${id.slice(2)}`,
    baseBranch: branchFixFor(taskId),
    model: 'claude-opus-5',
    worktreePath: worktreePathFor(rootDir, id),
    // Dispatched after r-2e91aa (writePortedRuns, daysAgo: 3) actually
    // finished, and before the verify run below it (writeVerifyRun,
    // daysAgo: 1) — the chain has to read execute -> review -> verify.
    daysAgo: 2,
    hoursAgo: 10,
    entries,
    state: 'finished',
    costUsd: 1.87,
    turns: 11,
  });
}

// A three-round fix loop on t-58cc03. Per the escalation ladder in the
// generated config.yml (cap: 5, round 1 resume/standard, round 4
// fresh/high — see board.ts's writeConfig and core's DEFAULT_FIX_LOOP),
// rounds 1-3 all resume the SAME agent/session; only round 4+ starts a
// fresh one at the high tier. This fixture shows three dispatches — round
// 1, round 2, and round 4 — so the third one shown is the fresh/high one,
// exactly as fixLoop.ts's own comment describes ("an agent three rounds
// deep stops seeing its own shape"). Round 3's resume is presumed to have
// happened without a separate demo transcript for it.
//
// Each round is its own run/transcript, never a plain append to the
// previous one: fixLoop.ts's dispatchFix() calls
// `orchestrator.sendMessage(previous.id, prompt, { resume: true })`, and
// `sendMessage(..., { resume: true })` always forks a NEW run (see
// requestChanges in orchestrator.ts) into the same worktree/branch, linked
// back via `resumedFrom`. Only the round-4 fresh dispatch gets a brand new
// worktree/branch (dispatchAuxRun), based on the previous round's branch.
function writeFixLoopRuns(dir: string, rootDir: string): void {
  const taskId = 't-58cc03';
  const taskTitle = 'Rank exact SKU matches above fuzzy';
  const resumedBranch = branchFixFor(taskId);
  const resumedWorktree = worktreePathFor(rootDir, 'r-58cc03');

  // r-58cc03's model and session id carry forward unchanged across the
  // whole resume chain — requestChanges sets `model: oldMeta.model` and
  // `sessionId: oldMeta.sessionId` (see the comment above requestChanges in
  // orchestrator.ts). r-58cc03 ran on claude-opus-5, so round 1 (which
  // resumes it) and round 2 (which resumes round 1) must both show
  // claude-opus-5 and r-58cc03's session id, not a fresh sonnet session.
  const parentModel = 'claude-opus-5';
  const parentSessionId = sessionIdFor('r-58cc03');

  const round1Id = 'r-9d3c81';
  writeRun(dir, {
    id: round1Id,
    taskId,
    taskTitle,
    kind: 'execute',
    branch: resumedBranch,
    baseBranch: 'main',
    model: parentModel,
    resumedFrom: 'r-58cc03',
    sessionId: parentSessionId,
    worktreePath: resumedWorktree,
    daysAgo: 2,
    hoursAgo: 6,
    entries: [
      FixMsg(
        `# Fix round 1 of 5 — ${taskId}: ${taskTitle}\n\nOpen findings from the last review need addressing before this can merge.`
      ),
      T('Read', { file_path: 'src/search/rank.ts' }),
      A(
        'An empty query still walks the whole catalog before finding nothing to score. Returning early when there are no terms.'
      ),
      T('Edit', { file_path: 'src/search/rank.ts' }),
      T('Bash', { command: 'bun test src/search' }),
      A(
        'Done — an empty query now short-circuits instead of scanning everything.'
      ),
    ],
    state: 'finished',
    costUsd: 1.42,
    turns: 9,
    // Superseded by round 2's resume — a bare `reviewedAt` (no
    // `reviewAction`) drops it out of the review queue without hiding it
    // from the default Runs view (see RunSpec's `reviewed` doc comment and
    // r-58cc03's own note above).
    reviewed: true,
  });

  const round2Id = 'r-2a77f0';
  writeRun(dir, {
    id: round2Id,
    taskId,
    taskTitle,
    kind: 'execute',
    branch: resumedBranch,
    baseBranch: 'main',
    model: parentModel,
    resumedFrom: round1Id,
    sessionId: parentSessionId,
    worktreePath: resumedWorktree,
    daysAgo: 2,
    hoursAgo: 3,
    entries: [
      FixMsg(
        `# Fix round 2 of 5 — ${taskId}: ${taskTitle}\n\nThe exact-SKU boost is still a flat constant rather than a real ceiling — a long enough title can out-score it.`
      ),
      T('Read', { file_path: 'src/search/rank.ts' }),
      A(
        'EXACT_SKU_BOOST needs to scale with the maximum possible overlap, not sit at a fixed 100.'
      ),
      T('Edit', { file_path: 'src/search/rank.ts' }),
      T('Bash', { command: 'bun test src/search' }),
      A(
        'Done — the boost is now derived from terms.length, so it always wins.'
      ),
    ],
    state: 'finished',
    costUsd: 2.05,
    turns: 13,
    // Superseded by round 4's fresh dispatch — same bare-`reviewedAt` lever
    // as round 1 above. Round 4 (below) is the one left unreviewed: it is
    // t-58cc03's current HEAD, and one of the two in-review tasks the demo
    // reviews live.
    reviewed: true,
  });

  // What dispatchFix() in fixLoop.ts really selects for a `modelTier:
  // 'high'` step: `models.execute` straight from config, unconditionally —
  // not necessarily a "bigger" model than whatever a resumed round happened
  // to be on. This project's config.yml (board.ts's writeConfig) sets
  // `models.execute: claude-sonnet-5`, so round 4 lands on sonnet even
  // though rounds 1-2 above resumed r-58cc03's opus session. That reads as
  // a downgrade by name only; the narration below says so rather than
  // leaving an unexplained contradiction on screen.
  const round4Model = 'claude-sonnet-5';

  const round4Id = 'r-c05e19';
  writeRun(dir, {
    id: round4Id,
    taskId,
    taskTitle,
    kind: 'execute',
    branch: `dispatch/execute-${taskId}-${round4Id.slice(2)}`,
    // A fresh escalation builds on the work so far rather than the task's
    // base — dispatchFix() passes `head: previous?.branch`, not the task's
    // original base commit.
    baseBranch: resumedBranch,
    model: round4Model,
    worktreePath: worktreePathFor(rootDir, round4Id),
    daysAgo: 2,
    entries: [
      A(
        `Fix round 4 of 5 — ${taskId}: ${taskTitle}. Dispatched fresh on ${round4Model} — this project's high-tier escalation model, not a continuation of the opus session the earlier rounds resumed: normalization needs to be consistent across rank.ts, index.ts, and tokenize.ts, and a resumed session three rounds deep is the wrong place to re-derive that from scratch.`
      ),
      T('Read', { file_path: 'src/search/tokenize.ts' }),
      T('Read', { file_path: 'src/search/index.ts' }),
      A(
        'Adding one shared normalization pass ahead of tokenize() so an NBSP or accented character in a pasted SKU can no longer fall out of the exact-match or fuzzy-overlap paths.'
      ),
      T('Edit', { file_path: 'src/search/tokenize.ts' }),
      T('Bash', { command: 'bun test src/search' }),
      A('Done — normalization is now shared across the whole search path.'),
    ],
    state: 'finished',
    costUsd: 3.71,
    turns: 19,
  });
}

// A verify run against t-2e91aa's session-store change: a command actually
// run against the app, plus a mutation test on the guard the earlier review
// flagged as missing a fallback (finding f-a1b2c3) — see
// packages/core/src/evidence.ts for why `testsFailed: 0` would mean the
// guard is dead code. Here it isn't: 3 tests fail once the guard is reverted.
function writeVerifyRun(dir: string, rootDir: string): void {
  const taskId = 't-2e91aa';
  const taskTitle = 'Move cart state to the session store';
  const id = 'r-4b91de';
  const ts = ago(1, 5);

  const evidence: CommandEvidence[] = [
    {
      command:
        'bun run src/server/routes.ts & curl -s http://localhost:4000/health',
      exitCode: 0,
      durationMs: 812,
      summary: '200 OK — cart round-trips through the session store',
      at: ts,
    },
  ];
  const mutations: MutationEvidence[] = [
    {
      guard: 'try/catch around JSON.parse(raw) in loadCart',
      file: 'src/cart/CartProvider.ts',
      testsFailed: 3,
      at: ts,
    },
  ];

  writeRun(dir, {
    id,
    taskId,
    taskTitle,
    kind: 'verify',
    branch: `dispatch/verify-${taskId}-${id.slice(2)}`,
    baseBranch: branchFixFor(taskId),
    model: 'claude-sonnet-5',
    worktreePath: worktreePathFor(rootDir, id),
    daysAgo: 1,
    hoursAgo: 5,
    entries: [
      A(`Verifying ${branchFixFor(taskId)}.`),
      T('Bash', {
        command:
          'bun run src/server/routes.ts & curl -s http://localhost:4000/health',
      }),
      A(
        '/health returns 200. Reverting the JSON.parse guard to confirm it is load-bearing.'
      ),
      T('Bash', { command: 'bun test src/cart' }, 'error'),
      A(
        'Confirmed: reverting the guard fails 3 tests, so it is not dead code. Restoring it.'
      ),
    ],
    evidence,
    mutations,
    state: 'finished',
    costUsd: 0.94,
    turns: 6,
  });
}

// A scope request that was granted: t-3f8a21 needs to touch routes.ts as
// well as discount.ts, since the inline client-trusted check being retired
// lives in the route handler itself. `messageUser()` is how both
// `request_scope` and `ask_user` actually land text on a transcript (see
// api/scopeRequests.ts's scopeRequestEntryText) — the grant itself lives only
// in the daemon's in-memory ScopeRequestRegistry (never persisted to disk),
// so the outcome is recorded here as a system note, the way the Session log
// would read it, rather than pretending to replay a registry record that
// does not survive a restart in the real system either.
function writeScopeRequestRun(dir: string, rootDir: string): void {
  const taskId = 't-3f8a21';
  const taskTitle = 'Validate discount codes server-side';
  const id = 'r-1e6a4f';

  writeRun(dir, {
    id,
    taskId,
    taskTitle,
    kind: 'execute',
    branch: branchFor(taskId, taskTitle),
    baseBranch: 'main',
    model: 'claude-sonnet-5',
    worktreePath: worktreePathFor(rootDir, id),
    daysAgo: 1,
    hoursAgo: 2,
    entries: [
      A(
        'The client decides whether a discount code is valid today — moving that behind the API.'
      ),
      T('Read', { file_path: 'src/checkout/discount.ts' }),
      T('Read', { file_path: 'src/server/routes.ts' }),
      Msg(
        taskTitle,
        id,
        'Requesting to edit outside my scope: src/server/routes.ts\n\nThe client-trusted check being retired is inlined in the route handler, not just discount.ts — moving it server-side means touching both files together.'
      ),
      Sys(
        'Scope granted: src/server/routes.ts — the discount check and its route belong together [decided via app]'
      ),
      T('Edit', { file_path: 'src/checkout/discount.ts' }),
      T('Edit', { file_path: 'src/server/routes.ts' }),
      T('Bash', { command: 'bun test src/checkout' }),
      A(
        'Done — discount codes are now verified server-side, and an expired code returns 422.'
      ),
    ],
    state: 'finished',
    costUsd: 2.68,
    turns: 16,
  });
}

// A run holding unanswered `ask_user` questions. There is no on-disk plan
// artifact to seed here: PlanManager's PlanRecord is explicitly in-memory
// only ("a lost daemon losing in-flight drafts is acceptable", plan.ts) and
// is never written to any file, so a static demo fixture cannot reproduce
// one after a restart any more than the real daemon can. The closest thing
// that DOES survive on disk is a run transcript whose agent asked
// clarifying questions via `ask_user` and never got an answer — exactly
// what QuestionRegistry's own timeout path documents (UNANSWERED_NOTE in
// packages/mcp/src/tools.ts): the agent proceeds on its own judgement and
// states the assumption, rather than the run hanging forever.
function writePlanDraftRun(dir: string, rootDir: string): void {
  const taskId = 't-9b2d14';
  const taskTitle = 'Add address autocomplete';
  const id = 'r-88bf02';

  writeRun(dir, {
    id,
    taskId,
    taskTitle,
    kind: 'execute',
    branch: branchFor(taskId, taskTitle),
    baseBranch: 'main',
    model: 'claude-sonnet-5',
    worktreePath: worktreePathFor(rootDir, id),
    daysAgo: 5,
    entries: [
      A(
        'The task does not say which geocoding provider to wire the address field to.'
      ),
      Msg(
        taskTitle,
        id,
        'Which geocoding provider should this use — no default is specified in the task?\n\n- Google Places\n- Mapbox'
      ),
      Msg(
        taskTitle,
        id,
        'Should the API key live in an env var already used elsewhere, or a new one?\n\n- Reuse an existing key\n- Add a new one'
      ),
      A(
        'No one answered in time. Proceeding on my best judgement: defaulting to Google Places, since nothing else in the codebase already depends on Mapbox, and adding a new PLACES_API_KEY env var. Both are worth confirming in review.'
      ),
    ],
    state: 'finished',
    costUsd: 0.71,
    turns: 5,
  });
}

// A run stopped gracefully via the Stop button, so the history behind it
// isn't empty. Per Orchestrator.requestStop, this changes no state of its
// own — the run still reaches its normal terminal state (`finished`) through
// the usual finish path, marked only by `stopRequestedAt` on that state line
// and the system note it appends to the Session log.
function writeStoppedRun(dir: string, rootDir: string): void {
  const taskId = 't-1d77e5';
  const taskTitle = 'Cache the search index in redis';
  const id = 'r-f30c76';

  writeRun(dir, {
    id,
    taskId,
    taskTitle,
    kind: 'execute',
    branch: branchFor(taskId, taskTitle),
    baseBranch: 'main',
    model: 'claude-sonnet-5',
    worktreePath: worktreePathFor(rootDir, id),
    daysAgo: 0,
    hoursAgo: 3,
    entries: [
      A(
        'Rebuilds are slow and cold starts hit the database hard — wiring a redis cache in front of the index.'
      ),
      T('Read', { file_path: 'src/search/index.ts' }),
      T('Edit', { file_path: 'src/search/index.ts' }),
      Sys(
        'Stop requested — the agent will finish its current operation and then stop.'
      ),
      A(
        'Stopping here. The cache wiring is committed but not wired into searchRoute yet.'
      ),
    ],
    state: 'finished',
    costUsd: 0.38,
    turns: 3,
    stopped: true,
  });
}

// Same path Orchestrator.persistDiffSnapshot writes to (see
// packages/server/src/orchestrator/paths.ts's diffSnapshotPath): alongside
// the transcript, named `<runId>.diff.json`.
function diffSnapshotPath(dir: string, runId: string): string {
  return join(dir, `${runId}.diff.json`);
}

// Seeds the review surface's diff for every seeded run that reviews or
// verifies t-2e91aa's real fix branch (r-2e91aa, r-7f4a2b, r-4b91de — see
// writePortedRuns/writeReviewRun/writeVerifyRun above). Without this, none of
// them have a live worktree (no seeded run ever gets one) or a persisted
// snapshot, so Orchestrator.diff() 409s and the demo's central "Review
// surface" beat has nothing to show. t-58cc03's chain (including the known
// r-c05e19 gap — see the Task 9 report) is deliberately left unseeded here:
// none of its runs sit in the review queue's default view the same way, and
// guessing at kind:'review'/'verify' branch semantics beyond this one
// well-understood case risked shipping a snapshot that looked right but
// wasn't.
//
// `rootDir` must be a real clone with BRANCH_FIXES' branches already
// committed — true for both DEMO.root and DEMO.teammateRoot inside the real
// `reset` flow (see cli.ts), but every one of this package's own tests calls
// writeRuns() against a bare scratch tmpdir with no git history at all.
// Skip cleanly rather than throwing when there's nothing to diff against,
// same convention as this file's other "demo has never been generated"
// guards.
function writeReviewDiffs(dir: string, rootDir: string): void {
  if (!existsSync(join(rootDir, '.git'))) return;
  const diff = computeFixDiff(rootDir, 't-2e91aa');
  const json = JSON.stringify(diff);
  for (const runId of ['r-2e91aa', 'r-7f4a2b', 'r-4b91de']) {
    writeFileSync(diffSnapshotPath(dir, runId), json);
  }
}

/** Writes this clone's actor identity file at `actorFile(rootDir, home)`. */
function writeActorIdentity(
  rootDir: string,
  home: string,
  handle: string
): void {
  const file = actorFile(rootDir, home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ handle })}\n`);
}

/**
 * Deletes a clone's prior run transcripts and actor identity file, so a
 * `reset` genuinely starts run history over instead of layering new runs on
 * top of whatever the last demo left behind. `writeRuns` below only ever
 * overwrites the exact filenames it knows about (`<runId>.jsonl`,
 * `<runId>.diff.json`, the actor file) — a run killed mid-demo, a stray
 * `<runId>.review.json`, or any other leftover under the runs dir would
 * otherwise survive every future reset. Routes both deletes through
 * `assertSafeToDelete` (repo.ts) so this can only ever touch a path under
 * .agents/ignore or the OS temp dir, the same guard `buildRepo` uses.
 */
export function clearRunHistory(rootDir: string, home: string): void {
  const dir = runsDir(rootDir, home);
  assertSafeToDelete(dir);
  rmSync(dir, { recursive: true, force: true });

  const file = actorFile(rootDir, home);
  assertSafeToDelete(file);
  rmSync(file, { force: true });
}

/**
 * Seeds this clone's run history under `$DISPATCH_HOME/.dispatch/runs/<key>/`
 * — the six runs ported from the marketing-screenshot fixture plus one of
 * every additional run kind the demo narrative needs (review, a three-round
 * fix loop, verify, a granted scope request, unanswered questions, and a
 * graceful stop) — and this clone's actor identity file. Every run is
 * terminal (see TERMINAL_STATES): `reconcileOnBoot` force-fails anything
 * left non-terminal on boot, since a static fixture never has a live process
 * behind it.
 */
export function writeRuns(rootDir: string, home: string, handle: string): void {
  const dir = runsDir(rootDir, home);
  mkdirSync(dir, { recursive: true });

  writePortedRuns(dir, rootDir);
  writeReviewRun(dir, rootDir);
  writeFixLoopRuns(dir, rootDir);
  writeVerifyRun(dir, rootDir);
  writeScopeRequestRun(dir, rootDir);
  writePlanDraftRun(dir, rootDir);
  writeStoppedRun(dir, rootDir);
  writeReviewDiffs(dir, rootDir);

  writeActorIdentity(rootDir, home, handle);
}
