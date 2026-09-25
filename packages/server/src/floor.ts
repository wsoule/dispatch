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

/** The command floor's members in plain words, for messages that name them. */
export const FLOOR_COMMAND_ACTIONS =
  'a force-push, a publish, a repo-settings change or a remote ref deletion';

// Each pattern scopes its scan to one shell segment (up to `|`, `;`, `&` or a
// newline) so a marker in a later, unrelated command does not attach to an
// innocent leading one. GAP is the stretch of one segment between two parts
// of a pattern; it is lazy so a scan stops at the earliest next part.
// SEGMENT_START is where a segment begins: the start of the command, or just
// after a delimiter.
const GAP = '[^|;&\\n]*?';
const SEGMENT_START = '(?:^|[|;&\\n])';

/**
 * A pattern for `first … middles … last` within one shell segment, built to
 * run in time linear in the command's length.
 *
 * The plain form, `first[^|;&\n]*middle[^|;&\n]*last`, backtracks over every
 * pairing of `first` and `middle` occurrences in a segment: cubic time, and
 * this runs on the daemon's event loop for every tool call. A 20 KB one-line
 * command that merely mentioned "git" and "push" many times took about a
 * minute. These changes keep exactly the same matches without that:
 *
 * - A match is only attempted from the start of a segment, and `first` and
 *   each middle part commit to their earliest occurrence after it: a later
 *   occurrence can only reach a subset of what the earliest reaches. A
 *   lookahead's capture replayed by a backreference is JavaScript's stand-in
 *   for an atomic group, so the engine cannot backtrack into later
 *   occurrences. (Anchoring at segment starts rather than ruling out later
 *   `first`s with a lookbehind also keeps JavaScriptCore on its regex JIT.)
 * - A middle part must not be able to match a segment delimiter, or a later
 *   occurrence could reach a segment the earliest one cannot.
 * - `last` is only looked for, from the end of the last middle part. Its
 *   source is the lookahead body, so it states its own gap: inSegment().
 *
 * test/floor.test.ts checks these against the plain form on generated
 * commands, and times them on the inputs that stalled the plain form.
 */
function segmentChain(
  first: string,
  middles: readonly string[],
  last: string
): RegExp {
  let source = SEGMENT_START;
  [first, ...middles].forEach((part, i) => {
    source += `(?=(${GAP}${part}))\\${String(i + 1)}`;
  });
  return new RegExp(`${source}(?=${last})`);
}

// `last` found anywhere from the current point to the end of the segment. An
// alternative is tried at every point of the segment, so each has to cost
// constant time there, or time bounded by the run of non-space characters
// after a space (runs after different spaces never overlap).
function inSegment(alternatives: string): string {
  return `${GAP}(?:${alternatives})`;
}

const GIT = '\\bgit\\b';
const PUSH = '\\bpush\\b';
const GH = '\\bgh\\b';

// `git push` carrying --force, --force-with-lease, a short -f (alone or
// bundled), or a `+refspec`: every spelling git accepts for "overwrite the
// remote ref". The merge queue's own --force-with-lease on a run's PR branch
// is not a tool call and never reaches these detectors. The bundled-flag
// test is `-` then a run of letters holding an `f` and ending at a word
// boundary, checked with a lookahead so a long run of letters costs linear
// rather than quadratic time.
const FORCE_PUSH = segmentChain(
  GIT,
  [PUSH],
  inSegment(
    '--force(?:-with-lease)?(?![\\w-])|\\s-(?=[a-zA-Z]*f)[a-zA-Z]+\\b|\\s\\+\\S+'
  )
);

// `git push` deleting a remote ref: `--delete`, `-d`, or the empty-source
// refspec `:branch`. A ref the run does not own is outside its declared
// writes by definition.
const REMOTE_REF_DELETE = segmentChain(
  GIT,
  [PUSH],
  inSegment('--delete\\b|\\s-d\\b|\\s:\\S+')
);

// A package manager invoking publish (or unpublish, strictly more
// destructive). The lookahead keeps script names like `publish-check` out.
const REGISTRY_PUBLISH = segmentChain(
  '\\b(?:npm|pnpm|yarn|bun|npx|cargo)\\b',
  [],
  inSegment('\\s(?:un)?publish(?![\\w-])')
);

// A tag push is this repo's release trigger (release.yml builds on v*), so
// pushing tags is publishing under a different spelling: `--tags`,
// `--follow-tags`, an explicit `refs/tags/` refspec (pushesTagRefspec below),
// or a bare `vN[.N...]` ref. `gh release create/upload` publishes a release
// directly.
const TAG_PUSH = segmentChain(
  GIT,
  [PUSH],
  inSegment(
    '--tags(?![\\w-])|--follow-tags(?![\\w-])|\\s(?:\\S+:)?v\\d+(?:\\.\\d+)*(?=\\s|$)'
  )
);
const GH_RELEASE = segmentChain(
  GH,
  ['\\brelease\\b'],
  inSegment('\\b(?:create|upload)\\b')
);

// The end of each segment's first `git … push`, one match per segment.
const GIT_PUSH_ENDS = new RegExp(
  `${SEGMENT_START}(?=(${GAP}${GIT}))\\1(?=(${GAP}${PUSH}))\\2`,
  'g'
);
const DELIMITER = /[|;&\n]/g;
const WHITESPACE = /\s/g;

// Every index at which `pattern` (a global regex) matches in `text`, ascending.
function matchIndexes(text: string, pattern: RegExp): number[] {
  const indexes: number[] = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    indexes.push(m.index);
    if (m[0] === '') pattern.lastIndex += 1;
  }
  return indexes;
}

// The first entry of an ascending list at or after `from`, or -1.
function firstAtOrAfter(sorted: readonly number[], from: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] < from) low = mid + 1;
    else high = mid;
  }
  return low < sorted.length ? sorted[low] : -1;
}

/**
 * Whether a `git … push` pushes an explicit `refs/tags/` refspec: the plain
 * pattern `git[^|;&\n]*push[^|;&\n]*\S*refs/tags/`, decided in linear time.
 *
 * That pattern matches when, after the push word, `refs/tags/` starts either
 * inside the segment or past its end with no whitespace in between (`\S`
 * covers `;`, `|` and `&`, so the refspec's run of non-space characters may
 * start in this segment and cross into the next). As a regex it rescans the
 * whole of such a run once for every segment inside it, which made a 100 KB
 * `git.push;git.push;…` take 12 s. Precomputing where `refs/tags/` and the
 * whitespace sit turns each segment's question into two binary searches.
 */
function pushesTagRefspec(command: string): boolean {
  if (!command.includes('refs/tags/')) return false;
  let tags: number[] | null = null;
  let spaces: number[] | null = null;
  GIT_PUSH_ENDS.lastIndex = 0;
  for (
    let m = GIT_PUSH_ENDS.exec(command);
    m !== null;
    m = GIT_PUSH_ENDS.exec(command)
  ) {
    const pushEnd = m.index + m[0].length;
    DELIMITER.lastIndex = pushEnd;
    const segmentEnd = DELIMITER.exec(command)?.index ?? command.length;
    tags ??= matchIndexes(command, /refs\/tags\//g);
    const tag = firstAtOrAfter(tags, pushEnd);
    if (tag === -1) return false;
    if (tag < segmentEnd) return true;
    // Past the segment's end, the run must not break before the refspec: a
    // newline ends it at once, other whitespace wherever it falls.
    if (segmentEnd < command.length && command[segmentEnd] !== '\n') {
      spaces ??= matchIndexes(command, WHITESPACE);
      const space = firstAtOrAfter(spaces, segmentEnd);
      if (space === -1 || space > tag) return true;
    }
  }
  return false;
}

// `gh` touching a repository's settings: visibility (`gh repo edit
// --visibility`, `gh api -f visibility=`, `-f private=`), the default branch,
// or the repository itself (`gh repo delete`, `gh repo archive`, a DELETE
// against /repos/). The DELETE form is two patterns because `-X` and `DELETE`
// may be split by a newline, and a middle part must not cross one: once on
// the same line, and once across the newline that ends the `-X` line.
const REPO_SETTINGS: readonly RegExp[] = [
  segmentChain(
    GH,
    [],
    inSegment('\\bvisibility\\b|\\bdefault[-_]branch\\b|\\bprivate=')
  ),
  segmentChain(GH, ['\\brepo\\b'], inSegment('\\b(?:delete|archive)\\b')),
  segmentChain(GH, ['-X[^\\S\\n]+DELETE'], inSegment('/repos/')),
  segmentChain(GH, ['-X[^\\S\\n]*\\n\\s*DELETE'], inSegment('/repos/')),
];

// Order matters only when one command trips several checks; the first match
// names the hold, and any match blocks.
const COMMAND_CHECKS: readonly {
  check: FloorCheck;
  matches: (command: string) => boolean;
}[] = [
  { check: 'force-push', matches: (c) => FORCE_PUSH.test(c) },
  { check: 'publish', matches: (c) => REGISTRY_PUBLISH.test(c) },
  {
    check: 'publish',
    matches: (c) => TAG_PUSH.test(c) || pushesTagRefspec(c),
  },
  { check: 'publish', matches: (c) => GH_RELEASE.test(c) },
  {
    check: 'repo-settings',
    matches: (c) => REPO_SETTINGS.some((pattern) => pattern.test(c)),
  },
  { check: 'delete-outside-writes', matches: (c) => REMOTE_REF_DELETE.test(c) },
];

/** The floor check a shell command trips, or null when it trips none. */
export function floorCheckForCommand(command: string): FloorCheck | null {
  for (const { check, matches } of COMMAND_CHECKS) {
    if (matches(command)) return check;
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
