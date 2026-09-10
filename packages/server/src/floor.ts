import type { FloorCheck } from '@dispatch/core';
import { isAbsolute, normalize } from 'node:path/posix';

import { matchesDeclaredWrites } from './orchestrator/review.js';
import type { RunMeta } from './orchestrator/types.js';

/**
 * The server half of the irreversibility floor (core/policy.ts holds the
 * membership table): the detectors that recognize a floor action at the
 * daemon's choke points. Every floor pattern lives here and nowhere else, so
 * the floor stays one reviewable list:
 *
 * - Commands an agent runs (force-push, publish, repo settings, remote ref
 *   deletion) are caught at the executor's permission callback and again when
 *   the parked approval reaches the decision feed.
 * - States of a run (a diff deleting outside the declared writes, a spend
 *   that hit the cap) are caught where the policy engine would otherwise
 *   auto-decide, and in the feed's stalled-run items.
 * - A capped fix loop is a floor item by kind — see decisionFeed.ts.
 *
 * Detection is deliberately conservative in the blocking direction: a
 * `--dry-run` publish, a force-push mentioned inside a quoted string, or a
 * branch named like a version tag still parks for a human. The floor's
 * failure mode must be a needless question, never a silent irreversible act.
 */

// Each pattern scopes its scan to one shell segment (up to `|`, `;`, `&` or a
// newline) so a marker in a later, unrelated command does not attach to an
// innocent leading one.
const SEGMENT = '[^|;&\\n]*';

// `git push` carrying --force, --force-with-lease, a short -f (alone or
// bundled), or a `+refspec` — every spelling git accepts for "overwrite the
// remote ref". The merge queue's own --force-with-lease on a run's PR branch
// is not a tool call and never reaches these detectors.
const FORCE_PUSH = new RegExp(
  `\\bgit\\b${SEGMENT}\\bpush\\b${SEGMENT}(?:--force(?:-with-lease)?(?![\\w-])|\\s-[a-zA-Z]*f[a-zA-Z]*\\b|\\s\\+\\S+)`
);

// `git push` deleting a remote ref: `--delete`, `-d`, or the empty-source
// refspec `:branch`. A ref the run does not own is outside its declared
// writes by definition.
const REMOTE_REF_DELETE = new RegExp(
  `\\bgit\\b${SEGMENT}\\bpush\\b${SEGMENT}(?:--delete\\b|\\s-d\\b|\\s:\\S+)`
);

// A package manager invoking publish (or unpublish, strictly more
// destructive). The lookahead keeps script names like `publish-check` out.
const REGISTRY_PUBLISH =
  /\b(?:npm|pnpm|yarn|bun|npx|cargo)\b[^|;&\n]*\s(?:un)?publish(?![\w-])/;

// A tag push is this repo's release trigger (release.yml builds on v*), so
// pushing tags is publishing under a different spelling: `--tags`,
// `--follow-tags`, an explicit `refs/tags/` refspec, or a bare `vN[.N...]`
// ref. `gh release create/upload` publishes a release directly.
const TAG_PUSH = new RegExp(
  `\\bgit\\b${SEGMENT}\\bpush\\b${SEGMENT}(?:--tags(?![\\w-])|--follow-tags(?![\\w-])|\\S*refs/tags/|\\s(?:\\S+:)?v\\d+(?:\\.\\d+)*(?=\\s|$))`
);
const GH_RELEASE = /\bgh\b[^|;&\n]*\brelease\b[^|;&\n]*\b(?:create|upload)\b/;

// `gh` touching a repository's settings: visibility (`gh repo edit
// --visibility`, `gh api -f visibility=`, `-f private=`), the default branch,
// or the repository itself (`gh repo delete`, `gh repo archive`, a DELETE
// against /repos/).
const REPO_SETTINGS = new RegExp(
  `\\bgh\\b${SEGMENT}(?:\\bvisibility\\b|\\bdefault[-_]branch\\b|\\bprivate=|\\brepo\\b${SEGMENT}\\b(?:delete|archive)\\b|-X\\s+DELETE${SEGMENT}/repos/)`
);

// Order matters only when one command trips several patterns; the first
// match names the hold, and any match blocks.
const COMMAND_CHECKS: readonly { check: FloorCheck; pattern: RegExp }[] = [
  { check: 'force-push', pattern: FORCE_PUSH },
  { check: 'publish', pattern: REGISTRY_PUBLISH },
  { check: 'publish', pattern: TAG_PUSH },
  { check: 'publish', pattern: GH_RELEASE },
  { check: 'repo-settings', pattern: REPO_SETTINGS },
  { check: 'delete-outside-writes', pattern: REMOTE_REF_DELETE },
];

/** The floor check a shell command trips, or null when it trips none. */
export function floorCheckForCommand(command: string): FloorCheck | null {
  for (const { check, pattern } of COMMAND_CHECKS) {
    if (pattern.test(command)) return check;
  }
  return null;
}

/**
 * The floor check a tool call's input trips. Recognizes any tool whose input
 * carries a `command` string (Bash and its variants), so a renamed shell tool
 * is still covered as long as it takes a command.
 */
export function floorCheckForToolInput(input: unknown): FloorCheck | null {
  if (typeof input !== 'object' || input === null) return null;
  const { command } = input as { command?: unknown };
  if (typeof command !== 'string') return null;
  return floorCheckForCommand(command);
}

/**
 * Paths in a scope request the policy may never auto-grant: anything absolute,
 * anything that climbs above the project root, and anything under `.git/`.
 * A fence extension into another repo or into git's own store can rewrite
 * refs and history, so it waits for a human at every rung (the rung-2
 * constraint in docs/design/autonomy-ladder.md). Windows separators are
 * normalized first so `..\\` escapes are not missed.
 */
export function scopeRequestEscapesRepo(paths: string[]): string[] {
  return paths.filter((path) => {
    const normalized = normalize(path.replaceAll('\\', '/'));
    if (isAbsolute(normalized)) return true;
    const segments = normalized.split('/');
    return segments[0] === '..' || segments.includes('.git');
  });
}

/**
 * Files a run's diff DELETES that no declared `writes` glob covers — the
 * floor's delete-outside-writes member, evaluated where auto-merge would
 * otherwise enqueue. Only a status git reports as `D` counts; a rename keeps
 * the content and is left to the ordinary undeclared-writes review finding.
 * `.dispatch/` bookkeeping is exempt for the same reason undeclaredWrites
 * exempts it: it is dispatch's own writing, not agent work product.
 */
export function deletesOutsideDeclaredWrites(
  writes: string[],
  files: { path: string; status: string }[]
): string[] {
  return files
    .filter(
      (file) =>
        file.status.startsWith('D') &&
        !file.path.startsWith('.dispatch/') &&
        !matchesDeclaredWrites(writes, file.path)
    )
    .map((file) => file.path);
}

/**
 * Whether a run's failure means it hit its cost budget — the floor's
 * budget-cap member. Matches the executor's own truncation message (see
 * BUDGET_EXHAUSTED_MESSAGE in executors/claude.ts, shared so the two cannot
 * drift) and the SDK's raw `error_max_budget_usd` subtype, which reaches
 * `RunMeta.error` verbatim when the SDK reports no message of its own.
 */
export function isBudgetCapFailure(error: string | undefined): boolean {
  if (error === undefined) return false;
  return (
    error.includes('hit its cost budget') ||
    error.includes('error_max_budget_usd')
  );
}

/**
 * A task's runs that died on their cost cap and nobody has dealt with: not
 * reviewed, not archived, not resumed. While one exists, every path that
 * would spend on the task's behalf (fix-loop ignition, verification retry)
 * holds — spending past the cap is a human's call at every rung. A resume is
 * that call: the resumed run is superseded, so the hold lifts with it.
 */
export function budgetCapHolds(runs: RunMeta[], taskId: string): RunMeta[] {
  const superseded = new Set<string>();
  for (const run of runs) {
    if (run.resumedFrom !== undefined) superseded.add(run.resumedFrom);
  }
  return runs.filter(
    (run) =>
      run.taskId === taskId &&
      run.state === 'failed' &&
      isBudgetCapFailure(run.error) &&
      run.reviewedAt === undefined &&
      run.archivedAt === undefined &&
      !superseded.has(run.id)
  );
}
