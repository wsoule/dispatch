import type { FloorCheck } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';

import {
  budgetCapHolds,
  deletesOutsideDeclaredWrites,
  floorCheckForCommand,
  floorCheckForToolInput,
  isBudgetCapFailure,
  scopeRequestEscapesRepo,
} from '../src/floor.js';
import { BUDGET_EXHAUSTED_MESSAGE } from '../src/orchestrator/executors/claude.js';
import type { RunMeta, RunState } from '../src/orchestrator/types.js';

function runMeta(id: string, patch: Partial<RunMeta> = {}): RunMeta {
  return {
    id,
    taskId: 't-000001',
    taskTitle: `Task ${id}`,
    executor: 'fake',
    state: 'failed' as RunState,
    branch: `dispatch/${id}`,
    baseBranch: 'main',
    worktreePath: `/tmp/${id}`,
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
    error: BUDGET_EXHAUSTED_MESSAGE,
    ...patch,
  };
}

describe('floorCheckForCommand', () => {
  it('recognizes every spelling of a force-push', () => {
    for (const command of [
      'git push --force origin main',
      'git push origin main --force',
      'git push --force-with-lease origin feature',
      'git push -f',
      'git push -uf origin main',
      'git push origin +main',
      'cd repo && git push --force',
      'git fetch && git push -f origin HEAD:main',
    ]) {
      expect(floorCheckForCommand(command)).toBe('force-push');
    }
  });

  it('recognizes publishing: registry publish, tag pushes, gh releases', () => {
    for (const command of [
      'npm publish',
      'npm publish --dry-run',
      'pnpm publish --access public',
      'pnpm -r publish',
      'yarn npm publish',
      'bun publish',
      'npx lerna publish',
      'npm unpublish @dispatch/core@1.0.0',
      'cargo publish',
      'git push --tags',
      'git push origin --follow-tags',
      'git push origin v1.2.3',
      'git push origin refs/tags/v1.2.3',
      'git push origin HEAD:refs/tags/v2',
      'git push origin main v0.4.0',
      'gh release create v1.2.3 --generate-notes',
      'gh release upload v1.2.3 dist/app.dmg',
    ]) {
      expect(floorCheckForCommand(command)).toBe('publish');
    }
  });

  it('recognizes repository visibility and remote settings changes', () => {
    for (const command of [
      'gh repo edit --visibility public --accept-visibility-change-consequences',
      'gh api -X PATCH /repos/o/r -f visibility=private',
      'gh api -X PATCH repos/o/r -f private=true',
      'gh repo edit --default-branch develop',
      'gh api -X PATCH /repos/o/r -f default_branch=develop',
      'gh repo delete o/r --yes',
      'gh repo archive o/r',
      'gh api -X DELETE /repos/o/r',
    ]) {
      expect(floorCheckForCommand(command)).toBe('repo-settings');
    }
  });

  it('recognizes remote ref deletion as a delete outside the declared writes', () => {
    for (const command of [
      'git push origin --delete feature',
      'git push -d origin feature',
      'git push origin :feature',
    ]) {
      expect(floorCheckForCommand(command)).toBe('delete-outside-writes');
    }
  });

  it('lets ordinary commands through, including near-misses', () => {
    for (const command of [
      'git push',
      'git push -u origin feature',
      'git push origin HEAD:main',
      'git push --follow-tags-not-really',
      'git push origin v2-migration',
      'git push origin feature/v2',
      'npm run publish-check',
      'pnpm run prepublishOnly',
      'echo "git push --force" > notes.txt | cat',
      'gh pr create --fill',
      'gh repo view',
      'gh repo create o/r --private',
      'gh api /repos/o/r',
      'git branch -D feature',
      'rm -rf node_modules',
    ]) {
      // The quoted-string case is a deliberate exception: it is on the line
      // before the `|`, so the segment scan does catch it.
      if (command.startsWith('echo')) {
        expect(floorCheckForCommand(command)).toBe('force-push');
        continue;
      }
      expect(floorCheckForCommand(command)).toBeNull();
    }
  });

  it('scans each shell segment on its own', () => {
    // The --force belongs to a later, unrelated command: still a hold,
    // because that later command is a force-push.
    expect(floorCheckForCommand('git status; git push --force')).toBe(
      'force-push'
    );
    // A publish marker in a following segment does not attach to git push.
    expect(
      floorCheckForCommand('git push origin main; npm run publish-check')
    ).toBeNull();
  });
});

// The detectors as they stood before the linear-time rewrite, kept verbatim as
// the oracle the current ones must agree with. They backtrack in cubic time,
// so they only ever see short commands here.
const LEGACY_SEGMENT = '[^|;&\\n]*';
const LEGACY_CHECKS: readonly [FloorCheck, RegExp][] = [
  [
    'force-push',
    new RegExp(
      `\\bgit\\b${LEGACY_SEGMENT}\\bpush\\b${LEGACY_SEGMENT}(?:--force(?:-with-lease)?(?![\\w-])|\\s-[a-zA-Z]*f[a-zA-Z]*\\b|\\s\\+\\S+)`
    ),
  ],
  [
    'publish',
    /\b(?:npm|pnpm|yarn|bun|npx|cargo)\b[^|;&\n]*\s(?:un)?publish(?![\w-])/,
  ],
  [
    'publish',
    new RegExp(
      `\\bgit\\b${LEGACY_SEGMENT}\\bpush\\b${LEGACY_SEGMENT}(?:--tags(?![\\w-])|--follow-tags(?![\\w-])|\\S*refs/tags/|\\s(?:\\S+:)?v\\d+(?:\\.\\d+)*(?=\\s|$))`
    ),
  ],
  ['publish', /\bgh\b[^|;&\n]*\brelease\b[^|;&\n]*\b(?:create|upload)\b/],
  [
    'repo-settings',
    new RegExp(
      `\\bgh\\b${LEGACY_SEGMENT}(?:\\bvisibility\\b|\\bdefault[-_]branch\\b|\\bprivate=|\\brepo\\b${LEGACY_SEGMENT}\\b(?:delete|archive)\\b|-X\\s+DELETE${LEGACY_SEGMENT}/repos/)`
    ),
  ],
  [
    'delete-outside-writes',
    new RegExp(
      `\\bgit\\b${LEGACY_SEGMENT}\\bpush\\b${LEGACY_SEGMENT}(?:--delete\\b|\\s-d\\b|\\s:\\S+)`
    ),
  ],
];

function legacyFloorCheck(command: string): FloorCheck | null {
  for (const [check, pattern] of LEGACY_CHECKS) {
    if (pattern.test(command)) return check;
  }
  return null;
}

// Commands built mostly around near-complete floor patterns (`git … push …
// flag`, `gh … -X … DELETE …`), with noise, delimiters and newlines dropped
// in at random points, so the segment boundaries are what gets exercised.
function* generatedCommands(count: number): Generator<string> {
  const tokens = [
    'git',
    'push',
    'gh',
    'repo',
    'release',
    '-X',
    'DELETE',
    '/repos/',
    'npm',
    'publish',
    '--force',
    '-f',
    '-fu1',
    '+main',
    '--delete',
    '-d',
    ':feat',
    '--tags',
    'refs/tags/',
    'x:v2.3',
    'v1.2',
    'git-lfs',
    'origin',
    'a',
    '1',
    '"',
    '-',
  ];
  const separators = [
    ' ',
    ' ',
    ' ',
    '',
    '.',
    '\n',
    '\t',
    ';',
    '|',
    '&',
    '&&',
    ' \n ',
  ];
  const chains = [
    ['git', 'push'],
    ['gh', 'release'],
    ['gh', 'repo'],
    ['gh', '-X'],
    ['gh'],
    ['npm'],
    ['pnpm', '-r'],
    ['cargo'],
  ];
  const markers = [
    '--force',
    '--force-with-lease',
    '-f',
    '-uf',
    '-fu1',
    '+main',
    '--delete',
    '-d',
    ':feat',
    '--tags',
    '--follow-tags',
    'x:refs/tags/v1',
    'v1.2.3',
    'x:v2.3',
    'v1x',
    'create',
    'upload',
    'delete',
    'archive',
    'visibility',
    'default_branch',
    'private=',
    'DELETE /repos/o',
    'DELETE',
    '/repos/x',
    'publish',
    'unpublish',
    'publish-check',
  ];
  // mulberry32 from a fixed seed, so a failure names a reproducible case.
  // (Math.imul keeps the multiply in 32 bits; a plain `*` loses the low bits
  // to floating point and the sequence collapses into short cycles.)
  let seed = 7;
  const pick = <T>(list: readonly T[]): T => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return list[Math.floor(unit * list.length)];
  };
  const noise = (): string => {
    let text = '';
    for (let i = 0; i < pick([0, 1, 2, 3]); i++)
      text += pick(tokens) + pick(separators);
    return text;
  };
  for (let n = 0; n < count; n++) {
    let command = '';
    for (let r = 0; r < pick([1, 2, 3]); r++) {
      command += noise();
      for (const word of pick(chains))
        command += word + pick(separators) + noise();
      command += pick(markers) + pick(separators) + pick(['', pick(markers)]);
    }
    yield command;
  }
}

describe('floorCheckForCommand, rewritten for linear time', () => {
  it('agrees with the pre-rewrite detectors on generated commands', () => {
    const verdicts = new Map<string, number>();
    for (const command of generatedCommands(40_000)) {
      const expected = legacyFloorCheck(command);
      expect({ command, check: floorCheckForCommand(command) }).toEqual({
        command,
        check: expected,
      });
      verdicts.set(String(expected), (verdicts.get(String(expected)) ?? 0) + 1);
    }
    // The generator has to reach every kind of hold for the comparison to say
    // anything about it.
    for (const check of [
      'force-push',
      'publish',
      'repo-settings',
      'delete-outside-writes',
      'null',
    ]) {
      expect(verdicts.get(check) ?? 0).toBeGreaterThan(50);
    }
  });

  // Each of these took the pre-rewrite detectors (or a first rewrite) from
  // tens of milliseconds at 5 KB to seconds or minutes at this size; they now
  // take a few milliseconds, well under the bound on any machine. The
  // `git.push;` runs cross segment ends with no whitespace, which defeated a
  // regex form of the `refs/tags/` check; the plain script checks ordinary
  // input stays fast too.
  it('stays fast on long commands that stalled the old detectors', () => {
    for (const command of [
      'git.push;'.repeat(11_111),
      'git-push|'.repeat(11_111),
      'git.push&'.repeat(11_111) + 'refs/tags/x',
      'cd src && ls -la | grep ts; git status --short\nnpm run build\n'.repeat(
        1_700
      ),
      'git push '.repeat(12_000),
      'echo "' + 'git status and push later '.repeat(4_000) + '"',
      'git push -' + 'f'.repeat(100_000) + '1',
      'git push ' + 'a'.repeat(100_000),
      'gh ' + '-X DELETE '.repeat(10_000),
      'npm '.repeat(25_000),
    ]) {
      const started = performance.now();
      floorCheckForCommand(command);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

describe('floorCheckForToolInput', () => {
  it('reads the command of any shell-shaped tool input', () => {
    expect(floorCheckForToolInput({ command: 'npm publish' })).toBe('publish');
    expect(floorCheckForToolInput({ command: 'ls' })).toBeNull();
    expect(floorCheckForToolInput({ file_path: 'x.ts' })).toBeNull();
    expect(floorCheckForToolInput('npm publish')).toBeNull();
    expect(floorCheckForToolInput(null)).toBeNull();
  });
});

describe('scopeRequestEscapesRepo', () => {
  it('names paths outside the repo or inside .git, and only those', () => {
    expect(
      scopeRequestEscapesRepo([
        'packages/core/src/browser.ts',
        'docs/../README.md',
        '.github/workflows/ci.yml',
        '.gitignore',
        'src/.git-hooks/x',
      ])
    ).toEqual([]);
    expect(
      scopeRequestEscapesRepo([
        '.git/config',
        '.git',
        'packages/.git/HEAD',
        '../sibling/file.ts',
        'a/../../escape.ts',
        '/etc/hosts',
        '..\\sibling\\file.ts',
      ])
    ).toEqual([
      '.git/config',
      '.git',
      'packages/.git/HEAD',
      '../sibling/file.ts',
      'a/../../escape.ts',
      '/etc/hosts',
      '..\\sibling\\file.ts',
    ]);
  });
});

describe('deletesOutsideDeclaredWrites', () => {
  it('names deleted files no declared glob covers, and only those', () => {
    const files = [
      { path: 'packages/server/src/old.ts', status: 'D' },
      { path: 'packages/core/src/keep.ts', status: 'D' },
      { path: 'packages/core/src/edited.ts', status: 'M' },
      { path: 'packages/core/src/renamed.ts', status: 'R100' },
      { path: '.dispatch/tasks/t-1.md', status: 'D' },
    ];
    expect(
      deletesOutsideDeclaredWrites(['packages/server/src/**'], files)
    ).toEqual(['packages/core/src/keep.ts']);
    expect(deletesOutsideDeclaredWrites([], files)).toEqual([
      'packages/server/src/old.ts',
      'packages/core/src/keep.ts',
    ]);
  });
});

describe('budget-cap detection', () => {
  it("recognizes the executor's own message and the SDK's raw subtype", () => {
    expect(isBudgetCapFailure(BUDGET_EXHAUSTED_MESSAGE)).toBe(true);
    expect(isBudgetCapFailure('error_max_budget_usd')).toBe(true);
    expect(isBudgetCapFailure('run hit its turn limit')).toBe(false);
    expect(isBudgetCapFailure(undefined)).toBe(false);
  });

  it('holds on an unreviewed budget-exhausted run and lifts once a human acts', () => {
    const held = runMeta('r-1');
    expect(budgetCapHolds([held], 't-000001').map((r) => r.id)).toEqual([
      'r-1',
    ]);
    // Another task's run, a reviewed one, an archived one, a resumed one, and
    // a run that failed for any other reason: none hold.
    const runs = [
      runMeta('r-other', { taskId: 't-000002' }),
      runMeta('r-reviewed', { reviewedAt: '2026-09-03T13:00:00.000Z' }),
      runMeta('r-archived', { archivedAt: '2026-09-03T13:00:00.000Z' }),
      runMeta('r-resumed'),
      runMeta('r-resume', {
        state: 'running' as RunState,
        resumedFrom: 'r-resumed',
      }),
      runMeta('r-turns', { error: 'run hit its turn limit' }),
      runMeta('r-fine', { state: 'finished' as RunState, error: undefined }),
    ];
    expect(budgetCapHolds(runs, 't-000001')).toEqual([]);
  });
});
