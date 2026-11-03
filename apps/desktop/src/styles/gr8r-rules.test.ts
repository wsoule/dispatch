// cspell:ignore xytblrse -- Tailwind's padding and margin side letters in a regex class below
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Every source under apps/desktop/src (.css, .ts, .tsx, tests included) follows the design
// system's rules (packages/ui/README.md): no colour of its own (a hex literal lives only in
// packages/ui/src/styles/tokens.css), none of the retired pre-Gr8r token names, no removed
// focus outline (Gr8r's `:focus-visible` ring is the focus indicator), no uppercase (the
// `.eyebrow` class is the one uppercase voice), no Tailwind utility in a className (the app is
// styled by CSS modules; Tailwind left with packages/ui-legacy in Phase 7 B16) and no rule
// that styles every element's ::before or ::after (checked in the library's sheets too, since
// they load on the same page). The planner had the same scan
// (apps/planner/test/gr8r-tokens.test.ts in Better-Tracker). Every file also keeps the Phase 7
// ratchet: it imports neither the legacy library, `cn`, nor a retired styling package
// (clsx, cmdk, Base UI, cva, tailwind-merge, react-virtual, Tailwind); every `var(--name)` it
// reads resolves to tokens.css, an app stylesheet, or a property the file sets itself; and it
// never builds a name from the old bridge's `--project-color-`, `--state-` or `--status-`
// families, nor any name from a template expression (`var(--${tone}-ink)`), which no static
// scan can resolve.
//
// Exemptions, each named below: this file (its fixtures spell out what the checks catch), the
// hex fixtures of Linear-supplied colours in three tests and the xterm fixtures in two
// terminal tests (HEX_FIXTURE_EXEMPT), the xterm palette in lib/terminalPalette.ts, which
// must hand xterm literal colours (TERMINAL_HEX_EXEMPT), and the library reset's box-sizing
// rule for every ::before and ::after (LIBRARY_UNIVERSAL_EXEMPT). Comments are stripped before
// every check; a TypeScript source is parsed for that, so a glob string never hides code.

const srcDir = path.join(import.meta.dir, '..');

/** This file, named relative to src/. It is left out of every scan: its fixtures trip the
    Tailwind, import, resolver, prefix and expression checks on purpose. */
const SELF = 'styles/gr8r-rules.test.ts';

/** Test files whose hex literals are data, not colours of their own: a Linear workflow
    state's or label's configured `color` fed in as a fixture, which the code under test must
    carry through (the label registry, a swatch mark) or ignore (statusTone), and the xterm
    colours the terminal palette and screen tests assert. Only a test file may be listed;
    every other check still applies to it. */
const HEX_FIXTURE_EXEMPT: ReadonlySet<string> = new Set([
  'components/tasks/TaskCardTile.test.tsx',
  'lib/labelColor.test.ts',
  'lib/statusTone.test.ts',
  'lib/terminalPalette.test.ts',
  'lib/terminalScreen.test.ts',
]);

/** Source files that may write hex colours: xterm draws on a canvas and takes literal colours,
    not custom properties, so its palette is the one place the app spells them out. */
const TERMINAL_HEX_EXEMPT: ReadonlySet<string> = new Set([
  'lib/terminalPalette.ts',
]);

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

type Source = { file: string; text: string };

/** The syntax kinds whose text is data, not code: string, template and regular expression
    literals, and JSX text. A `/*` or `//` inside one is not a comment. */
const LITERAL_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
]);

/** The [start, end) offsets of every literal (LITERAL_KINDS) in a TypeScript source, in order,
    found by parsing it: a regular expression cannot tell a glob string such as 'src/**' or
    'image/*' from the start of a block comment. */
function literalSpans(file: string, text: string): Array<[number, number]> {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const spans: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (!LITERAL_KINDS.has(node.kind)) {
      ts.forEachChild(node, visit);
      return;
    }
    // JSX text has no leading trivia: its text starts at `pos`. Every other literal starts after
    // the comments and whitespace before it, which belong to the code around it.
    const start =
      node.kind === ts.SyntaxKind.JsxText ? node.pos : node.getStart(source);
    spans.push([start, node.end]);
  };
  visit(source);
  return spans.sort((a, b) => a[0] - b[0]);
}

/** Code with its block and line comments blanked to spaces (line breaks kept). */
function blankComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) =>
    comment.replace(/[^\n]/g, ' ')
  );
}

/** A file's text without its comments, so a check reads only what the code does. A stylesheet
    loses its block comments. A TypeScript source loses its block and line comments outside its
    literals (literalSpans), so a `/*` or `//` inside a string stays and hides nothing after it. */
function uncommented(file: string, text: string): string {
  if (file.endsWith('.css')) return text.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let at = 0;
  for (const [start, end] of literalSpans(file, text)) {
    out += blankComments(text.slice(at, start)) + text.slice(start, end);
    at = end;
  }
  return out + blankComments(text.slice(at));
}

/** Every .css, .ts and .tsx file under a directory (none when it does not exist), named
    relative to src/, comments stripped. */
function sources(dir: string): Source[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.(css|tsx?)$/.test(entry.name)) return [];
    const file = path.relative(srcDir, full);
    return [{ file, text: uncommented(file, readFileSync(full, 'utf8')) }];
  });
}

/** Every scanned source in src/ except this file. */
const code = sources(srcDir).filter(({ file }) => file !== SELF);

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

/** A Tailwind variant chain before a utility: `hover:`, `md:`, `dark:`, a container query
    (`@min-[400px]:`), a named group (`group-hover/item:`), a data or arbitrary variant
    (`data-[state=open]:`, `[&>svg]:`), any number of them. */
const TAILWIND_VARIANTS = String.raw`(?:(?:@?[\w-]+(?:\[[^\]]*\])?|\[[^\]]*\])(?:/[\w-]+)?:)*`;

/** Tailwind utilities that take a value after a dash (`bg-surface`, `px-2`, `pl-2`, `-mt-1`,
    `ms-2`, `size-4`, `min-w-0`, `col-span-2`, `select-none`, `transition-colors`). */
const TAILWIND_PREFIXES = [
  'bg',
  'text',
  'border',
  'rounded',
  'shadow',
  'gap(?:-[xy])?',
  'p[xytblrse]?',
  'm[xytblrse]?',
  'w',
  'h',
  'size',
  'min-w',
  'min-h',
  'max-w',
  'max-h',
  'items',
  'justify',
  'self',
  'place-(?:items|content|self)',
  'content',
  'font',
  'leading',
  'tracking',
  'ring',
  'fill',
  'stroke',
  'top',
  'left',
  'right',
  'bottom',
  'inset(?:-[xy])?',
  'z',
  'opacity',
  'cursor',
  'overflow(?:-[xy])?',
  'whitespace',
  'line-clamp',
  'animate',
  'duration',
  'delay',
  'ease',
  'transition',
  'space-[xy]',
  'select',
  'pointer-events',
  'col-(?:span|start|end)',
  'row-(?:span|start|end)',
  'order',
  'basis',
  'aspect',
  'translate-[xy]',
  'scale(?:-[xy])?',
  'rotate',
  'origin',
  'divide(?:-[xy])?',
  'decoration',
  'underline-offset',
  'outline',
  'break',
  'flex',
  'grid',
  'shrink',
  'grow',
].join('|');

/** Tailwind utilities that stand alone (`flex`, `truncate`, `inline-block`, `sr-only`). */
const TAILWIND_BARE = [
  'flex',
  'grid',
  'truncate',
  'hidden',
  'block',
  'inline',
  'inline-block',
  'inline-flex',
  'inline-grid',
  'table',
  'contents',
  'relative',
  'absolute',
  'sticky',
  'fixed',
  'static',
  'isolate',
  'invisible',
  'visible',
  'shrink',
  'grow',
  'uppercase',
  'lowercase',
  'capitalize',
  'normal-case',
  'italic',
  'not-italic',
  'underline',
  'no-underline',
  'line-through',
  'tabular-nums',
  'antialiased',
  'sr-only',
  'not-sr-only',
  'transition',
  'transform',
  'container',
  'border',
  'rounded',
  'shadow',
  'outline',
  'ring',
  'invert',
  'grayscale',
].join('|');

/** A Tailwind-shaped className word: any word that opens with the `dark:` variant or a
    container query (`@container/main`, `@min-[400px]:flex`), or an optional variant chain, an
    optional negative sign, then a prefixed or bare utility. A className check, never a raw text
    ban: Shiki's `{ dark: 'github-dark' }` theme key must pass. The Phase 7 entry gates' scan,
    made permanent here. */
const TAILWIND_WORD = new RegExp(
  String.raw`^(?:dark:|@container|@(?:min|max)-)|^${TAILWIND_VARIANTS}-?(?:(?:${TAILWIND_PREFIXES})-[\w[\]()/.%#,:-]+|${TAILWIND_BARE})$`
);

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

/** The retired styling packages, banned by exact name or any subpath (`clsx/lite`,
    `tailwindcss/preflight.css`): the class joiners, the old command menu and primitives, the
    list virtualizer the board dropped, and Tailwind with its plugins. */
const RETIRED_PACKAGES: readonly string[] = [
  'clsx',
  'cmdk',
  'class-variance-authority',
  'tailwind-merge',
  '@tanstack/react-virtual',
  'tailwindcss',
  'tw-animate-css',
];

/** Package scopes banned whole: every package under them is retired. */
const RETIRED_SCOPES: readonly string[] = ['@base-ui/', '@tailwindcss/'];

/** True when a specifier reaches code the app may no longer use: the legacy library (through
    the `@/ui` alias or by package name), a retired styling package (RETIRED_PACKAGES,
    RETIRED_SCOPES) or the Tailwind class joiner `cn` in src/lib/utils.ts (through the alias or
    a relative path, resolved against the importing file's directory so another file named
    `utils` does not trip it). */
function isBannedImport(file: string, specifier: string): boolean {
  if (specifier.startsWith('@/ui/')) return true;
  if (specifier.startsWith('@dispatch/ui-legacy')) return true;
  if (
    RETIRED_PACKAGES.some(
      (name) => specifier === name || specifier.startsWith(`${name}/`)
    )
  )
    return true;
  if (RETIRED_SCOPES.some((scope) => specifier.startsWith(scope))) return true;
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
    names (tokens.css plus the app stylesheets) and not set by the file itself. */
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
      .filter((name) => !declared.has(name) && !own.has(name))
      .map((name) => `${file}: ${name}`);
  });
}

/** The retired bridge's generated families, banned as prefixes: a static resolver cannot expand
    `var(--project-color-${n})`, and tokens.css declares none of these names. */
const BRIDGE_PREFIX = /var\(\s*--(?:project-color|state|status)-/g;

/** A custom property whose name starts with a template expression (`var(--${tone}-ink)`):
    neither the resolver nor BRIDGE_PREFIX can see which name it reads, so it is banned. Pick
    the whole name from a typed map instead. */
const DYNAMIC_VAR = /var\(\s*--\$\{/g;

/** packages/ui/src/styles, found through the dependency (`@dispatch/ui/styles.css` is its
    index.css) rather than a relative path out of this app. */
const uiStylesDir = path.dirname(
  Bun.resolveSync('@dispatch/ui/styles.css', import.meta.dir)
);

/** Every custom property the app may read without setting it: tokens.css and every app
    stylesheet, CSS modules included. */
function declaredNames(): Set<string> {
  const tokens = path.join(uiStylesDir, 'tokens.css');
  const appSheets = code.filter(({ file }) => file.endsWith('.css'));
  return new Set([
    ...declaredIn(uncommented(tokens, readFileSync(tokens, 'utf8'))),
    ...appSheets.flatMap(({ text }) => declaredIn(text)),
  ]);
}

/** Every stylesheet under packages/ui/src, named relative to it, comments stripped: the
    library's sheets load on the desktop's page before the app's own. */
function librarySheets(): Source[] {
  const root = path.join(uiStylesDir, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.css') ? [full] : [];
    });
  return walk(root).map((full) => {
    const file = path.relative(root, full);
    return { file, text: uncommented(file, readFileSync(full, 'utf8')) };
  });
}

/** A CSS text reduced to its rules: comments out, every run of whitespace one space and none
    beside a brace, comma or semicolon, one quote style. A space between selectors is a
    descendant combinator, so it stays (`.board *::before` must not read as `.board*::before`). */
function normalizeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{},;])\s*/g, '$1')
    .replaceAll('"', "'")
    .trim();
}

/** One selector of a list that reaches every element's ::before or ::after, or every
    descendant's or child's: a bare `::after`, `*::before`, `.board *::before`, `.list > *::after`.
    WebKit then creates both pseudo-elements for each element it matches, about a third of what
    mounting a board card or a list row costs there (measured when the preflight was vendored). A
    pseudo-element on a class or element (`.row::before`, `:where(.row)::after`) passes. */
const UNIVERSAL_PSEUDO = /(?:^|[\s;>+~])\*?::?(?:before|after)$/;

/** Every innermost rule (an @media block's rules, not the block) whose selector list has a
    UNIVERSAL_PSEUDO selector, as its selector and its declarations, both normalized. */
function universalPseudoRules(
  css: string
): Array<{ selector: string; body: string }> {
  return [...normalizeCss(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((rule) => ({ selector: rule[1] ?? '', body: rule[2] ?? '' }))
    .filter(({ selector }) =>
      selector.split(',').some((part) => UNIVERSAL_PSEUDO.test(part.trim()))
    );
}

/** The one library rule that reaches every element's ::before and ::after: the page-mode
    reset's `box-sizing: border-box` in tokens.css, there since the library landed. It is the
    library's to narrow (a pseudo-element that draws a box can set its own box-sizing); it is
    recorded here so that a second universal rule, in the library or the app, fails. */
const LIBRARY_UNIVERSAL_EXEMPT = {
  file: 'styles/tokens.css',
  body: 'box-sizing: border-box;',
};

describe('every desktop source follows the design system', () => {
  test('every source is found, and this file and the deleted sheets are not', () => {
    const files = code.map(({ file }) => file);
    expect(files).toEqual(
      expect.arrayContaining([
        'App.tsx',
        'main.tsx',
        'styles/global.css',
        'styles/markdown.css',
        'styles/pierreTheme.css',
        'lib/terminalPalette.ts',
        'components/shell/DispatchShell.tsx',
      ])
    );
    for (const absent of [
      SELF,
      'styles/legacy-bridge.css',
      'styles/tailwind.css',
      'styles/preflight.css',
    ])
      expect(files).not.toContain(absent);
  });

  test('no file writes a hex colour of its own', () => {
    expect(
      findings(
        code.filter(
          ({ file }) =>
            !HEX_FIXTURE_EXEMPT.has(file) && !TERMINAL_HEX_EXEMPT.has(file)
        ),
        /#[0-9a-f]{3,8}\b/gi
      )
    ).toEqual([]);
  });

  test('every hex exemption exists, and every fixture exemption is a test', () => {
    const exempt = [...HEX_FIXTURE_EXEMPT, ...TERMINAL_HEX_EXEMPT];
    expect(
      exempt.filter((file) => !existsSync(path.join(srcDir, file)))
    ).toEqual([]);
    expect(
      [...HEX_FIXTURE_EXEMPT].filter((file) => !/\.test\.tsx?$/.test(file))
    ).toEqual([]);
  });

  test('no file reads or sets a retired token name', () => {
    const found = code.flatMap(({ file, text }) =>
      RETIRED.filter((name) =>
        new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text)
      ).map((name) => `${file}: ${name}`)
    );
    expect(found).toEqual([]);
  });

  test('no file removes the focus outline', () => {
    expect(findings(code, /outline\s*:\s*['"]?(?:none|0)(?![\w.])/gi)).toEqual(
      []
    );
  });

  test('no file sets uppercase text', () => {
    expect(findings(code, /text-?transform\s*:\s*['"]?uppercase/gi)).toEqual(
      []
    );
  });

  test('no file carries a Tailwind utility class', () => {
    const found = code
      .filter(({ file }) => /\.tsx?$/.test(file))
      .flatMap(({ file, text }) =>
        classWords(text)
          .filter((word) => TAILWIND_WORD.test(word))
          .map((word) => `${file}: ${word}`)
      );
    expect(found).toEqual([]);
  });

  test('no file imports the legacy library, cn or a retired styling package', () => {
    expect(bannedImports(code)).toEqual([]);
  });

  test('every var() read resolves', () => {
    expect(unresolvedVars(code, declaredNames())).toEqual([]);
  });

  test('no file reads a bridge status or project colour family', () => {
    expect(findings(code, BRIDGE_PREFIX)).toEqual([]);
  });

  test('no file builds a custom property name from an expression', () => {
    expect(findings(code, DYNAMIC_VAR)).toEqual([]);
  });

  test('no stylesheet styles every element’s ::before or ::after', () => {
    const sheets = code.filter(({ file }) => file.endsWith('.css'));
    expect(sheets.map(({ file }) => file)).toContain('styles/global.css');
    expect(
      sheets.flatMap(({ file, text }) =>
        universalPseudoRules(text).map(({ selector }) => `${file}: ${selector}`)
      )
    ).toEqual([]);
  });

  test('the library’s sheets carry only the recorded universal ::before/::after rule', () => {
    const library = librarySheets();
    expect(library.map(({ file }) => file)).toContain('styles/tokens.css');
    expect(
      library.flatMap(({ file, text }) =>
        universalPseudoRules(text).map(({ body }) => ({ file, body }))
      )
    ).toEqual([LIBRARY_UNIVERSAL_EXEMPT]);
  });

  test('the pseudo-element scan catches a universal or descendant rule, not a scoped one', () => {
    const universal = (css: string) => universalPseudoRules(css).length > 0;
    expect(universal('*, ::before, ::after { box-sizing: border-box; }')).toBe(
      true
    );
    expect(universal('.a {}\n*::after { content: ""; }')).toBe(true);
    expect(universal('.board *::before { content: ""; }')).toBe(true);
    expect(universal(':where(html) *::after {}')).toBe(true);
    expect(universal('.list > *::after {}')).toBe(true);
    expect(universal('@media (hover: hover) {\n  .list ::before {}\n}')).toBe(
      true
    );
    expect(universal('/* *::before { } */ .a::before { content: ""; }')).toBe(
      false
    );
    expect(universal('.row:hover::after, .row::before { opacity: 1; }')).toBe(
      false
    );
    expect(universal(':where(.row)::before {}')).toBe(false);
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
        'const a = <span className="pl-2 pr-3 pt-2 pb-1 mt-1 mb-4 ms-2 -mt-1" />;'
      )
    ).toEqual([
      'pl-2',
      'pr-3',
      'pt-2',
      'pb-1',
      'mt-1',
      'mb-4',
      'ms-2',
      '-mt-1',
    ]);
    expect(
      flagged(
        'const a = <span className="inline-block select-none pointer-events-none transition-colors self-center col-span-2" />;'
      )
    ).toEqual([
      'inline-block',
      'select-none',
      'pointer-events-none',
      'transition-colors',
      'self-center',
      'col-span-2',
    ]);
    expect(
      flagged(
        'const a = <div className="dark:bg-red-500 dark:invert @container/main @min-[400px]:flex group-hover/item:flex data-[state=open]:bg-accent" />;'
      )
    ).toEqual([
      'dark:bg-red-500',
      'dark:invert',
      '@container/main',
      '@min-[400px]:flex',
      'group-hover/item:flex',
      'data-[state=open]:bg-accent',
    ]);
    expect(
      flagged(
        "const a = <div className={cx(styles.row, open && 'is-open')} />;"
      )
    ).toEqual([]);
    expect(
      flagged(
        'const a = <div className="dispatch-md dispatch-md-prose num mono toneText srOnly input select textarea pele prose row" />;'
      )
    ).toEqual([]);
    expect(flagged("const themes = { dark: 'github-dark' };")).toEqual([]);
  });

  test('a comment opener inside a string hides no code from the scans', () => {
    const text = [
      "const writes = 'src/**';",
      'const a = <div className="flex" />;',
      'const b = 1; // */ a trailing comment',
      '/* #ffffff */',
    ].join('\n');
    const stripped = uncommented('views/Fixture.tsx', text);
    expect(
      classWords(stripped).filter((word) => TAILWIND_WORD.test(word))
    ).toEqual(['flex']);
    expect(stripped).toContain("'src/**'");
    expect(stripped).not.toContain('trailing');
    expect(stripped).not.toContain('#ffffff');
    expect(uncommented('views/Fixture.module.css', '.a { /* x */ }')).toBe(
      '.a {  }'
    );
  });

  test('the import ban catches the legacy alias, cn and retired packages, not the library', () => {
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
    expect(
      bannedImports(
        fixture(
          [
            "import clsx from 'clsx';",
            "import { clsx as lite } from 'clsx/lite';",
            "import { Command } from 'cmdk';",
            "import { Menu } from '@base-ui/react/menu';",
            "import { cva } from 'class-variance-authority';",
            "import { twMerge } from 'tailwind-merge';",
            "import { useVirtualizer } from '@tanstack/react-virtual';",
            "import 'tailwindcss';",
            "import tailwind from '@tailwindcss/vite';",
            "import 'tw-animate-css';",
          ].join('\n')
        )
      )
    ).toEqual([
      'views/Fixture.tsx: clsx',
      'views/Fixture.tsx: clsx/lite',
      'views/Fixture.tsx: cmdk',
      'views/Fixture.tsx: @base-ui/react/menu',
      'views/Fixture.tsx: class-variance-authority',
      'views/Fixture.tsx: tailwind-merge',
      'views/Fixture.tsx: @tanstack/react-virtual',
      'views/Fixture.tsx: tailwindcss',
      'views/Fixture.tsx: @tailwindcss/vite',
      'views/Fixture.tsx: tw-animate-css',
    ]);
    expect(
      bannedImports(
        fixture(
          "import { useQuery } from '@tanstack/react-query';\nimport x from 'clsx-like';"
        )
      )
    ).toEqual([]);
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
