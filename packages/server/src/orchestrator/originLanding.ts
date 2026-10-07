import { OriginWriter } from '../git/originWriter.js';
import type { Orchestrator } from './orchestrator.js';
import type { CommandResult, CommandRunner } from './pr.js';
import type { RunMeta } from './types.js';
import { MergeEnvironmentError, OrchestratorConflictError } from './types.js';
import type { DiffResult, FollowResult } from './worktree.js';

// How many times a landing recomputes and re-pushes after origin moved under
// it. Each retry is a fetch, an in-memory merge and a push, so this only has
// to outlast a short burst of other pushes. A branch busier than that fails
// the landing with a reason instead of spinning.
const MAX_PUSH_ATTEMPTS = 3;

// git's wording for "origin moved since you fetched": a non-fast-forward
// rejection, or a ref that changed between the remote's read and its write.
const STALE_PUSH =
  /non-fast-forward|fetch first|\(stale info\)|cannot lock ref/i;

// git's wording for "could not talk to origin at all". Offline, DNS, a locked
// SSH agent and an expired credential all look like this, and all clear on
// their own or with a human's unlock. None of them means the landing itself
// is wrong.
const UNREACHABLE =
  /could not resolve host|unable to access|could not read from remote|connection (refused|timed out|reset|closed)|network is unreachable|timed out/i;

function outputOf(result: CommandResult): string {
  return [result.stderr.trim(), result.stdout.trim()]
    .filter((s) => s.length > 0)
    .join(' | ');
}

/**
 * Turns a failed fetch or push into the error the caller should see.
 *
 * An unreachable origin becomes a MergeEnvironmentError. The merge queue holds
 * the entry and retries it, exactly as it does for a dirty main checkout.
 * Falling back to a local merge instead would recreate the "merged locally,
 * not on origin" split this path exists to remove. Anything else (a protected
 * branch, a hook rejecting the push) is a conflict carrying git's reason: a
 * 409 the person can act on through the API, a failed entry in the queue.
 */
function landingError(
  step: 'fetch' | 'push',
  base: string,
  result: CommandResult
): OrchestratorConflictError {
  const text = outputOf(result);
  if (UNREACHABLE.test(text)) {
    return new MergeEnvironmentError(
      `origin is unreachable, so nothing was merged — git ${step} failed: ${text}`
    );
  }
  if (step === 'push') {
    return new OrchestratorConflictError(
      `origin refused the push to ${base} (if the branch requires pull requests, land this run as a PR): ${text}`
    );
  }
  return new OrchestratorConflictError(
    `git fetch origin ${base} failed: ${text}`
  );
}

export interface OriginLanderDeps {
  rootDir: string;
  orchestrator: Orchestrator;
  /** Every fetch, rev-parse and push goes through here, so tests and DISPATCH_FAKE_GH control the network. */
  run: CommandRunner;
  /** Shared with the board syncer in production. See OriginWriter. */
  writer?: OriginWriter;
}

/** The outcome of one landing, for callers that report where work went. */
export interface OriginLanding {
  run: RunMeta;
  /** The sha now on origin's base, or undefined when there was nothing to push. */
  mergeCommit: string | undefined;
  /** Whether the local base branch caught up with origin afterwards. */
  follow: FollowResult;
}

/**
 * Lands a reviewed run on origin's base branch, then lets the local checkout
 * follow.
 *
 * The order is the point. The old path squash-merged into the main checkout
 * and pushed later, which made the local checkout the source of truth. A dirty
 * checkout or the wrong branch blocked the merge, and a failed push left work
 * merged locally but missing on origin with nothing saying so. Here:
 *
 * 1. Under the shared OriginWriter: fetch origin's base, build the squash
 *    commit on its tip with plumbing (no checkout is touched), and push that
 *    commit to the base WITHOUT force. The remote's fast-forward check is the
 *    compare-and-swap. If another push landed first, the push is rejected,
 *    and this refetches and rebuilds on the new tip (bounded).
 * 2. Record the run as merged, with the pushed sha as its merge commit.
 * 3. Fast-forward the local base to origin. A checkout that can't take it
 *    stays behind, which is harmless; it never blocks or undoes step 1.
 *
 * Only for runs Orchestrator.landsOnOrigin selects. A project with no remote
 * keeps the local merge.
 */
export class OriginLander {
  readonly writer: OriginWriter;

  constructor(private readonly deps: OriginLanderDeps) {
    this.writer = deps.writer ?? new OriginWriter();
  }

  async land(
    runId: string,
    opts: { actor?: string } = {}
  ): Promise<OriginLanding> {
    const { orchestrator } = this.deps;
    const actor = opts.actor ?? orchestrator.defaultReviewActor();
    // Refusals first and outside the failure record, same as review(): a run
    // that was never attempted has no failed attempt to report.
    const meta = orchestrator.requireReviewable(runId, 'merge');
    let landed: { commit: string | undefined; diff: DiffResult };
    try {
      landed = await this.writer.exclusive(() => this.pushLanding(meta));
    } catch (err) {
      orchestrator.recordOriginLandingFailure(runId, err, actor);
      throw err;
    }
    const run = orchestrator.completeOriginLanding(
      runId,
      landed.commit,
      landed.diff,
      actor
    );
    const follow = this.follow(meta.baseBranch);
    return { run, mergeCommit: landed.commit, follow };
  }

  // Step 1, run while holding the writer. Returns the commit origin now has
  // (or undefined when the run had nothing to add) plus the diff to snapshot.
  private async pushLanding(
    meta: RunMeta
  ): Promise<{ commit: string | undefined; diff: DiffResult }> {
    const { rootDir, run, orchestrator } = this.deps;
    const base = meta.baseBranch;
    for (let attempt = 1; ; attempt++) {
      const fetch = await run(rootDir, ['git', 'fetch', 'origin', base]);
      if (!fetch.ok) throw landingError('fetch', base, fetch);
      const tip = await run(rootDir, [
        'git',
        'rev-parse',
        '--verify',
        `refs/remotes/origin/${base}^{commit}`,
      ]);
      const tipSha = tip.stdout.trim();
      if (!tip.ok || tipSha === '') {
        throw new OrchestratorConflictError(
          `origin has no ${base} branch to land on`
        );
      }
      const prepared = orchestrator.prepareOriginLanding(meta.id, tipSha);
      if (prepared.commit === undefined) return prepared;
      const push = await run(rootDir, [
        'git',
        'push',
        'origin',
        `${prepared.commit}:refs/heads/${base}`,
      ]);
      if (push.ok) return prepared;
      if (!STALE_PUSH.test(outputOf(push))) {
        throw landingError('push', base, push);
      }
      // Origin moved under us. The retry rebuilds the squash on the new tip,
      // so what lands was not itself verified on that tip — the same window
      // a PR merge has. A content conflict there still refuses (merge-tree).
      if (attempt >= MAX_PUSH_ATTEMPTS) {
        throw new OrchestratorConflictError(
          `origin/${base} kept moving during the landing (${MAX_PUSH_ATTEMPTS} attempts rejected) — retry once it settles`
        );
      }
    }
  }

  // Step 3. Never throws: the work is already on origin, and a local checkout
  // that can't catch up must not make a successful landing look failed.
  private follow(base: string): FollowResult {
    try {
      const result = this.deps.orchestrator.followOrigin(base);
      if (result.outcome === 'behind') {
        console.error(
          `dispatchd: landed on origin/${base}, but the local ${base} could not fast-forward and stays behind: ${result.reason}`
        );
      }
      return result;
    } catch (err) {
      const reason = (err as Error).message;
      console.error(
        `dispatchd: landed on origin/${base}, but following it locally failed: ${reason}`
      );
      return { outcome: 'behind', reason };
    }
  }
}
