import type { TaskStore } from '@dispatch/core';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type { Orchestrator } from './orchestrator.js';
import type { RunMeta } from './types.js';
import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  TERMINAL_RUN_STATES,
} from './types.js';

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
export type CommandRunner = (
  cwd: string,
  cmd: string[]
) => Promise<CommandResult>;

// Picks whichever of a failed command's stderr/stdout actually has content,
// preferring stderr — used instead of `stderr.trim() || stdout.trim()` so
// the choice is an explicit length check rather than relying on empty-string
// falsiness.
function commandErrorText(result: CommandResult): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

export async function defaultCommandRunner(
  cwd: string,
  cmd: string[]
): Promise<CommandResult> {
  // Bun.spawn THROWS synchronously when the executable isn't on PATH (e.g.
  // `gh` missing from a Finder-launched app's minimal environment) — an
  // uncaught throw here took the whole daemon down at boot via
  // detectPrCapability. A missing binary is just a failed command: report
  // ok:false so callers degrade (pr capability false) instead of crashing.
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout, stderr };
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
}

// A CI check rollup summarized to counts the UI can render as a compact
// pass/fail/pending line, instead of the raw per-check array GitHub returns.
export interface PrCheckSummary {
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

// The reviewable state of a run's GitHub PR, from `gh pr view --json …`.
// Every field is what the review UI needs to show status at a glance without
// the person leaving the app for GitHub.
export interface PrStatus {
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
export interface PrConversationItem {
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

// Splits a GitHub PR URL (https://github.com/OWNER/REPO/pull/N) into its
// parts, so the line-comment REST call (which gh's `pr view --json` can't
// return) can address the right repo/PR. Returns null for anything that isn't
// a recognizable PR URL, so a caller degrades to "no line comments" rather
// than throwing on a malformed stored URL.
export function parsePrUrl(
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
    const verdict = String(check.conclusion ?? check.state ?? '').toUpperCase();
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
      { appendActivity: `${now} run ${runId} opened PR: ${url}` },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
    return this.ctx.orchestrator.setRunPrUrl(runId, url);
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
  // read live from GitHub via gh. The status (state, checks, review verdict,
  // diffstat) comes from one `gh pr view --json` call; the conversation folds
  // together submitted reviews, PR-level comments, and — via a REST call gh's
  // `pr view` can't cover — code-line comments, all sorted oldest-first.
  async getPrDetail(runId: string): Promise<PrDetail> {
    const meta = this.requireRunWithPr(runId);
    const url = meta.prUrl!;
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
      url: String(raw.url ?? url),
      title: String(raw.title ?? meta.taskTitle),
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
        const state = String(r.state ?? '').toUpperCase();
        const body = String(r.body ?? '');
        if (state === 'PENDING' || (state === '' && body === '')) continue;
        conversation.push({
          kind: 'review',
          author: authorLogin(r.author),
          body,
          createdAt: String(r.submittedAt ?? r.createdAt ?? ''),
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
          body: String(c.body ?? ''),
          createdAt: String(c.createdAt ?? ''),
        });
      }
    }
    // Code-line comments come from the REST API, not `pr view` — best-effort,
    // so a permissions/parse hiccup just drops the line comments rather than
    // failing the whole status read.
    const location = parsePrUrl(url);
    if (location !== null) {
      const rest = await this.run(this.ctx.rootDir, [
        'gh',
        'api',
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
              body: String(c.body ?? ''),
              createdAt: String(c.created_at ?? ''),
              path: c.path !== undefined ? String(c.path) : undefined,
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

  // POST /api/runs/:id/pr/review. Submits a GitHub review on the run's PR —
  // approve (body optional), request-changes, or comment (both require a
  // body, enforced by the API layer). Returns the refreshed PrDetail so the
  // client re-renders with the new verdict/conversation in one round trip.
  async reviewPr(
    runId: string,
    event: PrReviewEvent,
    body: string
  ): Promise<PrDetail> {
    const meta = this.requireRunWithPr(runId);
    const flag =
      event === 'approve'
        ? '--approve'
        : event === 'request-changes'
          ? '--request-changes'
          : '--comment';
    const cmd = ['gh', 'pr', 'review', meta.prUrl!, flag];
    if (body.trim() !== '') cmd.push('--body', body);
    const result = await this.run(this.ctx.rootDir, cmd);
    if (!result.ok) {
      throw new OrchestratorConflictError(
        `gh pr review failed: ${commandErrorText(result)}`
      );
    }
    return this.getPrDetail(runId);
  }

  // POST /api/runs/:id/pr/comment. Adds a PR-level comment (not a review) via
  // `gh pr comment`, then returns the refreshed detail.
  async commentPr(runId: string, body: string): Promise<PrDetail> {
    const meta = this.requireRunWithPr(runId);
    const result = await this.run(this.ctx.rootDir, [
      'gh',
      'pr',
      'comment',
      meta.prUrl!,
      '--body',
      body,
    ]);
    if (!result.ok) {
      throw new OrchestratorConflictError(
        `gh pr comment failed: ${commandErrorText(result)}`
      );
    }
    return this.getPrDetail(runId);
  }
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
