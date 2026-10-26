import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Dispatch's own Gr8r code (the shell around @dispatch/ui and the adapters that feed it) and
// the two transitional sheets in this directory follow the design system's rules
// (packages/ui/README.md): no colour of their own (a hex literal lives only in
// packages/ui/src/styles/tokens.css), none of the retired pre-Gr8r token names, no removed
// focus outline (Gr8r's `:focus-visible` ring is the focus indicator), no uppercase (the
// `.eyebrow` class is the one uppercase voice), and no Tailwind utilities in Gr8r code (it is
// styled by CSS modules; Tailwind leaves with packages/ui-legacy). The planner had the same
// scan (apps/planner/test/gr8r-tokens.test.ts in Better-Tracker). The Gr8r code (GR8R_SCOPE,
// not the sheets) is also held to the Phase 7 ratchet: it imports neither the legacy library
// nor `cn`; every `var(--name)` it reads resolves to tokens.css, an app stylesheet other than
// the bridge and the Tailwind entry (legacy-bridge.css, tailwind.css), a property the file
// sets itself, or a runtime `--label-color-<hash>` property; and it never builds a name from
// the bridge's `--project-color-`, `--state-` or `--status-` families, nor any name from a
// template expression (`var(--${tone}-ink)`), which no static scan can resolve.

const srcDir = path.join(import.meta.dir, '..');

/** Dispatch's Gr8r code, named relative to src/: the ratchet. An entry with a .css, .ts or
    .tsx extension is one file and must exist; any other entry is a directory, scanned
    recursively for those extensions, and an absent one scans as empty (`shell` does not exist
    yet; it stays listed so the first shell file is covered the day it lands). Files that sit
    in directories the legacy views share (components/shell holds the Tailwind-styled palette
    and dialogs too, lib/ the reducers) are listed one by one. Every Phase 7 batch appends the
    files it converts; B16 replaces the list with a scan of all of src/. */
const GR8R_SCOPE: readonly string[] = [
  'shell',
  'adapters',
  'components/graph/GraphTooLarge.tsx',
  'components/graph/GraphTooLarge.module.css',
  'components/peek/PeekSlideOver.tsx',
  'components/peek/PeekSlideOver.module.css',
  'components/peek/PeekSlideOver.test.tsx',
  'components/peek/PersonPeek.tsx',
  'components/peek/OutsidePeek.tsx',
  'components/shell/CommandPalette.tsx',
  'components/shell/CommandPalette.test.tsx',
  'components/shell/DispatchShell.tsx',
  'components/shell/DispatchShell.module.css',
  'components/shell/Toasts.tsx',
  'components/shell/Toasts.test.tsx',
  'components/shell/toastContract.ts',
  'components/shell/toastContract.test.ts',
  'components/tasks/detail/TaskDrawer.tsx',
  'components/tasks/detail/TaskDrawer.module.css',
  'components/tasks/detail/TaskDrawer.test.tsx',
  'components/tasks/detail/taskDetailProps.module.css',
  'components/tasks/detail/useTaskDetail.ts',
  'components/tasks/detail/useTaskDetailProps.tsx',
  'components/tasks/page/TaskPageRail.tsx',
  'components/tasks/page/TaskPageView.tsx',
  'components/tasks/page/TaskPageView.module.css',
  'components/tasks/page/TaskPageView.test.tsx',
  'components/tasks/page/useTaskPageModel.ts',
  'components/timeline/TimelineBanners.tsx',
  'components/timeline/TimelineBanners.module.css',
  'components/timeline/TimelineBanners.test.tsx',
  'hooks/useHashRoute.ts',
  'hooks/usePlanning.ts',
  'lib/routes.ts',
  'lib/shellRoutes.ts',
  'lib/shortcutGroups.ts',
  'lib/shortcutGroups.test.ts',
  'lib/fanoutVerbs.ts',
  'lib/issueSearch.ts',
  'views/GraphView.tsx',
  'views/GraphView.module.css',
  'views/GraphView.test.tsx',
  'views/IssuesView.tsx',
  'views/IssuesView.module.css',
  'views/IssuesViewMenus.tsx',
  'views/IssuesViewTable.tsx',
  'views/ProjectsView.tsx',
  'views/ProjectsView.module.css',
  'views/ProjectsView.test.tsx',
  'views/TimelineView.tsx',
  'views/TimelineView.module.css',
  'views/TimelineView.test.tsx',
  'lib/format.ts',
  'lib/format.test.ts',
  'lib/taskDates.ts',
  'lib/taskDates.test.ts',
  'lib/feedState.ts',
  'lib/feedState.test.ts',
];

/** GR8R_SCOPE directory entries allowed to be absent. Every other directory entry must exist
    and hold at least one scanned file, so a misspelt or renamed entry fails instead of
    silently scanning nothing. `shell` is the one placeholder (see GR8R_SCOPE). */
const PENDING_DIRS: ReadonlySet<string> = new Set(['shell']);

/** True when a GR8R_SCOPE entry names one file (it carries a scanned extension) rather than a
    directory. */
function isFileEntry(entry: string): boolean {
  return /\.(css|tsx?)$/.test(entry);
}

/** The transitional sheets: the legacy alias layer and the host's global sheet. */
const SHEETS = ['legacy-bridge.css', 'global.css'].map((name) =>
  path.join(import.meta.dir, name)
);

/** The retired pre-Gr8r token names: a copy of `RETIRED` in
    packages/ui/test/contrast-helpers.ts. A test below keeps the copy in step with it; importing
    it would pull another package's test module into this app's typecheck. */
const RETIRED: readonly string[] = [
  '--paper',
  '--ink',
  '--background',
  '--foreground',
  '--muted',
  '--ink-soft',
  '--grey',
  '--grey-2',
  '--grey-2-ink',
  '--grey-3',
  '--grey-4',
  '--tint',
  '--hairline-faint',
  '--hatch',
  '--red-ink',
  '--amber-ink',
  '--amber-ink-strong',
  '--green-ink',
  '--blue-ink',
  '--muted-inverse',
  '--ink-soft-inverse',
  '--hairline-inverse',
  '--ease-out-quint',
  '--ease-out-expo',
];

/** The one read of a retired name allowed while packages/ui-legacy lives: global.css's
    `.status-tint` recipe reads `--tint`, which ui-legacy's GroupHeader sets inline (the bridge
    gives it a fallback). TODO 2026-10-26: remove with `.status-tint` in Phase 7. */
const RETIRED_EXEMPT: ReadonlyArray<{ file: string; name: string }> = [
  { file: 'styles/global.css', name: '--tint' },
];

type Source = { file: string; text: string };

/** A file's text without its comments: CSS block comments and TypeScript line comments that
    stand on their own line (a `//` inside a URL string is left alone). */
function uncommented(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every .css, .ts and .tsx file under a directory (none when it does not exist), named
    relative to src/, comments stripped. */
function sources(dir: string): Source[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.(css|tsx?)$/.test(entry.name)) return [];
    return [
      {
        file: path.relative(srcDir, full),
        text: uncommented(readFileSync(full, 'utf8')),
      },
    ];
  });
}

/** The sources of one GR8R_SCOPE entry: the file itself, or every scanned file under the
    directory (none when an absent directory is listed). */
function scopeSources(entry: string): Source[] {
  const full = path.join(srcDir, entry);
  if (!isFileEntry(entry)) return sources(full);
  return [{ file: entry, text: uncommented(readFileSync(full, 'utf8')) }];
}

const code = GR8R_SCOPE.flatMap(scopeSources);
const sheets: Source[] = SHEETS.map((file) => ({
  file: path.relative(srcDir, file),
  text: uncommented(readFileSync(file, 'utf8')),
}));
const all = [...code, ...sheets];

/** "file: match" for every match of a pattern in a set of files. */
function findings(files: Source[], pattern: RegExp): string[] {
  return files.flatMap(({ file, text }) =>
    [...text.matchAll(pattern)].map((match) => `${file}: ${match[0]}`)
  );
}

/** A className's words: the string literals of every `className=` attribute, split on
    whitespace. Covers a quoted attribute and any string literal inside a braced expression
    (`cn(...)`, a ternary, a template). */
function classWords(text: string): string[] {
  const words: string[] = [];
  for (const attr of text.matchAll(
    /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g
  )) {
    const quoted = attr[1] ?? attr[2];
    const literals =
      quoted !== undefined
        ? [quoted]
        : [...(attr[3] ?? '').matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map(
            (literal) => literal[2] ?? ''
          );
    for (const literal of literals)
      words.push(...literal.split(/\s+/).filter(Boolean));
  }
  return words;
}

/** A Tailwind-shaped utility: an optional variant chain, then either a prefixed token
    (`bg-surface`, `hover:text-red`, `px-2`, `size-4`, `items-center`, `min-w-0`, `z-10`,
    `outline-none`) or one of the bare utilities (`flex`, `grid-cols-2`, `truncate`, `hidden`,
    `shrink-0`, `tabular-nums`, `sr-only`, `uppercase`). The same list as the Phase 7 scratch
    scan, made permanent here. */
const TAILWIND_WORD =
  /^(?:[a-z-]+:)*(?:(?:bg|text|border|rounded|shadow|gap|p[xy]?|m[xy]?|w|h|outline|size|min-w|min-h|max-w|max-h|items|justify|font|leading|tracking|ring|fill|stroke|top|left|right|bottom|inset|z|opacity|cursor|overflow|whitespace|line-clamp|animate|duration|ease|space-[xy])-[\w[\]()/.%-]+|flex|grid|flex-[\w-]+|grid-[\w-]+|truncate|hidden|block|inline-flex|relative|absolute|sticky|fixed|shrink-0|grow|uppercase|italic|tabular-nums|sr-only|contents|underline)$/;

/** Every module specifier a TypeScript source names: `from '...'` (imports and re-exports),
    a bare `import '...'`, a dynamic `import('...')`, a `require('...')` and a test's
    `mock.module('...')` (mocking a legacy module is still depending on it). */
function specifiers(text: string): string[] {
  return [
    ...text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bmock\.module\s*\(\s*)(['"])([^'"]+)\1/g
    ),
  ].map((match) => match[2] ?? '');
}

/** True when a specifier reaches code a Gr8r file may not use: the legacy library (through
    the `@/ui` alias or by package name) or the Tailwind class joiner `cn` in src/lib/utils.ts
    (through the alias or a relative path, resolved against the importing file's directory so
    another file named `utils` does not trip it). */
function isBannedImport(file: string, specifier: string): boolean {
  if (specifier.startsWith('@/ui/')) return true;
  if (specifier.startsWith('@dispatch/ui-legacy')) return true;
  const bare = specifier.replace(/\.(?:ts|js)$/, '');
  if (bare === '@/lib/utils') return true;
  if (!bare.startsWith('.')) return false;
  const target = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), bare)
  );
  return target === 'lib/utils';
}

/** "file: specifier" for every banned import in the .ts and .tsx sources. */
function bannedImports(files: Source[]): string[] {
  return files
    .filter(({ file }) => /\.tsx?$/.test(file))
    .flatMap(({ file, text }) =>
      specifiers(text)
        .filter((specifier) => isBannedImport(file, specifier))
        .map((specifier) => `${file}: ${specifier}`)
    );
}

/** Every custom property a CSS text declares (`--x:` on the left of a declaration). */
function declaredIn(text: string): string[] {
  return [...text.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] ?? '');
}

/** The custom properties a source sets for itself, which its own `var()` reads may use: a CSS
    declaration, a quoted style-object key (`'--x': value`) or `setProperty('--x', value)`. */
function selfSet(text: string): Set<string> {
  return new Set([
    ...declaredIn(text),
    ...[...text.matchAll(/['"](--[\w-]+)['"]\s*:/g)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)].map(
      (m) => m[1] ?? ''
    ),
  ]);
}

/** "file: name" for every `var(--name` read that resolves nowhere: not among the declared
    names (tokens.css plus the app stylesheets), not set by the file itself, and not one of the
    runtime `--label-color-<hash>` properties lib/labelColor.ts registers. */
function unresolvedVars(
  files: Source[],
  declared: ReadonlySet<string>
): string[] {
  return files.flatMap(({ file, text }) => {
    const own = selfSet(text);
    const reads = new Set(
      [...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] ?? '')
    );
    return [...reads]
      .filter(
        (name) =>
          !declared.has(name) &&
          !own.has(name) &&
          !name.startsWith('--label-color-')
      )
      .map((name) => `${file}: ${name}`);
  });
}

/** The bridge's generated families, banned as prefixes: a static resolver cannot expand
    `var(--project-color-${n})`, and tokens.css declares none of these names. */
const BRIDGE_PREFIX = /var\(\s*--(?:project-color|state|status)-/g;

/** A custom property whose name starts with a template expression (`var(--${tone}-ink)`):
    neither the resolver nor BRIDGE_PREFIX can see which name it reads, so it is banned. Pick
    the whole name from a typed map instead. */
const DYNAMIC_VAR = /var\(\s*--\$\{/g;

/** Every custom property the scoped code may read without setting it: tokens.css (found
    through the dependency, as the retired-list test below does) and every app stylesheet
    except the bridge and the Tailwind entry, CSS modules included. */
function declaredNames(): Set<string> {
  const tokens = path.join(
    path.dirname(Bun.resolveSync('@dispatch/ui/styles.css', import.meta.dir)),
    'tokens.css'
  );
  const appSheets = sources(srcDir).filter(
    ({ file }) =>
      file.endsWith('.css') &&
      file !== 'styles/legacy-bridge.css' &&
      file !== 'styles/tailwind.css'
  );
  return new Set([
    ...declaredIn(uncommented(readFileSync(tokens, 'utf8'))),
    ...appSheets.flatMap(({ text }) => declaredIn(text)),
  ]);
}

describe('the Gr8r code and the transitional sheets follow the design system', () => {
  test('the sheets and the shell files are found', () => {
    expect(sheets.map(({ file }) => file)).toEqual([
      'styles/legacy-bridge.css',
      'styles/global.css',
    ]);
    expect(code.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        'adapters/shell.ts',
        'components/shell/DispatchShell.tsx',
        'components/shell/DispatchShell.module.css',
        'components/tasks/detail/TaskDrawer.tsx',
        'components/tasks/detail/useTaskDetail.ts',
        'lib/feedState.ts',
        'lib/format.ts',
        'lib/shellRoutes.ts',
        'lib/taskDates.ts',
        'views/IssuesView.tsx',
        'views/IssuesViewTable.tsx',
      ])
    );
  });

  test('every scope directory exists and holds files, except the pending ones', () => {
    const empty = GR8R_SCOPE.filter(
      (entry) =>
        !isFileEntry(entry) &&
        !PENDING_DIRS.has(entry) &&
        scopeSources(entry).length === 0
    );
    expect(empty).toEqual([]);
    expect(
      [...PENDING_DIRS].filter((entry) => !GR8R_SCOPE.includes(entry))
    ).toEqual([]);
  });

  test('no file writes a hex colour of its own', () => {
    expect(findings(all, /#[0-9a-f]{3,8}\b/gi)).toEqual([]);
  });

  test('no file reads or sets a retired token name', () => {
    // The bridge declares the old names on purpose (that is its job), so in the sheets only a
    // READ counts: the left-hand side of every declaration is dropped before the scan. Gr8r
    // code may neither read nor declare one.
    const found = [
      ...code,
      ...sheets.map(({ file, text }) => ({
        file,
        text: text.replace(/^\s*--[\w-]+\s*:/gm, ''),
      })),
    ].flatMap(({ file, text }) =>
      RETIRED.filter((name) =>
        new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text)
      )
        .filter(
          (name) =>
            !RETIRED_EXEMPT.some(
              (exempt) => exempt.file === file && exempt.name === name
            )
        )
        .map((name) => `${file}: ${name}`)
    );
    expect(found).toEqual([]);
  });

  test('no file removes the focus outline', () => {
    expect(findings(all, /outline\s*:\s*['"]?(?:none|0)(?![\w.])/gi)).toEqual(
      []
    );
  });

  test('no file sets uppercase text', () => {
    expect(findings(all, /text-?transform\s*:\s*['"]?uppercase/gi)).toEqual([]);
  });

  test('no Gr8r code carries a Tailwind utility class', () => {
    const found = code
      .filter(({ file }) => /\.tsx?$/.test(file))
      .flatMap(({ file, text }) =>
        classWords(text)
          .filter((word) => TAILWIND_WORD.test(word))
          .map((word) => `${file}: ${word}`)
      );
    expect(found).toEqual([]);
  });

  test('no scoped file imports the legacy library or cn', () => {
    expect(bannedImports(code)).toEqual([]);
  });

  test('every var() read in a scoped file resolves', () => {
    expect(unresolvedVars(code, declaredNames())).toEqual([]);
  });

  test('no scoped file reads a bridge status or project colour family', () => {
    expect(findings(code, BRIDGE_PREFIX)).toEqual([]);
  });

  test('no scoped file builds a custom property name from an expression', () => {
    expect(findings(code, DYNAMIC_VAR)).toEqual([]);
  });

  test('the Tailwind scan catches layout and type utilities, not module classes', () => {
    const flagged = (text: string) =>
      classWords(text).filter((word) => TAILWIND_WORD.test(word));
    expect(
      flagged(
        'const a = <span className="truncate items-center size-4 uppercase sr-only" />;'
      )
    ).toEqual(['truncate', 'items-center', 'size-4', 'uppercase', 'sr-only']);
    expect(
      flagged(
        "const a = <div className={cx(styles.row, open && 'is-open')} />;"
      )
    ).toEqual([]);
  });

  test('the import ban catches the legacy alias and cn, not the library', () => {
    const fixture = (text: string): Source[] => [
      { file: 'views/Fixture.tsx', text },
    ];
    expect(
      bannedImports(fixture("import { Button } from '@/ui/button';"))
    ).toEqual(['views/Fixture.tsx: @/ui/button']);
    expect(bannedImports(fixture("import { cn } from '@/lib/utils';"))).toEqual(
      ['views/Fixture.tsx: @/lib/utils']
    );
    expect(bannedImports(fixture("import('../lib/utils');"))).toEqual([
      'views/Fixture.tsx: ../lib/utils',
    ]);
    expect(
      bannedImports(fixture("import { cn } from '@/lib/utils.ts';"))
    ).toEqual(['views/Fixture.tsx: @/lib/utils.ts']);
    expect(
      bannedImports(
        fixture(
          "void mock.module('@/ui/button', () => ({}));\nrequire('@/ui/kbd');"
        )
      )
    ).toEqual([
      'views/Fixture.tsx: @/ui/button',
      'views/Fixture.tsx: @/ui/kbd',
    ]);
    expect(bannedImports(fixture("import './utils';"))).toEqual([]);
    expect(
      bannedImports(fixture("import { cx } from '@dispatch/ui';"))
    ).toEqual([]);
  });

  test('the resolver passes tokens and self-set names, and fails a bridge name', () => {
    const declared = new Set(['--accent']);
    const fixture = (text: string): Source[] => [
      { file: 'views/Fixture.module.css', text },
    ];
    expect(
      unresolvedVars(fixture('.a { color: var(--accent); }'), declared)
    ).toEqual([]);
    expect(
      unresolvedVars(fixture('.a { --x: 1px; width: var(--x); }'), declared)
    ).toEqual([]);
    expect(
      unresolvedVars(
        [
          {
            file: 'views/Fixture.tsx',
            text: "const style = { '--x': '1px', width: 'var(--x)' };",
          },
        ],
        declared
      )
    ).toEqual([]);
    expect(
      unresolvedVars(
        fixture('.a { background: var(--surface-panel); }'),
        declared
      )
    ).toEqual(['views/Fixture.module.css: --surface-panel']);
  });

  test('the prefix ban fails a generated project colour', () => {
    const files: Source[] = [
      {
        file: 'views/Fixture.tsx',
        text: 'const color = (n: number) => `var(--project-color-${n})`;',
      },
    ];
    expect(findings(files, BRIDGE_PREFIX)).toEqual([
      'views/Fixture.tsx: var(--project-color-',
    ]);
  });

  test('the expression ban fails a name built from a template', () => {
    const files: Source[] = [
      {
        file: 'views/Fixture.tsx',
        text: 'const ink = (tone: string) => `var(--${tone}-ink)`;',
      },
    ];
    expect(findings(files, DYNAMIC_VAR)).toEqual([
      'views/Fixture.tsx: var(--${',
    ]);
    expect(
      findings(
        [
          {
            file: 'views/Fixture.tsx',
            text: "const ink = 'var(--accent-ink)';",
          },
        ],
        DYNAMIC_VAR
      )
    ).toEqual([]);
  });

  test('the retired list is the one packages/ui tests with', () => {
    // Through the dependency, not a relative path: @dispatch/ui/styles.css is
    // packages/ui/src/styles/index.css, and the helpers sit in that package's test/.
    const uiRoot = path.join(
      path.dirname(Bun.resolveSync('@dispatch/ui/styles.css', import.meta.dir)),
      '..',
      '..'
    );
    const helpers = readFileSync(
      path.join(uiRoot, 'test', 'contrast-helpers.ts'),
      'utf8'
    );
    const start = helpers.indexOf('export const RETIRED = [');
    const end = helpers.indexOf('] as const', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const theirs = [...helpers.slice(start, end).matchAll(/'(--[\w-]+)'/g)].map(
      (match) => match[1]
    );
    expect(RETIRED).toEqual(theirs);
  });
});
