import type { ActorContext, TaskStore } from '@dispatch/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import {
  attachGitHubReplies,
  mapGitHubComment,
  mergeComments,
  partitionGitHubComments,
} from '../githubComments.js';
import type {
  ReviewComment,
  ReviewCommentStore,
  ReviewReply,
} from '../reviewComments.js';
import type { ReviewTarget } from '../reviewTarget.js';
import type { Orchestrator } from './orchestrator.js';
import type { RunMeta } from './types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  TERMINAL_RUN_STATES,
} from './types.js';
import type { DiffResult } from './worktree.js';

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// The command-runner seam (mirrors worktree.ts's private `runGit`, but
// exposed and injectable here): every `gh`/`git push` call PrManager makes
// goes through this, so tests can stub `gh`/network entirely instead of
// requiring a real GitHub remote and an authenticated `gh` CLI.
//
// Minor fix: async (Bun.spawn + await under defaultCommandRunner, never
// Bun.spawnSync) — a real `gh pr create`/`git push`/`gh pr view` call can
// take a real amount of wall-clock time (network round trips to GitHub),
// and dispatchd is a single process serving every other HTTP request and
// live run on the same event loop; a synchronous shell-out here would stall
// all of that for as long as the git/gh call takes.
// `opts.timeoutMs` bounds how long the command may run before it is killed and
// reported as a failure. Only the merge queue's verify step passes it: rebase and
// merge are fast local git operations, and cutting a merge short mid-write is
// more dangerous than letting it finish. Optional, so every existing caller and
// test stub is unaffected — TypeScript accepts a function of fewer parameters
// where more are expected.
export type CommandRunner = (
  cwd: string,
  cmd: string[],
  opts?: { timeoutMs?: number; onOutput?: (chunk: string) => void }
) => Promise<CommandResult>;

// Guards a PR number before it is ever used to build a ReviewTarget or a
// REST path. Task 1's review flagged that reviewTargetSlug does not
// validate its `pr` branch's number — {kind:'pr', number:1.5} would happily
// produce `pr-1.5.review.json` — and this is where a PR target is actually
// constructed from a route parameter, so the check belongs here rather than
// trusting the caller.
function requirePrNumber(number: number): void {
  if (!Number.isInteger(number) || number <= 0) {
    throw new OrchestratorClientError(`invalid PR number: ${number}`);
  }
}

// Picks whichever of a failed command's stderr/stdout actually has content,
// preferring stderr — used instead of `stderr.trim() || stdout.trim()` so
// the choice is an explicit length check rather than relying on empty-string
// falsiness.
function commandErrorText(result: CommandResult): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

// Drains a piped stream to a string, handing each decoded chunk to `onOutput` as
// it arrives. Used instead of `new Response(stream).text()` when a caller wants
// progress while a long command runs — that helper only resolves once the stream
// has ended, which for a multi-minute verify means no output until it is over.
async function drain(
  stream: ReadableStream<Uint8Array>,
  onOutput?: (chunk: string) => void
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // `stream: true` so a multi-byte character split across chunk boundaries is
    // not mangled into replacement characters.
    const chunk = decoder.decode(value, { stream: true });
    if (chunk !== '') {
      text += chunk;
      onOutput?.(chunk);
    }
  }
  const tail = decoder.decode();
  if (tail !== '') {
    text += tail;
    onOutput?.(tail);
  }
  return text;
}

export async function defaultCommandRunner(
  cwd: string,
  cmd: string[],
  opts?: { timeoutMs?: number; onOutput?: (chunk: string) => void }
): Promise<CommandResult> {
  // Bun.spawn THROWS synchronously when the executable isn't on PATH (e.g.
  // `gh` missing from a Finder-launched app's minimal environment) — an
  // uncaught throw here took the whole daemon down at boot via
  // detectPrCapability. A missing binary is just a failed command: report
  // ok:false so callers degrade (pr capability false) instead of crashing.
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const collect = Promise.all([
      drain(proc.stdout, opts?.onOutput),
      drain(proc.stderr, opts?.onOutput),
      proc.exited,
    ]);
    const timeoutMs = opts?.timeoutMs;
    if (timeoutMs === undefined) {
      const [stdout, stderr, exitCode] = await collect;
      return { ok: exitCode === 0, stdout, stderr };
    }
    // A genuine race, not "kill it and keep waiting".
    //
    // This used to SIGKILL the child and then still `await collect`, on the
    // assumption that killing it would close the pipes. It does not always:
    // the child here is `bash -lc "<command>"`, SIGKILL does not reap bash's
    // descendants, and a surviving grandchild keeps the inherited stdout and
    // stderr write ends open. `drain()` then never sees EOF, `collect` never
    // resolves, and the timeout that exists to bound this waits forever with
    // it. That wedged a real merge queue: a verify step sat "running" with no
    // process behind it for hours, blocking every entry queued after it, while
    // the 600s timeout had already fired and changed nothing.
    //
    // Racing means the timeout always returns. The reader promises may still
    // be pending afterwards; they hold a pipe and a closure, which is a leak
    // worth accepting to avoid a queue that never moves again.
    let timedOut = false;
    let onTimeout: (() => void) | undefined;
    const expiry = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
        resolve('timeout');
      }, timeoutMs);
      onTimeout = () => clearTimeout(timer);
    });

    try {
      const outcome = await Promise.race([collect, expiry]);
      if (outcome === 'timeout' || timedOut) {
        return {
          ok: false,
          stdout: '',
          stderr: `timed out after ${timeoutMs}ms`,
        };
      }
      const [stdout, stderr, exitCode] = outcome;
      return { ok: exitCode === 0, stdout, stderr };
    } finally {
      onTimeout?.();
    }
  } catch (err) {
    return { ok: false, stdout: '', stderr: (err as Error).message };
  }
}

// Whether this project can use the PR review action: `gh` must be reachable
// on PATH and the main checkout must have a configured `origin` remote.
// Called once at boot (see index.ts) and cached for the process lifetime —
// `GET /api/health` exposes the result as `pr` so a client can hide/disable
// the PR action without probing per-run.
export async function detectPrCapability(
  rootDir: string,
  run: CommandRunner = defaultCommandRunner
): Promise<boolean> {
  const gh = await run(rootDir, ['gh', '--version']);
  if (!gh.ok) return false;
  const remote = await run(rootDir, ['git', 'remote', 'get-url', 'origin']);
  return remote.ok;
}

export interface PrManagerContext {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  orchestrator: Orchestrator;
  // Optional, same "tests may omit it" contract as OrchestratorContext's own
  // field — openPr() below falls back to an unattributed Activity line when
  // it's absent.
  actorContext?: ActorContext;
  // The comment mirror's local half — syncPrComments/pushPrReview read and
  // write a PR target's comments here. Shared with ReviewRunner rather than
  // constructed twice: a review run's comments and a human's land in the
  // same per-target file.
  reviewComments: ReviewCommentStore;
}

// A CI check rollup summarized to counts the UI can render as a compact
// pass/fail/pending line, instead of the raw per-check array GitHub returns.
interface PrCheckSummary {
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

// The reviewable state of a run's GitHub PR, from `gh pr view --json …`.
// Every field is what the review UI needs to show status at a glance without
// the person leaving the app for GitHub.
interface PrStatus {
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  // GitHub's own aggregate review verdict — null when no review rule applies.
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  checks: PrCheckSummary;
  additions: number;
  deletions: number;
  changedFiles: number;
}

// One item in a PR's conversation — a submitted review (with its verdict), a
// PR-level comment, or a code-line comment (carrying its file + line). Unified
// into one shape so the UI renders them as a single time-ordered thread.
interface PrConversationItem {
  kind: 'review' | 'comment' | 'line-comment';
  author: string;
  body: string;
  createdAt: string;
  /** For `kind: 'review'` — the review's verdict. */
  state?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  /** For `kind: 'line-comment'` — where in the diff it's anchored. */
  path?: string;
  line?: number;
}

export interface PrDetail {
  status: PrStatus;
  conversation: PrConversationItem[];
}

// The three review verdicts `gh pr review` can submit — approve needs no body,
// the other two require one (enforced at the API layer, mirroring gh itself).
export type PrReviewEvent = 'approve' | 'request-changes' | 'comment';

// One open PR in the repo, from `gh pr list --json …` — the body of
// `GET /api/prs`. Carries the same status the review UI shows, so the queue
// renders every row from one batched call instead of a `gh pr view` per PR.
export interface RepoPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  /** Head commit SHA — the `commit_id` GitHub wants when posting a review comment. */
  headRefOid: string;
  /** True when the head branch lives in a fork; gates Phase 4's confirm. */
  isCrossRepository: boolean;
  /** Login owning the head repository, named in that confirm. */
  headRepositoryOwner: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  checks: PrCheckSummary;
  additions: number;
  deletions: number;
  changedFiles: number;
}

// Splits a GitHub PR URL (https://github.com/OWNER/REPO/pull/N) into its
// parts, so the line-comment REST call (which gh's `pr view --json` can't
// return) can address the right repo/PR. Returns null for anything that isn't
// a recognizable PR URL, so a caller degrades to "no line comments" rather
// than throwing on a malformed stored URL.
function parsePrUrl(
  url: string
): { owner: string; repo: string; number: number } | null {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (match === null) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

// Collapses GitHub's per-check rollup (a mix of CheckRun and StatusContext
// nodes, each reporting completion differently) into pass/fail/pending counts.
// A CheckRun reports `status` (COMPLETED/IN_PROGRESS/QUEUED) + `conclusion`
// (SUCCESS/FAILURE/…); a legacy StatusContext reports `state`
// (SUCCESS/FAILURE/PENDING/ERROR). Anything not clearly success or failure
// counts as pending, so an in-flight run reads as pending rather than passed.
function summarizeChecks(rollup: unknown): PrCheckSummary {
  const summary: PrCheckSummary = {
    passed: 0,
    failed: 0,
    pending: 0,
    total: 0,
  };
  if (!Array.isArray(rollup)) return summary;
  for (const raw of rollup) {
    if (raw === null || typeof raw !== 'object') continue;
    const check = raw as { conclusion?: unknown; state?: unknown };
    const verdict = ghString(check.conclusion ?? check.state).toUpperCase();
    summary.total += 1;
    if (
      verdict === 'SUCCESS' ||
      verdict === 'NEUTRAL' ||
      verdict === 'SKIPPED'
    ) {
      summary.passed += 1;
    } else if (
      verdict === 'FAILURE' ||
      verdict === 'ERROR' ||
      verdict === 'CANCELLED' ||
      verdict === 'TIMED_OUT' ||
      verdict === 'ACTION_REQUIRED'
    ) {
      summary.failed += 1;
    } else {
      summary.pending += 1;
    }
  }
  return summary;
}

// GitHub's per-file status strings, mapped to the single letters the diff UI
// already renders (matching `git diff --name-status` output).
const FILE_STATUS_LETTER: Record<string, string> = {
  added: 'A',
  modified: 'M',
  changed: 'M',
  unchanged: 'M',
  removed: 'D',
  renamed: 'R',
  copied: 'C',
};

/**
 * The PR review path (spec §5 Review): pushes a finished run's branch and
 * opens a GitHub PR via `gh pr create`, then polls that PR's merge state on
 * an interval, flipping the run to reviewed + the task to `done` the moment
 * GitHub reports it merged. Every `gh`/`git` invocation goes through the
 * injected (async) CommandRunner seam so tests never need a real remote or
 * a logged-in `gh` CLI, and so a slow real call never blocks the process.
 */
export class PrManager {
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly ctx: PrManagerContext,
    private readonly capability: boolean,
    private readonly run: CommandRunner = defaultCommandRunner
  ) {}

  // POST /api/runs/:id/review { action: 'pr' }. Pushes the run's branch and
  // opens a PR — the run itself stays un-reviewed (reviewedAt unset) until
  // pollOnce() below sees it merged. 409s outright when this project lacks
  // the `pr` capability, matching the plan's "no remote/gh -> 409 with clear
  // message".
  async openPr(runId: string): Promise<RunMeta> {
    if (!this.capability) {
      throw new OrchestratorConflictError(
        'PR review requires the gh CLI and a configured git remote'
      );
    }
    const result = this.ctx.orchestrator.getRun(runId);
    if (result === null) {
      throw new OrchestratorNotFoundError(`run not found: ${runId}`);
    }
    const { meta } = result;
    if (!TERMINAL_RUN_STATES.has(meta.state)) {
      throw new OrchestratorConflictError(
        `run is not in a terminal state: ${runId} (state: ${meta.state})`
      );
    }
    if (meta.reviewedAt !== undefined) {
      throw new OrchestratorConflictError(
        `run has already been reviewed: ${runId}`
      );
    }
    if (meta.prUrl !== undefined) {
      throw new OrchestratorConflictError(
        `run already has an open PR: ${meta.prUrl}`
      );
    }

    const push = await this.run(meta.worktreePath, [
      'git',
      'push',
      '-u',
      'origin',
      meta.branch,
    ]);
    if (!push.ok) {
      throw new OrchestratorConflictError(
        `git push failed: ${commandErrorText(push)}`
      );
    }
    const body = `Automated PR opened by dispatch for task ${meta.taskId} (run ${meta.id}).`;
    const create = await this.run(meta.worktreePath, [
      'gh',
      'pr',
      'create',
      '--title',
      meta.taskTitle,
      '--body',
      body,
      '--base',
      meta.baseBranch,
      '--head',
      meta.branch,
    ]);
    if (!create.ok) {
      throw new OrchestratorConflictError(
        `gh pr create failed: ${commandErrorText(create)}`
      );
    }
    // `gh pr create`'s only stdout on success is the PR's URL (its last
    // non-empty line, per gh's own documented output contract).
    const url =
      create.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop() ?? '';

    const now = new Date().toISOString();
    this.ctx.store.update(
      meta.taskId,
      {
        appendActivity: `${now} run ${runId} opened PR: ${url}`,
        // openPr() has exactly one caller: the human pressing the PR review
        // action via the API.
        activityActor: this.ctx.actorContext?.humanRef,
      },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
    return this.ctx.orchestrator.setRunPrUrl(runId, url);
  }

  // GET /api/prs (item B): every open PR in the repo, not just the ones
  // dispatch itself opened — the client renders dispatch's own PR rows
  // separately (via each run's `prUrl`) and lists whatever's left over here
  // under "Other open PRs". 409s outright when this project lacks the `pr`
  // capability, same as openPr — there's no gh/remote to list against.
  async listRepoPrs(): Promise<RepoPr[]> {
    if (!this.capability) {
      throw new OrchestratorConflictError(
        'PR review requires the gh CLI and a configured git remote'
      );
    }
    const result = await this.run(this.ctx.rootDir, [
      'gh',
      'pr',
      'list',
      '--json',
      'number,title,url,headRefName,headRefOid,author,isDraft,updatedAt,' +
        'isCrossRepository,headRepositoryOwner,reviewDecision,mergeable,' +
        'statusCheckRollup,additions,deletions,changedFiles',
      '--state',
      'open',
      '--limit',
      '50',
    ]);
    if (!result.ok) {
      throw new OrchestratorConflictError(
        `gh pr list failed: ${commandErrorText(result)}`
      );
    }
    let raw: Array<Record<string, unknown>>;
    try {
      raw = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    } catch {
      throw new OrchestratorConflictError('gh pr list returned invalid JSON');
    }
    return raw.map((item) => ({
      number: Number(item.number ?? 0),
      title: ghString(item.title),
      url: ghString(item.url),
      headRefName: ghString(item.headRefName),
      author: authorLogin(item.author),
      isDraft: item.isDraft === true,
      updatedAt: ghString(item.updatedAt),
      headRefOid: ghString(item.headRefOid),
      isCrossRepository: item.isCrossRepository === true,
      headRepositoryOwner: authorLogin(item.headRepositoryOwner),
      reviewDecision: (item.reviewDecision as RepoPr['reviewDecision']) ?? null,
      mergeable: (item.mergeable as RepoPr['mergeable']) ?? null,
      checks: summarizeChecks(item.statusCheckRollup),
      additions: Number(item.additions ?? 0),
      deletions: Number(item.deletions ?? 0),
      changedFiles: Number(item.changedFiles ?? 0),
    }));
  }

  // Starts the merge poller on `intervalMs` (default 60s per the plan;
  // tests pass a much shorter interval via startServer's
  // `prPollIntervalMs`). A no-op if this project lacks the `pr` capability —
  // nothing was ever opened, so nothing needs polling.
  startPolling(intervalMs = 60000): void {
    if (!this.capability) return;
    // setInterval's callback can't be awaited directly; pollOnce() is async
    // now (minor fix), so each tick is fired-and-forgotten with its own
    // rejection handler — a single poll pass failing outright (as opposed
    // to one run's check failing, which pollOnce already isolates) must
    // never crash the timer or the process.
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err: unknown) => {
        console.error(
          `dispatchd: PR poll pass failed: ${(err as Error).message}`
        );
      });
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  // One poll pass: checks every run with an open (un-reviewed) PR via
  // `gh pr view --json state`, and flips it to reviewed+done the moment
  // GitHub reports it merged. A single run's check failing (bad JSON, `gh`
  // erroring for that one call) is skipped rather than aborting the whole
  // pass — one flaky call must never block every other run's poll. Runs
  // are checked sequentially (not Promise.all) — polling is already on a
  // long interval, and sequential checks keep at most one `gh` subprocess
  // in flight at a time.
  async pollOnce(): Promise<void> {
    for (const meta of this.ctx.orchestrator.list()) {
      if (meta.prUrl === undefined || meta.reviewedAt !== undefined) continue;
      const view = await this.run(meta.worktreePath, [
        'gh',
        'pr',
        'view',
        meta.prUrl,
        '--json',
        'state',
      ]);
      if (!view.ok) continue;
      let state: string | undefined;
      try {
        state = (JSON.parse(view.stdout) as { state?: string }).state;
      } catch {
        continue;
      }
      if (state === 'MERGED') {
        this.ctx.orchestrator.markRunMergedViaPr(meta.id);
      }
    }
  }

  // Resolves a run that must have an open PR, for the in-app review calls
  // below — 404 for an unknown run, 409 for one that has no PR to act on.
  // gh calls run in the main checkout (`rootDir`, always present) rather than
  // the run's worktree, which merge/discard removes: a merged PR can still be
  // read here, and gh addresses the PR by its full URL regardless of cwd.
  private requireRunWithPr(runId: string): RunMeta {
    const result = this.ctx.orchestrator.getRun(runId);
    if (result === null) {
      throw new OrchestratorNotFoundError(`run not found: ${runId}`);
    }
    if (result.meta.prUrl === undefined) {
      throw new OrchestratorConflictError(`run has no open PR: ${runId}`);
    }
    return result.meta;
  }

  // GET /api/runs/:id/pr. The PR's current status plus its full conversation,
  // read live from GitHub via gh. Delegates to the URL-driven core below —
  // this method's only job is resolving which run's PR to look at.
  async getPrDetail(runId: string): Promise<PrDetail> {
    const meta = this.requireRunWithPr(runId);
    return this.getPrDetailByUrl(meta.prUrl!, meta.taskTitle);
  }

  // The URL-driven core of getPrDetail — everything above resolves a run to
  // its PR's url and delegates here; GET /api/prs/:number/detail (item B's
  // in-app review for a repo PR dispatch never opened) calls this directly
  // with a url resolved from listRepoPrs(), since a repo PR has no run/meta
  // to read a url from. `fallbackTitle` mirrors the run path's own
  // `meta.taskTitle` fallback (used only on the rare gh payload with no
  // `title`) — the by-number path passes the title `listRepoPrs()` already
  // resolved, since that's the closest thing it has to `meta.taskTitle`.
  //
  // The status (state, checks, review verdict, diffstat) comes from one
  // `gh pr view --json` call; the conversation folds together submitted
  // reviews, PR-level comments, and — via a REST call gh's `pr view` can't
  // cover — code-line comments, all sorted oldest-first.
  async getPrDetailByUrl(url: string, fallbackTitle = ''): Promise<PrDetail> {
    const view = await this.run(this.ctx.rootDir, [
      'gh',
      'pr',
      'view',
      url,
      '--json',
      'number,url,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup,additions,deletions,changedFiles,reviews,comments',
    ]);
    if (!view.ok) {
      throw new OrchestratorConflictError(
        `gh pr view failed: ${commandErrorText(view)}`
      );
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(view.stdout) as Record<string, unknown>;
    } catch {
      throw new OrchestratorConflictError('gh pr view returned invalid JSON');
    }

    const status: PrStatus = {
      number: Number(raw.number ?? 0),
      url: ghString(raw.url, url),
      title: ghString(raw.title, fallbackTitle),
      state: (raw.state as PrStatus['state']) ?? 'OPEN',
      isDraft: raw.isDraft === true,
      reviewDecision:
        (raw.reviewDecision as PrStatus['reviewDecision']) ?? null,
      mergeable: (raw.mergeable as PrStatus['mergeable']) ?? null,
      checks: summarizeChecks(raw.statusCheckRollup),
      additions: Number(raw.additions ?? 0),
      deletions: Number(raw.deletions ?? 0),
      changedFiles: Number(raw.changedFiles ?? 0),
    };

    const conversation: PrConversationItem[] = [];
    // Submitted reviews (approve / request-changes / comment), keeping only
    // those that actually carry a verdict or a body — gh includes a bare
    // "PENDING"/empty review row for a self-review-in-progress otherwise.
    if (Array.isArray(raw.reviews)) {
      for (const r of raw.reviews as Array<Record<string, unknown>>) {
        const state = ghString(r.state).toUpperCase();
        const body = ghString(r.body);
        if (state === 'PENDING' || (state === '' && body === '')) continue;
        conversation.push({
          kind: 'review',
          author: authorLogin(r.author),
          body,
          createdAt: ghString(r.submittedAt ?? r.createdAt),
          state: state as PrConversationItem['state'],
        });
      }
    }
    // PR-level (issue) comments.
    if (Array.isArray(raw.comments)) {
      for (const c of raw.comments as Array<Record<string, unknown>>) {
        conversation.push({
          kind: 'comment',
          author: authorLogin(c.author),
          body: ghString(c.body),
          createdAt: ghString(c.createdAt),
        });
      }
    }
    // Code-line comments come from the REST API, not `pr view` — best-effort,
    // so a permissions/parse hiccup just drops the line comments rather than
    // failing the whole status read. `--paginate` because this endpoint pages
    // at 30 and the review rail promises github.com replies show up here.
    const location = parsePrUrl(url);
    if (location !== null) {
      const rest = await this.run(this.ctx.rootDir, [
        'gh',
        'api',
        '--paginate',
        `repos/${location.owner}/${location.repo}/pulls/${location.number}/comments`,
      ]);
      if (rest.ok) {
        try {
          const items = JSON.parse(rest.stdout) as Array<
            Record<string, unknown>
          >;
          for (const c of items) {
            conversation.push({
              kind: 'line-comment',
              author: authorLogin(c.user),
              body: ghString(c.body),
              createdAt: ghString(c.created_at),
              path: c.path !== undefined ? ghString(c.path) : undefined,
              line:
                c.line !== undefined && c.line !== null
                  ? Number(c.line)
                  : undefined,
            });
          }
        } catch {
          // Leave line comments out on malformed JSON.
        }
      }
    }
    conversation.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { status, conversation };
  }

  // GET /api/prs/:number/diff. A PR's diff in the same shape a run's worktree
  // diff produces, so the review UI renders both through one component.
  //
  // Two calls, mirroring worktree.diff(): `gh pr diff` for the raw patch, and
  // the REST files list for per-file status, which `pr diff` does not report.
  // Nothing here parses the patch — `DiffResult.patch` is stdout verbatim.
  async getPrDiffByUrl(url: string): Promise<DiffResult> {
    const location = parsePrUrl(url);
    if (location === null) {
      throw new OrchestratorConflictError(`unrecognizable PR url: ${url}`);
    }
    const patch = await this.run(this.ctx.rootDir, ['gh', 'pr', 'diff', url]);
    if (!patch.ok) {
      throw new OrchestratorConflictError(
        `gh pr diff failed: ${commandErrorText(patch)}`
      );
    }
    const listed = await this.run(this.ctx.rootDir, [
      'gh',
      'api',
      '--paginate',
      `repos/${location.owner}/${location.repo}/pulls/${location.number}/files`,
    ]);
    if (!listed.ok) {
      throw new OrchestratorConflictError(
        `gh api pulls/files failed: ${commandErrorText(listed)}`
      );
    }
    let raw: Array<Record<string, unknown>>;
    try {
      raw = JSON.parse(listed.stdout) as Array<Record<string, unknown>>;
    } catch {
      throw new OrchestratorConflictError(
        'gh api pulls/files returned invalid JSON'
      );
    }
    // Guard each element's shape rather than stringifying whatever arrived:
    // `String(obj)` on a non-string filename silently yields the literal
    // text "[object Object]" as a file path, which would render as a
    // real-looking but garbage row in the diff UI. A malformed entry throws
    // instead, matching this function's existing fail-loudly posture.
    const files = raw.map((item) => {
      const filename = item.filename;
      if (typeof filename !== 'string') {
        throw new OrchestratorConflictError(
          'gh api pulls/files returned a file entry with no string filename'
        );
      }
      const status = item.status;
      return {
        path: filename,
        status:
          typeof status === 'string'
            ? (FILE_STATUS_LETTER[status] ?? 'M')
            : 'M',
      };
    });
    return { patch: patch.stdout, files };
  }

  // POST /api/runs/:id/pr/review. Submits a GitHub review on the run's PR —
  // approve (body optional), request-changes, or comment (both require a
  // body, enforced by the API layer). Delegates to the URL-driven core below,
  // same "resolve run -> url, then act on the url" split as getPrDetail.
  async reviewPr(
    runId: string,
    event: PrReviewEvent,
    body: string
  ): Promise<PrDetail> {
    const meta = this.requireRunWithPr(runId);
    return this.reviewPrByUrl(meta.prUrl!, event, body);
  }

  // The URL-driven core of reviewPr — GET/POST /api/prs/:number/review (item
  // B's in-app review for a repo PR) calls this directly with a url resolved
  // from listRepoPrs(). Returns the refreshed PrDetail so the client
  // re-renders with the new verdict/conversation in one round trip.
  async reviewPrByUrl(
    url: string,
    event: PrReviewEvent,
    body: string
  ): Promise<PrDetail> {
    const flag =
      event === 'approve'
        ? '--approve'
        : event === 'request-changes'
          ? '--request-changes'
          : '--comment';
    const cmd = ['gh', 'pr', 'review', url, flag];
    if (body.trim() !== '') cmd.push('--body', body);
    const result = await this.run(this.ctx.rootDir, cmd);
    if (!result.ok) {
      throw new OrchestratorConflictError(
        `gh pr review failed: ${commandErrorText(result)}`
      );
    }
    return this.getPrDetailByUrl(url);
  }

  // POST /api/runs/:id/pr/comment. Adds a PR-level comment (not a review) via
  // `gh pr comment`, then returns the refreshed detail. Delegates to the
  // URL-driven core below, same split as getPrDetail/reviewPr.
  async commentPr(runId: string, body: string): Promise<PrDetail> {
    const meta = this.requireRunWithPr(runId);
    return this.commentPrByUrl(meta.prUrl!, body);
  }

  // The URL-driven core of commentPr — POST /api/prs/:number/comment (item
  // B's in-app review for a repo PR) calls this directly with a url resolved
  // from listRepoPrs().
  async commentPrByUrl(url: string, body: string): Promise<PrDetail> {
    const result = await this.run(this.ctx.rootDir, [
      'gh',
      'pr',
      'comment',
      url,
      '--body',
      body,
    ]);
    if (!result.ok) {
      throw new OrchestratorConflictError(
        `gh pr comment failed: ${commandErrorText(result)}`
      );
    }
    return this.getPrDetailByUrl(url);
  }

  // Resolves a bare PR number — the form syncPrComments/pushPrReview take,
  // straight from a route param — to the RepoPr entry both need: the url
  // (for owner/repo) and headRefOid (the review's commit_id). Mirrors
  // api.ts's own resolveRepoPrByNumber; duplicated rather than shared
  // because these two methods, unlike every other PrManager entry point,
  // are given a number instead of a url and have to do this resolution
  // themselves.
  private async resolvePrForComments(number: number): Promise<RepoPr> {
    requirePrNumber(number);
    const prs = await this.listRepoPrs();
    const pr = prs.find((p) => p.number === number);
    if (pr === undefined) {
      throw new OrchestratorNotFoundError(`PR not found: #${number}`);
    }
    return pr;
  }

  // Fetches every review comment GitHub has for a PR as raw REST payloads,
  // WITHOUT mapping or touching the local store — the shared read at the
  // bottom of both pullRemoteComments and syncPrComments.
  //
  // `--paginate`: the REST endpoint pages at 30 comments, and unpaginated it
  // silently truncates at page 1 — which mergeComments would read as GitHub
  // having deleted comments 31+, erasing their local-only replies/resolved
  // state on every sync. gh merges the pages of an array response into one
  // array (the same way getPrDiffByUrl's `/files` call relies on), so the
  // output stays a single JSON.parse target.
  private async fetchRawComments(
    location: NonNullable<ReturnType<typeof parsePrUrl>>
  ): Promise<Record<string, unknown>[]> {
    const result = await this.run(this.ctx.rootDir, [
      'gh',
      'api',
      '--paginate',
      `repos/${location.owner}/${location.repo}/pulls/${location.number}/comments`,
    ]);
    if (!result.ok) {
      throw new OrchestratorConflictError(
        `gh api pulls/comments failed: ${commandErrorText(result)}`
      );
    }
    try {
      // `.flat()` is a no-op on the flat array gh returns; it is kept so a
      // page-wrapped array (what `--slurp` would produce) also parses.
      return (JSON.parse(result.stdout) as unknown[]).flat() as Record<
        string,
        unknown
      >[];
    } catch {
      throw new OrchestratorConflictError(
        'gh api pulls/comments returned invalid JSON'
      );
    }
  }

  // Fetches and maps every review comment with mapGitHubComment, WITHOUT
  // touching the local store — the read-only half pushPrReview builds on
  // so it can pull before writing. syncPrComments handles replies itself.
  private async pullRemoteComments(
    location: NonNullable<ReturnType<typeof parsePrUrl>>
  ): Promise<ReviewComment[]> {
    const raw = await this.fetchRawComments(location);
    return raw
      .map((item) => mapGitHubComment(item))
      .filter((c): c is ReviewComment => c !== null);
  }

  // GET-ish pull half of the comment mirror: pulls every review comment
  // GitHub has for the PR, merges with whatever mergeComments's six rules
  // say to keep from disk, attaches any pulled replies to their parents,
  // persists the result, and returns it. Hits the exact same REST endpoint
  // getPrDetailByUrl already reads for its read-only conversation view —
  // this is the write-back half that also updates the local mirror.
  async syncPrComments(number: number): Promise<ReviewComment[]> {
    const pr = await this.resolvePrForComments(number);
    const location = parsePrUrl(pr.url);
    if (location === null) {
      throw new OrchestratorConflictError(`unrecognizable PR url: ${pr.url}`);
    }
    const raw = await this.fetchRawComments(location);
    const { roots, replies } = partitionGitHubComments(raw);
    const remote = roots
      .map((item) => mapGitHubComment(item))
      .filter((c): c is ReviewComment => c !== null);
    const target: ReviewTarget = { kind: 'pr', number };
    const merged = mergeComments(this.ctx.reviewComments.list(target), remote);
    // Attach AFTER the merge: mergeComments always keeps the local side's
    // `replies` array, so attaching to `remote` first would be discarded.
    const withReplies = attachGitHubReplies(merged, replies);
    this.ctx.reviewComments.replaceAll(target, withReplies);
    return withReplies;
  }

  // POST /api/prs/:number/review-submit (Task 6) — not .../review, which
  // already exists as reviewRepoPr's one-shot `gh pr review` verdict; this
  // is the push half of the comment mirror instead. Submits every pending
  // comment on a PR target as one GitHub review: every pending comment
  // rides one `comments[]` array on a single request, since looping per
  // comment would make GitHub render N separate reviews instead of one.
  async pushPrReview(
    number: number,
    verdict: PrReviewEvent,
    body: string
  ): Promise<{ pushed: number }> {
    const pr = await this.resolvePrForComments(number);
    const location = parsePrUrl(pr.url);
    if (location === null) {
      throw new OrchestratorConflictError(`unrecognizable PR url: ${pr.url}`);
    }
    const target: ReviewTarget = { kind: 'pr', number };
    const all = this.ctx.reviewComments.list(target);
    const pending = all.filter((c) => c.pending);

    const event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' =
      verdict === 'approve'
        ? 'APPROVE'
        : verdict === 'request-changes'
          ? 'REQUEST_CHANGES'
          : 'COMMENT';
    // commit_id belongs to the review as a whole, not to each comment — the
    // batch endpoint takes one top-level sha, sourced from the PR's head.
    // Dispatch's composer only ever writes side:'RIGHT' line comments, so
    // that is the only side synthesized here.
    const payload = {
      commit_id: pr.headRefOid,
      event,
      body,
      comments: pending.map((c) => ({
        path: c.file,
        line: c.line,
        side: 'RIGHT' as const,
        body: c.body,
      })),
    };

    // gh's -F/-f field flags can express a scalar array but not an array of
    // objects (each comment needs path/line/side/body together — see
    // cli/cli#3937), and CommandRunner's argv-only signature has no stdin
    // to carry `--input -`. A scratch file keeps the whole call on the
    // injected seam: this.run still receives a plain argv, only the
    // payload's bytes move through disk instead of a pipe.
    const scratchDir = mkdtempSync(join(tmpdir(), 'dispatch-pr-review-'));
    const payloadPath = join(scratchDir, 'review.json');
    try {
      writeFileSync(payloadPath, JSON.stringify(payload));
      const result = await this.run(this.ctx.rootDir, [
        'gh',
        'api',
        '-X',
        'POST',
        `repos/${location.owner}/${location.repo}/pulls/${location.number}/reviews`,
        '--input',
        payloadPath,
      ]);
      if (!result.ok) {
        // Nothing above touched the store: every pending comment, including
        // this whole batch, survives exactly as the reviewer left it — a
        // failed push must never lose their writing.
        throw new OrchestratorConflictError(
          `gh api pulls/reviews failed: ${commandErrorText(result)}`
        );
      }
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }

    if (pending.length === 0) {
      return { pushed: 0 };
    }

    const pushedIds = new Set(pending.map((c) => c.id));
    // Record that this batch has left, in its own write, before the pull
    // below can fail. GitHub has the comments now and there is no way to
    // delete them, so a record still marked `pending` would be posted a
    // second time by the next verdict and duplicate the note for good.
    const posted = this.ctx.reviewComments
      .list(target)
      .map((c) => (pushedIds.has(c.id) ? { ...c, pending: false } : c));
    this.ctx.reviewComments.replaceAll(target, posted);

    // The batch just posted now exists on GitHub with real ids. Reviewer
    // replies and resolution written locally against these drafts exist
    // nowhere else — GitHub never saw them — so they have to be carried
    // forward onto whatever record replaces the draft. Matched by
    // (file, body) rather than the draft's local id, since the draft's id
    // does not survive the swap below.
    const localExtras = new Map<
      string,
      { replies: ReviewReply[]; resolved: boolean }
    >();
    for (const c of pending) {
      localExtras.set(`${c.file} ${c.body}`, {
        replies: c.replies,
        resolved: c.resolved,
      });
    }

    // Pull BEFORE writing the merge. If this fails, the batch is already
    // marked non-pending above (so nothing re-sends it) and the reviewer's
    // text is still on disk, rather than deleted with nothing to replace
    // it — which reordering "delete, write, then pull" would risk.
    const remote = await this.pullRemoteComments(location);
    // Re-read rather than reuse `all`/`pending`: this.run above awaited two
    // network round trips (the POST and this pull), wide open for a
    // concurrent add() to land a fresh pending comment. Filtering by this
    // batch's own ids (not a blanket !pending) keeps that comment instead
    // of discarding it under a stale snapshot.
    const remaining = this.ctx.reviewComments
      .list(target)
      .filter((c) => !pushedIds.has(c.id));
    // Every githubId the store already knew about. A draft's replacement is
    // by definition an id that is new here, so restricting the carry-forward
    // to those is what stops a same-file, same-body draft from overwriting
    // an unrelated already-synced comment's replies and resolved flag.
    const knownIds = new Set(
      remaining
        .map((c) => c.githubId)
        .filter((id): id is number => id !== undefined)
    );
    // mapGitHubComment always sets githubId and pending together — so
    // letting mergeComments' remote-only rule create the replacement here
    // (rather than flipping `pending` on the draft directly) is what keeps
    // those two fields from ever landing as two separate writes, which is
    // the invariant mergeComments itself cannot enforce.
    const merged = mergeComments(remaining, remote).map((c) => {
      if (c.githubId === undefined || knownIds.has(c.githubId)) return c;
      const extra = localExtras.get(`${c.file} ${c.body}`);
      if (extra === undefined) return c;
      return { ...c, replies: extra.replies, resolved: extra.resolved };
    });
    this.ctx.reviewComments.replaceAll(target, merged);
    return { pushed: pending.length };
  }

  // POST /api/prs/:number/comments/:id/reply (Task 5). Replies via REST's
  // `in_reply_to`, which needs a comment GitHub already knows about — a
  // local-only draft has no `githubId`, so that case is refused up front.
  async replyToComment(
    number: number,
    commentId: string,
    body: string
  ): Promise<ReviewComment> {
    const pr = await this.resolvePrForComments(number);
    const location = parsePrUrl(pr.url);
    if (location === null) {
      throw new OrchestratorConflictError(`unrecognizable PR url: ${pr.url}`);
    }
    const target: ReviewTarget = { kind: 'pr', number };
    const parent = this.ctx.reviewComments
      .list(target)
      .find((c) => c.id === commentId);
    if (parent === undefined) {
      throw new OrchestratorNotFoundError(
        `review comment not found: ${commentId}`
      );
    }
    if (parent.githubId === undefined) {
      throw new OrchestratorConflictError(
        `comment has not been pushed to GitHub yet: ${commentId}`
      );
    }
    const result = await this.run(this.ctx.rootDir, [
      'gh',
      'api',
      '-X',
      'POST',
      `repos/${location.owner}/${location.repo}/pulls/${location.number}/comments`,
      '-f',
      `body=${body}`,
      '-F',
      `in_reply_to=${parent.githubId}`,
    ]);
    if (!result.ok) {
      throw new OrchestratorConflictError(
        `gh api pulls/comments POST failed: ${commandErrorText(result)}`
      );
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new OrchestratorConflictError(
        'gh api pulls/comments POST returned invalid JSON'
      );
    }
    // GitHub's created comment is the source of truth for who/what/when —
    // `gh` may be authenticated as someone other than the caller.
    const replyBody = typeof raw.body === 'string' ? raw.body : body;
    const replyAuthor = authorLogin(raw.user);
    const replyCreated =
      typeof raw.created_at === 'string'
        ? raw.created_at
        : new Date().toISOString();
    const replyGithubId = typeof raw.id === 'number' ? raw.id : undefined;
    return this.ctx.reviewComments.reply(
      target,
      commentId,
      replyBody,
      replyAuthor,
      replyCreated,
      replyGithubId
    );
  }

  // Called from GET /api/prs/:number/comments (Task 6), right after
  // syncPrComments — not its own route. REST has no notion of a review
  // thread; this fetches each thread's GraphQL node id and stashes it on
  // every local comment matched by `githubId` (== `databaseId`), so
  // resolveComment below has something to resolve against.
  async syncReviewThreads(number: number): Promise<ReviewComment[]> {
    const pr = await this.resolvePrForComments(number);
    const location = parsePrUrl(pr.url);
    if (location === null) {
      throw new OrchestratorConflictError(`unrecognizable PR url: ${pr.url}`);
    }
    const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes { databaseId }
          }
        }
      }
    }
  }
}`;
    const result = await this.run(this.ctx.rootDir, [
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${location.owner}`,
      '-f',
      `repo=${location.repo}`,
      '-F',
      `number=${location.number}`,
    ]);
    if (!result.ok) {
      throw new OrchestratorConflictError(
        `gh api graphql reviewThreads failed: ${commandErrorText(result)}`
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw new OrchestratorConflictError(
        'gh api graphql reviewThreads returned invalid JSON'
      );
    }
    const threadByCommentId = collectThreads(raw);

    const target: ReviewTarget = { kind: 'pr', number };
    const updated = this.ctx.reviewComments.list(target).map((c) => {
      if (c.githubId === undefined) return c;
      const thread = threadByCommentId.get(c.githubId);
      if (thread === undefined) return c;
      // GitHub owns resolution — it lives on the thread, and this is the one
      // place Dispatch reads it back, so resolving on github.com shows here.
      // A response missing the flag leaves the local value alone.
      return {
        ...c,
        githubThreadId: thread.id,
        ...(thread.isResolved !== undefined
          ? { resolved: thread.isResolved }
          : {}),
      };
    });
    this.ctx.reviewComments.replaceAll(target, updated);
    return updated;
  }

  // PATCH /api/prs/:number/comments/:id (Task 6) — the PR-keyed twin of
  // PATCH /api/runs/:id/comments/:id, but over GraphQL: only
  // `resolveReviewThread`/`unresolveReviewThread` can touch this. A
  // comment with no `githubThreadId` yet fails loudly here, with no `gh`
  // call at all, rather than flipping the local flag on nothing.
  async resolveComment(
    number: number,
    commentId: string,
    resolved: boolean
  ): Promise<ReviewComment> {
    const target: ReviewTarget = { kind: 'pr', number };
    const comment = this.ctx.reviewComments
      .list(target)
      .find((c) => c.id === commentId);
    if (comment === undefined) {
      throw new OrchestratorNotFoundError(
        `review comment not found: ${commentId}`
      );
    }
    if (comment.githubThreadId === undefined) {
      throw new OrchestratorConflictError(
        `comment has no known GitHub review thread: ${commentId}`
      );
    }
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const query = `mutation($id: ID!) {
  ${mutation}(input: {threadId: $id}) {
    thread { id }
  }
}`;
    const result = await this.run(this.ctx.rootDir, [
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `id=${comment.githubThreadId}`,
    ]);
    if (!result.ok) {
      throw new OrchestratorConflictError(
        `gh api graphql ${mutation} failed: ${commandErrorText(result)}`
      );
    }
    // GitHub's GraphQL endpoint returns HTTP 200 even when the mutation
    // itself failed (stale/deleted thread id, no permission) — the failure
    // only shows up as a null payload plus an `errors` array, so `result.ok`
    // alone is not proof anything actually resolved.
    const threadId = extractMutationThreadId(result.stdout, mutation);
    if (threadId === undefined) {
      throw new OrchestratorConflictError(
        `gh api graphql ${mutation} failed: ${graphqlErrorMessage(result.stdout)}`
      );
    }
    return this.ctx.reviewComments.setResolved(target, commentId, resolved);
  }
}

// One GitHub review thread as syncReviewThreads needs it: the node id to
// resolve against, and GitHub's own resolution flag (absent when the
// response omitted it, which must not be read as "unresolved").
interface GitHubReviewThread {
  id: string;
  isResolved?: boolean;
}

// Walks a `reviewThreads` GraphQL response into a REST comment id -> thread
// lookup, tolerant of every missing-field shape (a thread sync should
// degrade to "nothing tagged", not throw on a still-valid response).
function collectThreads(raw: unknown): Map<number, GitHubReviewThread> {
  const threadByCommentId = new Map<number, GitHubReviewThread>();
  if (raw === null || typeof raw !== 'object') return threadByCommentId;
  const nodes = (
    raw as {
      data?: {
        repository?: {
          pullRequest?: { reviewThreads?: { nodes?: unknown[] } } | null;
        } | null;
      };
    }
  ).data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return threadByCommentId;
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue;
    const thread = node as {
      id?: unknown;
      isResolved?: unknown;
      comments?: { nodes?: unknown[] };
    };
    if (typeof thread.id !== 'string') continue;
    const entry: GitHubReviewThread = {
      id: thread.id,
      ...(typeof thread.isResolved === 'boolean'
        ? { isResolved: thread.isResolved }
        : {}),
    };
    const commentNodes = thread.comments?.nodes;
    if (!Array.isArray(commentNodes)) continue;
    for (const c of commentNodes) {
      if (c === null || typeof c !== 'object') continue;
      const databaseId = (c as { databaseId?: unknown }).databaseId;
      if (typeof databaseId === 'number') {
        threadByCommentId.set(databaseId, entry);
      }
    }
  }
  return threadByCommentId;
}

// Reads `data.<mutation>.thread.id`; undefined on parse failure or a null
// `data`/`data.<mutation>` — GitHub's own HTTP-200 failure signal.
function extractMutationThreadId(
  stdout: string,
  mutation: string
): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  const data = (raw as { data?: Record<string, unknown> | null }).data;
  if (data === null || data === undefined) return undefined;
  const entry = data[mutation] as { thread?: { id?: unknown } } | null;
  const id = entry?.thread?.id;
  return typeof id === 'string' ? id : undefined;
}

// Best-effort reason for a graphql call that reported ok:true without
// truly succeeding — GitHub's `errors[0].message`, or a generic fallback.
function graphqlErrorMessage(stdout: string): string {
  try {
    const raw = JSON.parse(stdout) as {
      errors?: Array<{ message?: unknown }>;
    };
    const message = raw.errors?.[0]?.message;
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    return 'invalid JSON response';
  }
  return 'no thread returned';
}

// Reads a string field off gh's `--json` output, which parses as `unknown`.
// Objects and arrays fall back rather than stringifying to "[object Object]",
// so a shape change in gh's payload surfaces as an empty field instead of
// garbage text stored on a PR record.
function ghString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

// Pulls a `login` off gh's author/user object shape (either `{login}` from the
// GraphQL `pr view` payload or `{login}` from the REST payload), falling back
// to a generic label so a comment from an unresolvable author still renders.
function authorLogin(author: unknown): string {
  if (author !== null && typeof author === 'object' && 'login' in author) {
    const login = (author as { login?: unknown }).login;
    if (typeof login === 'string' && login !== '') return login;
  }
  return 'someone';
}
