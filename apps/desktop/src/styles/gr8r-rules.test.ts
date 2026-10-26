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
// scan (apps/planner/test/gr8r-tokens.test.ts in Better-Tracker).

const srcDir = path.join(import.meta.dir, '..');

/** The directories of Dispatch's own Gr8r code. Either may not exist yet: an absent one scans
    as empty, so this passes before the first shell file lands. */
const GR8R_DIRS = ['shell', 'adapters'].map((name) => path.join(srcDir, name));

/** Gr8r files that sit in directories the legacy views share (components/shell holds the
    Tailwind-styled palette and dialogs too, lib/ the reducers), listed one by one. */
const GR8R_FILES = [
  'components/peek/PeekSlideOver.tsx',
  'components/peek/PeekSlideOver.module.css',
  'components/peek/PeekSlideOver.test.tsx',
  'components/peek/PersonPeek.tsx',
  'components/peek/OutsidePeek.tsx',
  'components/shell/DispatchShell.tsx',
  'components/shell/DispatchShell.module.css',
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
  'hooks/usePlanning.ts',
  'lib/shellRoutes.ts',
  'lib/fanoutVerbs.ts',
  'lib/issueSearch.ts',
  'views/IssuesView.tsx',
  'views/IssuesView.module.css',
  'views/IssuesViewMenus.tsx',
  'views/IssuesViewTable.tsx',
  'views/TimelineView.tsx',
  'views/TimelineView.module.css',
  'views/TimelineView.test.tsx',
].map((name) => path.join(srcDir, name));

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

const code = [
  ...GR8R_DIRS.flatMap(sources),
  ...GR8R_FILES.map((file) => ({
    file: path.relative(srcDir, file),
    text: uncommented(readFileSync(file, 'utf8')),
  })),
];
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

/** A Tailwind-shaped utility: an optional variant chain, then one of the common prefixes and a
    token (`bg-surface`, `hover:text-red`, `px-2`, `flex`, `grid-cols-2`, `outline-none`). */
const TAILWIND_WORD =
  /^(?:[a-z-]+:)*(?:(?:bg|text|border|rounded|shadow|gap|p[xy]?|m[xy]?|w|h|outline)-[\w[\]()/.%-]+|flex|grid|flex-[\w-]+|grid-[\w-]+)$/;

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
        'lib/shellRoutes.ts',
        'views/IssuesView.tsx',
        'views/IssuesViewTable.tsx',
      ])
    );
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
