import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The package's global sheets (tokens.css, primitives.css) must be scopable:
// with data-bt-ui-scoped on <html> they may only reach inside [data-bt-ui]
// wrappers, so an embedding host (Dispatch: Tailwind, its own --accent,
// --border, --muted, a .block utility) keeps its own UI. Every selector
// therefore starts from one of the scope forms below; a bare `button` or
// `.pageBlock` added later would leak into the host and fails here.

const SCOPE = ':where(html:not([data-bt-ui-scoped]), [data-bt-ui])';
const ALLOWED_PREFIXES = [
  // descendants of the unscoped page or of a wrapper (and the scope roots)
  SCOPE,
  // the page itself, only when unscoped
  'html:where(:not([data-bt-ui-scoped]))',
  ':where(html:not([data-bt-ui-scoped])) body',
  ':root:where(:not([data-bt-ui-scoped]))',
  "html[data-theme='dark']:where(:not([data-bt-ui-scoped]))",
  "html[data-theme='system']:where(:not([data-bt-ui-scoped]))",
  // a wrapper's own tokens and paper
  '[data-bt-ui]',
  ':where([data-bt-ui])',
  "[data-theme='dark'] [data-bt-ui]",
  "[data-theme='system'] [data-bt-ui]",
];

/** Every selector of every style rule in `css` (comments and at-rule
    preludes skipped; rules nested in @media are included). */
function selectorsOf(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const match of text.matchAll(/([^{};]+)\{/g)) {
    const prelude = (match[1] ?? '').trim();
    if (prelude === '' || prelude.startsWith('@')) continue;
    for (const part of splitTopLevel(prelude)) out.push(part);
  }
  return out;
}

/** Splits a selector list on commas outside parentheses. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.map((p) => p.replace(/\s+/g, ' '));
}

const stylesDir = path.join(import.meta.dir, '..', 'src', 'styles');

describe('global stylesheets are scopable', () => {
  for (const file of ['tokens.css', 'primitives.css']) {
    test(`${file}: every selector starts from a scope form`, () => {
      const selectors = selectorsOf(
        readFileSync(path.join(stylesDir, file), 'utf8')
      );
      expect(selectors.length).toBeGreaterThan(10);
      const leaking = selectors.filter(
        (s) => !ALLOWED_PREFIXES.some((prefix) => s.startsWith(prefix))
      );
      expect(leaking).toEqual([]);
    });
  }

  // The page section column is `.pageBlock`: a host that still loads
  // Tailwind puts its `block` utility (display: block) on its own elements,
  // and a global `.block` rule would give every one of them this column.
  test('the page section class is .pageBlock, and no rule styles .block', () => {
    const selectors = selectorsOf(
      readFileSync(path.join(stylesDir, 'tokens.css'), 'utf8')
    );
    expect(selectors.some((s) => s.endsWith(' .pageBlock'))).toBe(true);
    expect(selectors.filter((s) => /\.block(?![\w-])/.test(s))).toEqual([]);
  });

  test('index.css only imports the two scoped sheets', () => {
    const index = readFileSync(path.join(stylesDir, 'index.css'), 'utf8');
    expect(selectorsOf(index)).toEqual([]);
    const imports = [...index.matchAll(/@import\s+'([^']+)'/g)].map(
      (m) => m[1]
    );
    expect(imports).toEqual(['./tokens.css', './primitives.css']);
  });

  test('data-theme="system" uses exactly the dark tokens', () => {
    const tokens = readFileSync(path.join(stylesDir, 'tokens.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ');
    // The declarations of the rule whose selector list starts with `head`.
    const declarations = (head: string): string[] => {
      const at = tokens.indexOf(head);
      expect(at).toBeGreaterThanOrEqual(0);
      const open = tokens.indexOf('{', at);
      const body = tokens.slice(open + 1, tokens.indexOf('}', open));
      return body
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean);
    };
    const dark = declarations("html[data-theme='dark']");
    expect(dark.length).toBeGreaterThan(10);
    expect(declarations("html[data-theme='system']")).toEqual(dark);
    expect(tokens).toContain(
      "@media (prefers-color-scheme: dark) { html[data-theme='system']"
    );
  });

  test('the font stacks survive a host without next/font', () => {
    const tokens = readFileSync(path.join(stylesDir, 'tokens.css'), 'utf8');
    // var() with no fallback on an undefined property invalidates the
    // whole declaration: the browser default serif would be used.
    expect(tokens).toContain('var(--font-geist, Geist)');
    expect(tokens).toContain("var(--font-geist-mono, 'Geist Mono')");
    expect(tokens).not.toMatch(/var\(--font-(geist|geist-mono)\)/);
  });
});

// Component stylesheets are CSS modules: every selector must start from
// one of the module's own (hashed) classes, so nothing reaches a host's
// elements. A `:global(...)` context is allowed only in front of a local
// class (the bulk bar lifts itself above the shell's tab bar that way).
describe('the issue list modules are scoped', () => {
  const modules = [
    'tasks/view-toolbar.module.css',
    'tasks/filter-chips.module.css',
    'tasks/bulk-bar.module.css',
    'tasks/task-group-table.module.css',
    'tasks/checkbox.module.css',
    'edit/picker-popover.module.css',
  ];
  const keyframeStop = /^(from|to|\d+(\.\d+)?%)$/;
  for (const file of modules) {
    test(`${file}: every selector starts from a local class`, () => {
      const css = readFileSync(
        path.join(import.meta.dir, '..', 'src', file),
        'utf8'
      );
      const selectors = selectorsOf(css).filter((s) => !keyframeStop.test(s));
      expect(selectors.length).toBeGreaterThan(3);
      const leaking = selectors.filter((selector) => {
        const local = selector.replace(/:global\((?:[^()]|\([^()]*\))*\)/g, '');
        return !local.trim().startsWith('.');
      });
      expect(leaking).toEqual([]);
    });
  }
});
